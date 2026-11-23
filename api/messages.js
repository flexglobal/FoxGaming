'use strict';
/* Mono temporary delivery relay v3. No message database and no durable chat history.
   Envelopes live in Redis for at most 300 seconds, or until acknowledged. */
const {SHOP_ITEMS}=require('../lib/shop');
const {randomUUID,createHash} = require('node:crypto');
const banLib = require('../lib/ban');
const deny = (req,res) => res.status(403).json(req.monoBan ? banLib.payload(req.monoBan) : {error:'Wrong installation key'});
const ID = /^MONO-[A-F0-9]{20}$/;
const MESSAGE_ID = /^[a-zA-Z0-9_-]{10,80}$/;
const ALLOWED = new Set(['text','hello','group-text','group-invite','group-joined','blob','blob-chunk','receipt','friend-request','friend-response','game','watch']);
const TTL = 600;
const AUTH_TTL = 86400;
const MAX_BODY = 260000;
/* Анти-флуд (обычный человек не упрётся): до 900 сообщений в минуту с одного Mono ID,
   до 600 ждущих доставки сообщений у одного получателя. Всё проверяется ОДНИМ Lua-запросом вместе с записью. */
const SEND_PER_MIN = 900, QUEUE_MAX = 600, CHUNK_QUEUE_MAX = 48;
const {reserved:reservedNick}=require('../lib/nick');
const LUA_SEND = `
local n=redis.call('INCR',KEYS[3]); if n==1 then redis.call('EXPIRE',KEYS[3],60) end
if n>tonumber(ARGV[5]) then return 'rate' end
local q=redis.call('ZCARD',KEYS[2])
if q>=tonumber(ARGV[6]) or (ARGV[7]=='1' and q>=tonumber(ARGV[8])) then return 'busy' end
if redis.call('HSETNX',KEYS[1],ARGV[1],ARGV[2])==0 then return 'dup' end
redis.call('ZADD',KEYS[2],tonumber(ARGV[3]),ARGV[1])
redis.call('EXPIRE',KEYS[1],tonumber(ARGV[4]))
redis.call('EXPIRE',KEYS[2],tonumber(ARGV[4]))
return 'ok'`;
const HEADERS = {
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type,X-Mono-Token',
  'Cache-Control':'no-store, max-age=0',
  'Content-Type':'application/json; charset=utf-8',
  'X-Content-Type-Options':'nosniff'
};
function url(){return (process.env.UPSTASH_REDIS_REST_URL||'').replace(/\/$/,'')}
function credential(){return process.env.UPSTASH_REDIS_REST_TOKEN||''}
async function call(endpoint,body){
  if(!url()||!credential())throw Error('Redis is not configured');
  const c = new AbortController(), timer = setTimeout(()=>c.abort(),8500);
  try {
    const r=await fetch(url()+endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+credential()},body:JSON.stringify(body),signal:c.signal});
    if(!r.ok)throw Error('Redis HTTP '+r.status);
    const result=await r.json();
    if(result?.error || (Array.isArray(result)&&result.some(row=>row?.error)))throw Error('Redis command failed');
    return result;
  }finally{clearTimeout(timer)}
}
async function cmd(...args){return (await call('',args)).result}
async function batch(commands){return (await call('/pipeline',commands)).map(x=>x.result)}
const idx=id=>'mono:r3:'+id+':order';
const dataKey=id=>'mono:r3:'+id+':items';
function asString(v){return typeof v==='string'?v.trim().toUpperCase():''}
function response(res,code,value){return res.status(code).json(value)}
async function authorized(req,id){
  const token=req.headers?.['x-mono-token'];
  if(typeof token!=='string'||token.length<24||token.length>256)return false;
  const digest=createHash('sha256').update(token).digest('hex');
  const key='mono:r3:auth:'+id;
  const old=await cmd('GET',key);
  if(old)return old===digest;
  // Ключ сессии истёк (24 ч без Mono). Если ID уже закреплён за другой установкой, перехватить его нельзя.
  let owner=await cmd('GET','mono:acct:v1:owner:'+id)||await cmd('GET','mono:chess:v1:owner:'+id);
  if(owner&&owner.startsWith('banned:')){
    const rec=await banLib.current(id);
    if(rec){if(rec.prev&&rec.prev===digest)req.monoBan=rec;return false}
    owner=await cmd('GET','mono:acct:v1:owner:'+id);
  }
  if(owner&&owner!==digest)return false;
  const created=await cmd('SET',key,digest,'NX','EX',AUTH_TTL);
  if(created==='OK'){
    // Первое появление ID: закрепляем владельца и дату регистрации (для медалей «N лет в Mono»).
    if(!owner)await batch([['SET','mono:acct:v1:owner:'+id,digest,'NX'],['HSETNX','mono:acct:v1:created',id,String(Date.now())]]);
    return true;
  }
  return await cmd('GET',key)===digest;
}

