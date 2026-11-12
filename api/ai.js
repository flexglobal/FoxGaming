'use strict';
/* Mono AI — нейросеть через Vercel AI Gateway.
   Ключ не нужен: на Vercel запрос подписывается OIDC-токеном проекта (или AI_GATEWAY_API_KEY, если задан).
   Переписка нигде не сохраняется: сервер только пересылает её модели и стримит ответ обратно.
   Защита бюджета: лимиты на IP в час/сутки и общий суточный лимит (AI_DAILY_LIMIT).
   Этот же файл отдаёт /api/health (rewrite в vercel.json) — на Hobby не больше 12 функций. */
const crypto = require('node:crypto');
const { batch } = require('../lib/redis');
const health = require('../lib/health');

/* По умолчанию — Vercel AI Gateway. Можно подключить любой OpenAI-совместимый сервис:
   AI_BASE_URL (…/chat/completions) + AI_API_KEY + AI_MODELS (например, Groq или Google AI Studio). */
const GATEWAY = process.env.AI_BASE_URL || 'https://ai-gateway.vercel.sh/v1/chat/completions';
const MODELS = String(process.env.AI_MODELS || 'google/gemini-3.1-flash-lite,google/gemini-2.5-flash-lite').split(',').map(s => s.trim()).filter(Boolean);
const DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT) || 150;
const IP_HOUR = Number(process.env.AI_IP_HOURLY) || 30;
const IP_DAY = Number(process.env.AI_IP_DAILY) || 80;
const MAX_MESSAGES = 14, MAX_CHARS = 4000, MAX_TOTAL = 16000;

const SYSTEM = `Ты — Mono AI, встроенный помощник браузера Mono для Windows.
Отвечай на языке пользователя (обычно русский), дружелюбно и по делу, обращайся на «ты».
Сначала давай прямой ответ, потом детали. Короткий вопрос — короткий ответ (1–4 предложения); для объяснений, инструкций и кода — структурируй ответ.
Можно использовать Markdown: **жирный**, списки, заголовки ###, \`код\` и блоки \`\`\`. Таблицы не используй.
У тебя нет доступа к интернету в реальном времени. Если в сообщении есть раздел «Справка», опирайся на него и не противоречь ему. Свежие новости, цены и события после своих знаний не выдумывай — честно скажи, что можешь ошибаться, и предложи поискать в интернете.
Погоду, курсы валют, время и точные расчёты Mono считает отдельно по живым данным — если спрашивают об этом, а данных нет, предложи спросить коротко, например «погода в Казани» или «100 долларов в рублях».
Не выдумывай факты, ссылки и цитаты. Если не уверен — так и скажи.

Что есть в браузере Mono (о других функциях Mono не фантазируй — если не знаешь, скажи, что не уверен):
- Браузер на движке Chromium; главная страница с поиском и подсказками, быстрые ссылки; слева боковая панель: Workspaces, AI, история, загрузки, закладки.
- 16 инструментов в Workspaces: Mono AI, Notes (заметки с форматированием, автосохранение, импорт TXT и экспорт), Translator (перевод текста и страниц с английского на русский, модель работает на компьютере), Messenger (чаты, группы, каналы, подарки, медали и рамки, путь уровней, друга добавляют по Mono ID; нужен вход через Google), Music (каталог YouTube Music, избранное, свои песни с компьютера), Media (плеер видео с компьютера и совместный просмотр YouTube с другом), Games (шахматы: бот с 5 уровнями, игра вдвоём за одним компьютером, с другом через Messenger, рейтинговые матчи с ELO; Tower Defense, крестики-нолики по сети), Performance (тест скорости интернета через Cloudflare: загрузка, отдача, пинг, джиттер, история), Cleaning (временные файлы, кэши, отчёты об ошибках; удаляет только выбранное, не трогает Загрузки, Документы и Рабочий стол), Privacy (зашифрованное хранилище файлов с PIN-кодом 4, 6 или 12 цифр), VPN (Cloudflare WARP через официальный клиент Cloudflare), Ad Block (правила uBlock Origin Lite), Screenshots, Screen Time, Split View, Customize (тема, акцентный цвет, обои главной, скругления, размытие стекла, шрифт, плотность).
- Mono Overlay поверх игр: открывается удержанием правого Ctrl 1,5 секунды (можно F7, F8 или F9; запасной вариант — Ctrl+Shift+M или значок Mono в трее); выбор стрелками или WASD, короткое нажатие Ctrl — выбрать, долгое — закрыть. Меню: музыка, звук (громкость Windows, микрофон, громкость Mono Music), игровой режим (приоритет, скрытие уведомлений, запись и стрим через OBS), 20 прицелов, 5 наборов курсоров, 8 мини-игр, калькулятор и конвертер 12 валют по курсу ЦБ, время с календарём и погодой, подсказки клавиш, мониторинг CPU/GPU/памяти, GIF-библиотека, плеер YouTube, автосмена разрешения. В играх нужен режим «Полноэкранный в окне» или «Без рамки».
- Ошибку можно отправить боту Mono в Messenger командой /bug.`;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Mono-Client');
  res.setHeader('Cache-Control', 'no-store');
}
const ipHash = req => {
  const raw = String(req.headers?.['x-forwarded-for'] || req.headers?.['x-real-ip'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  return crypto.createHash('sha256').update('mono-ai|' + raw).digest('hex').slice(0, 24);
};
function gatewayToken(req) {
  return process.env.AI_API_KEY || process.env.AI_GATEWAY_API_KEY || req.headers?.['x-vercel-oidc-token'] || process.env.VERCEL_OIDC_TOKEN || '';
}
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 80000) throw Error('too large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/* Лимиты: один pipeline-запрос к Upstash. */
async function takeQuota(req) {
  const day = new Date().toISOString().slice(0, 10), hour = new Date().toISOString().slice(0, 13), ip = ipHash(req);
  const kDay = 'mono:ai:v1:day:' + day, kIpH = 'mono:ai:v1:ip:' + ip + ':' + hour, kIpD = 'mono:ai:v1:ipd:' + ip + ':' + day;
  const r = await batch([['INCR', kDay], ['EXPIRE', kDay, 172800], ['INCR', kIpH], ['EXPIRE', kIpH, 7200], ['INCR', kIpD], ['EXPIRE', kIpD, 172800]]);
  const [total, , perHour, , perDay] = r.map(Number);
  if (total > DAILY_LIMIT) return { ok: false, code: 'daily-limit', error: 'Лимит нейросети Mono на сегодня исчерпан.' };
  if (perHour > IP_HOUR || perDay > IP_DAY) return { ok: false, code: 'rate-limit', error: 'Слишком много вопросов подряд. Попробуй чуть позже.' };
  return { ok: true };
}

function cleanMessages(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const m of list.slice(-MAX_MESSAGES)) {
    if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') continue;
    const content = m.content.trim().slice(0, MAX_CHARS);
    if (content) out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  let total = out.reduce((n, m) => n + m.content.length, 0);
  while (out.length > 1 && total > MAX_TOTAL) total -= out.shift().content.length;
  if (!out.length || out[out.length - 1].role !== 'user') return null;
  return out;
}
function systemPrompt(ctx = {}) {
  let s = SYSTEM;
  const now = typeof ctx.now === 'string' ? ctx.now.slice(0, 120) : '';
  if (now) s += `\n\nСейчас у пользователя: ${now}.`;
  if (typeof ctx.city === 'string' && ctx.city) s += ` Город пользователя (из настроек): ${ctx.city.slice(0, 80)}.`;
  const w = ctx.wiki;
  if (w && typeof w.extract === 'string' && w.extract) {
    s += `\n\nСправка (Википедия, статья «${String(w.title || '').slice(0, 150)}»):\n${w.extract.slice(0, 3000)}`;
  }
  return s;
}

async function callModel(token, messages, stream, maxTokens) {
  let last = null;
  for (const model of MODELS) {
    const c = new AbortController(), t = setTimeout(() => c.abort(), 25000);
    try {
      const r = await fetch(GATEWAY, {
        method: 'POST', signal: c.signal,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream, max_tokens: maxTokens, temperature: 0.6 }),
      });
      clearTimeout(t);
      if (r.ok) return { r, model };
      last = { status: r.status, text: (await r.text().catch(() => '')).slice(0, 300) };
      if (r.status === 401 || r.status === 403) break; // токен неверный — другие модели не помогут
    } catch (e) { clearTimeout(t); last = { status: 0, text: String(e.message || e) }; }
  }
  const err = Error('gateway'); err.detail = last; throw err;
}

