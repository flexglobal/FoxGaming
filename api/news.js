'use strict';
/* News are publisher-approved announcements, not chat messages.
   Configured with MONO_NEWS_ADMIN_TOKEN in Vercel env, never in browser source. */
const crypto=require('node:crypto');
const {authenticate,denyBody,ID}=require('../lib/auth');
const lib=require('../lib/redis');
const KEY='mono:official:news:v2';
/* Баг-репорты через бота «Mono» в мессенджере (/bug текст). Лимиты проверяет СЕРВЕР: 3 отчёта за 24 часа с аккаунта, до 1000 слов в каждом. */
const BUG_LIMIT=3,BUG_WINDOW=86400,BUG_MAX_WORDS=1000,BUG_MAX_CHARS=12000,BUG_KEEP=1000;
const LUA_BUG=`
local n=tonumber(redis.call('GET',KEYS[1]) or '0')
if n>=tonumber(ARGV[1]) then return {0,n,redis.call('TTL',KEYS[1])} end
n=redis.call('INCR',KEYS[1])
if n==1 or redis.call('TTL',KEYS[1])<0 then redis.call('EXPIRE',KEYS[1],tonumber(ARGV[2])) end
redis.call('HSET',KEYS[3],ARGV[3],ARGV[5])
redis.call('ZADD',KEYS[2],tonumber(ARGV[4]),ARGV[3])
local c=redis.call('ZCARD',KEYS[2])
local keep=tonumber(ARGV[6])
if c>keep then
  local old=redis.call('ZRANGE',KEYS[2],0,c-keep-1)
  for _,r in ipairs(old) do redis.call('HDEL',KEYS[3],r); redis.call('ZREM',KEYS[2],r) end
end
return {1,n,tonumber(ARGV[2])}`;
const clip=(v,n)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f<>]/g,' ').trim().slice(0,n):'';
async function bugReport(req,res,b){
  const id=typeof b.id==='string'?b.id.trim().toUpperCase():'';
  if(!ID.test(id))return res.status(400).json({error:'Invalid Mono ID'});
  if(!(await authenticate(req,id)))return res.status(403).json(denyBody(req,{error:'Wrong installation key'}));
  const text=typeof b.text==='string'?b.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim():'';
  if(!text)return res.status(400).json({error:'Опиши проблему: /bug что случилось'});
  const words=text.split(/\s+/).filter(Boolean).length;
  if(words>BUG_MAX_WORDS||text.length>BUG_MAX_CHARS)return res.status(413).json({error:'Слишком длинное сообщение: максимум '+BUG_MAX_WORDS+' слов',words});
  const meta=b.meta&&typeof b.meta==='object'&&!Array.isArray(b.meta)?{v:clip(b.meta.v,32),os:clip(b.meta.os,64),theme:clip(b.meta.theme,16)}:{};
  const rid=crypto.randomUUID();
  const rec=JSON.stringify({rid,id,at:Date.now(),text,words,meta,status:'new'});
  const out=await lib.cmd('EVAL',LUA_BUG,3,'mono:bug:v1:cnt:'+id,'mono:bug:v1:idx','mono:bug:v1:r',String(BUG_LIMIT),String(BUG_WINDOW),rid,String(Date.now()),rec,String(BUG_KEEP));
  if(!Number(out[0])){const wait=Math.max(60,Number(out[2])||BUG_WINDOW);return res.status(429).json({error:'Лимит: '+BUG_LIMIT+' баг-репорта в сутки. Следующий можно отправить примерно через '+Math.ceil(wait/3600)+' ч.',left:0,retryAfter:wait})}
  return res.status(201).json({ok:true,rid,words,left:Math.max(0,BUG_LIMIT-Number(out[1]))});
}
const headers={'Cache-Control':'no-store','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Authorization,Content-Type,X-Mono-Token','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
async function redis(cmd){
  const url=process.env.UPSTASH_REDIS_REST_URL,token=process.env.UPSTASH_REDIS_REST_TOKEN;
  if(!url||!token)throw Error('Redis not configured');
  const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),6000);let res;
  try{res=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(cmd),signal:ac.signal})}finally{clearTimeout(timer)}
  if(!res.ok)throw Error('Redis HTTP '+res.status);
  const data=await res.json();if(data.error)throw Error('Redis failed');return data.result;
}
module.exports=async function(req,res){
  for(const [k,v]of Object.entries(headers))res.setHeader(k,v);
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method==='GET'){
    try{const values=await redis(['LRANGE',KEY,0,29]);return res.status(200).json({ok:true,items:(values||[]).map(s=>{try{return JSON.parse(s)}catch(_){return null}}).filter(Boolean)})}
    catch(_){return res.status(503).json({ok:false,error:'News feed unavailable'})}
  }
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  let b=req.body;
  if(typeof b==='string'){try{b=JSON.parse(b)}catch(_){return res.status(400).json({error:'Invalid JSON'})}}
  if(b&&typeof b==='object'&&b.action==='bug'){try{return await bugReport(req,res,b)}catch(e){console.error('[bug]',e.message);return res.status(503).json({error:'Bug report service unavailable'})}}
  const secret=process.env.MONO_NEWS_ADMIN_TOKEN;
  if(!secret||secret.length<24)return res.status(503).json({error:'News publisher not configured'});
  const supplied=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  if(!supplied||Buffer.byteLength(supplied)!==Buffer.byteLength(secret)||!crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(secret)))return res.status(401).json({error:'Unauthorized'});
  const title=String(b?.title||'').trim(),body=String(b?.body||'').trim();
  if(!title||!body||title.length>150||body.length>1600)return res.status(400).json({error:'Title/body required; title <=150, body <=1600'});
  const item={id:crypto.randomUUID(),title,body,createdAt:Date.now()};
  try{await redis(['LPUSH',KEY,JSON.stringify(item)]);await redis(['LTRIM',KEY,0,29]);return res.status(201).json({ok:true,item})}
  catch(_){return res.status(503).json({error:'Publish failed'})}
};