function validatePayload(body){
  if(!body||typeof body!=='object'||Array.isArray(body)||!ALLOWED.has(body.type))return false;
  const raw=JSON.stringify(body);
  if(raw.length>MAX_BODY)return false;
  const t=body.type;
  if(t==='text'||t==='group-text')return typeof body.text==='string'&&body.text.length<=8000;
  if(t==='hello'||t==='friend-request')return !!body.profile&&typeof body.profile.nick==='string'&&body.profile.nick.length<=64;
  if(t==='friend-response')return typeof body.accepted==='boolean';
  if(t==='watch'){
    const p=body.payload;
    if(!p||typeof p!=='object'||Array.isArray(p))return false;
    if(!/^WT-[A-F0-9]{20}$/.test(p.room||''))return false;
    if(!['invite','accept','decline','ready','state','control','buffer','leave','request-state','rtc'].includes(p.action))return false;
    // rtc: одноразовое WebRTC-«рукопожатие» (offer/answer со всеми ICE-кандидатами) для прямого канала синхронизации между двумя зрителями.
    if(p.action==='rtc'){
      if(!['offer','answer'].includes(p.rtcType)||typeof p.sdp!=='string'||p.sdp.length<20||p.sdp.length>12000||!p.sdp.startsWith('v=0'))return false;
      if(JSON.stringify(p).length>12600)return false;
    }else if(JSON.stringify(p).length>2400)return false;
    if(p.rate!==undefined&&(typeof p.rate!=='number'||!(p.rate>=0.25&&p.rate<=2)))return false;
    if(p.url!==undefined && (typeof p.url!=='string'||p.url.length>1600||!/^https:\/\//i.test(p.url)))return false;
    if(p.kind!==undefined&&!['youtube','video'].includes(p.kind))return false;
    if(p.position!==undefined&&(!Number.isFinite(p.position)||p.position<0||p.position>864000))return false;
    if(p.at!==undefined&&(!Number.isSafeInteger(p.at)||p.at<0))return false;
    if(p.seq!==undefined&&(!Number.isSafeInteger(p.seq)||p.seq<0))return false;
    if(p.paused!==undefined&&typeof p.paused!=='boolean')return false;
    return true;
  }
  if(t==='game')return ['chess','tic'].includes(body.game)&&body.payload&&typeof body.payload==='object'&&JSON.stringify(body.payload).length<=8192;
  if(t==='blob')return Number.isSafeInteger(body.size)&&body.size>=0&&body.size<=150*1024*1024&&typeof body.key==='string';
  if(t==='blob-chunk')return typeof body.key==='string'&&Number.isSafeInteger(body.index)&&body.index>=0&&typeof body.data==='string'&&body.data.length<=190000&&/^[A-Za-z0-9+/]*={0,2}$/.test(body.data);
  if(t==='group-invite')return !!body.group&&typeof body.group.title==='string';
  if(t==='group-joined'||t==='receipt')return true;
  return false;
}
module.exports=async function handler(req,res){
  for(const [key,value] of Object.entries(HEADERS))res.setHeader(key,value);
  if(req.method==='OPTIONS')return res.status(204).end();
  try{
    if(req.method==='GET'){
      const id=asString(req.query?.id),action=String(req.query?.action||'poll');
      if(!ID.test(id))return response(res,400,{error:'Invalid Mono ID'});
      if(action==='presence'){
        // Public presence remains supported for old clients.
        const online=!!(await cmd('GET','mono:r3:online:'+id));
        return response(res,200,{ok:true,online});
      }
      if(action==='presence-batch'){
        if(!(await authorized(req,id)))return deny(req,res);
        const peers=String(req.query?.peers||'').split(',').map(asString).filter(x=>ID.test(x)&&x!==id).slice(0,30);
        if(!peers.length)return response(res,200,{ok:true,peers:{}});
        // One MGET instead of a separate HTTP+Redis request for every friend.
        const results=await cmd('MGET',...peers.map(x=>'mono:r3:online:'+x));
        return response(res,200,{ok:true,peers:Object.fromEntries(peers.map((peer,i)=>[peer,!!results?.[i]]))});
      }
      if(action!=='poll')return response(res,400,{error:'Invalid action'});
      const token=req.headers?.['x-mono-token'];
      if(typeof token!=='string'||token.length<24||token.length>256)return deny(req,res);
      const digest=createHash('sha256').update(token).digest('hex');
      // One Redis command to check auth AND fetch queued messages. No Redis
      // reads at all occur when the browser is closed; the client schedules its
      // own low-frequency fallback when no realtime signaling provider exists.
      // ONE request does everything a tick needs: auth check, heartbeat (online flag),
      // queued messages and the friends' presence flags. Before, the client used up to
      // three separate requests (ping + poll + presence-batch) -> a big saving of the
      // monthly request quota.
      const hb=Math.max(0,Math.min(400,parseInt(String(req.query?.hb||'0'),10)||0));
      const peers=String(req.query?.peers||'').split(',').map(asString).filter(x=>ID.test(x)&&x!==id).slice(0,30);
      const script=`
        if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {0} end
        local hb=tonumber(ARGV[2])
        if hb and hb>0 then
          redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
          redis.call('SET', 'mono:r3:online:'..string.sub(KEYS[1],14), '1', 'EX', hb)
        end
        local ids=redis.call('ZRANGE', KEYS[2], 0, 11)
        local out={1}
        local n=0
        for _,mid in ipairs(ids) do
          local raw=redis.call('HGET',KEYS[3],mid)
          if raw then table.insert(out,raw) n=n+1 end
        end
        out[2+n]='|'
        for i=4,#KEYS do
          local on=redis.call('EXISTS',KEYS[i])
          table.insert(out,on)
        end
        return out
      `;
      const keys=['mono:r3:auth:'+id,idx(id),dataKey(id),...peers.map(x=>'mono:r3:online:'+x)];
      const run=()=>cmd('EVAL',script,keys.length,...keys,digest,String(hb),String(AUTH_TTL));
      let results=await run();
      if(!Array.isArray(results)||Number(results[0])!==1){
        // First run registration follows exactly the old authorization rules.
        if(!(await authorized(req,id)))return deny(req,res);
        results=await run();
      }
      if(!Array.isArray(results)||Number(results[0])!==1)return deny(req,res);
      const messages=[];const sep=results.indexOf('|');
      const rawMessages=sep>0?results.slice(1,sep):results.slice(1);
      for(const raw of rawMessages){
        try{const envelope=JSON.parse(raw);if(envelope?.id)messages.push(envelope)}catch(_){}
      }
      const out={ok:true,messages};
      if(peers.length&&sep>0){out.peers=Object.fromEntries(peers.map((peer,i)=>[peer,Number(results[sep+1+i])===1]))}
      return response(res,200,out);
    }
    if(req.method!=='POST')return response(res,405,{error:'Method not allowed'});
    let body=req.body;
    if(typeof body==='string'){try{body=JSON.parse(body)}catch(_){return response(res,400,{error:'Invalid JSON'})}}
    if(!body||typeof body!=='object')return response(res,400,{error:'Invalid JSON object'});
    const action=String(body.action||'');
    if(action==='ping'){
      const id=asString(body.id);
      if(!ID.test(id))return response(res,400,{error:'Invalid Mono ID'});
      if(!(await authorized(req,id)))return deny(req,res);
      await batch([['EXPIRE','mono:r3:auth:'+id,AUTH_TTL],['SET','mono:r3:online:'+id,'1','EX',130]]);
      return response(res,200,{ok:true});
    }
    if(action==='ack'){
      const id=asString(body.id);
      if(!ID.test(id)||!Array.isArray(body.ids)||body.ids.length>36||!body.ids.every(x=>MESSAGE_ID.test(x)))return response(res,400,{error:'Invalid ACK'});
      if(!(await authorized(req,id)))return deny(req,res);
      if(body.ids.length)await batch([['HDEL',dataKey(id),...body.ids],['ZREM',idx(id),...body.ids]]);
      return response(res,200,{ok:true,acknowledged:body.ids.length});
    }
    if(action==='send'){
      const from=asString(body.from),to=asString(body.to);
      if(!ID.test(from)||!ID.test(to)||from===to||!validatePayload(body.payload))return response(res,400,{error:'Invalid message envelope'});
      if(!(await authorized(req,from)))return deny(req,res);
      if(body.payload.type==='text'||body.payload.type==='group-text'){
        // Смайлы из магазина: отправить можно только купленный набор (проверка на сервере, клиенту не доверяем).
        const packs=new Set();for(const m of body.payload.text.matchAll(/\[\[emoji:mono-([a-z0-9]+)\//g))packs.add('emoji:'+m[1]);
        for(const item of packs){
          const it=SHOP_ITEMS[item];if(!it||!it.price)continue;
          if(!Number(await cmd('SISMEMBER','mono:wal:v1:shop:own:'+from,item)))return response(res,403,{error:'Этот набор смайлов не куплен',code:'emoji_not_owned',item});
        }
      }
      // Чужие «Mono», «Админ», «Поддержка» и т. п. заменяются на нейтральный ник — выдать себя за администрацию нельзя.
      if(body.payload.profile&&reservedNick(body.payload.profile.nick))body.payload.profile.nick='Пользователь Mono';
      const messageId=MESSAGE_ID.test(body.id)?body.id:randomUUID().replace(/-/g,'');
      const envelope=JSON.stringify({id:messageId,from,to,createdAt:Date.now(),payload:body.payload});
      if(envelope.length>MAX_BODY)return response(res,413,{error:'Message chunk is too large'});
      const time=Date.now();
      // Атомарно: лимит отправителя, переполнение очереди получателя, запрет перезаписи чужого сообщения с тем же id.
      const st=await cmd('EVAL',LUA_SEND,3,dataKey(to),idx(to),'mono:r3:rl:send:'+from,messageId,envelope,String(time),String(TTL),String(SEND_PER_MIN),String(QUEUE_MAX),body.payload.type==='blob-chunk'?'1':'0',String(CHUNK_QUEUE_MAX));
      if(st==='busy'||st==='rate'){res.setHeader('Retry-After',st==='rate'?'10':'1');return response(res,429,{error:st==='rate'?'Too many messages, slow down':'Recipient queue is busy',retryable:true})}
      // dup: сообщение с этим id уже в очереди (повтор после сбоя сети) — не перезаписываем, просто подтверждаем.
      return response(res,202,{ok:true,id:messageId,queuedForSeconds:TTL});
    }
    return response(res,400,{error:'Unknown action'});
  }catch(e){
    console.error('[mono relay]',e.message);
    return response(res,503,{error:'Delivery temporarily unavailable'});
  }
};