/* Пересылаем SSE модели клиенту как простой текст по кусочкам. */
async function pipeStream(r, res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('X-Accel-Buffering', 'no');
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '', sent = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) { res.write(delta); sent += delta.length; }
      } catch (_) { /* служебные строки */ }
    }
  }
  if (!sent) res.write('Не получилось сформулировать ответ. Попробуй переспросить.');
  res.end();
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  if (q.health) return health(req, res);

  if (req.method === 'GET') {
    // Проверка без трат: есть ли доступ к шлюзу. ?probe=1 — короткий настоящий запрос (тратит лимит).
    const token = gatewayToken(req);
    if (!q.probe) return res.status(200).json({ ok: true, aiReady: !!token, models: MODELS, version: '3.4.0' });
    if (!token) return res.status(503).json({ ok: false, code: 'no-gateway', error: 'Нет доступа к AI Gateway' });
    try {
      const quota = await takeQuota(req); if (!quota.ok) return res.status(429).json(quota);
      const { r, model } = await callModel(token, [{ role: 'user', content: 'Ответь одним словом: работает?' }], false, 20);
      const j = await r.json();
      return res.status(200).json({ ok: true, model, reply: j?.choices?.[0]?.message?.content || '' });
    } catch (e) { return res.status(502).json({ ok: false, code: 'gateway', detail: e.detail || String(e.message || e) }); }
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  let body;
  try { body = await readBody(req); } catch (_) { return res.status(400).json({ ok: false, code: 'bad-json', error: 'Неверный запрос' }); }
  const messages = cleanMessages(body?.messages);
  if (!messages) return res.status(400).json({ ok: false, code: 'bad-messages', error: 'Нет вопроса' });
  const token = gatewayToken(req);
  if (!token) return res.status(503).json({ ok: false, code: 'no-gateway', error: 'Нейросеть сейчас недоступна' });
  try {
    const quota = await takeQuota(req);
    if (!quota.ok) return res.status(429).json(quota);
  } catch (_) { /* Redis недоступен — не блокируем, лимиты шлюза всё равно защищают бюджет */ }

  const full = [{ role: 'system', content: systemPrompt(body.context) }, ...messages];
  try {
    const { r } = await callModel(token, full, true, 1500);
    return await pipeStream(r, res);
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch (_) {} return; }
    const st = e.detail?.status;
    const code = (st === 402 || st === 403) ? 'no-credits' : st === 429 ? 'gateway-busy' : 'gateway';
    return res.status(502).json({ ok: false, code, error: 'Нейросеть сейчас недоступна' });
  }
};
module.exports._test = { cleanMessages, systemPrompt };
