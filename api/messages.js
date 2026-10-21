'use strict';
/* Mono temporary delivery relay v3. No message database and no durable chat history.
   Envelopes live in Redis for at most 300 seconds, or until acknowledged. */
const {randomUUID,createHash} = require('node:crypto');
const ID = /^MONO-[A-F0-9]{20}$/;
const MESSAGE_ID = /^[a-zA-Z0-9_-]{10,80}$/;
const ALLOWED = new Set(['text','hello','group-text','group-invite','group-joined','blob','blob-chunk','receipt','friend-request','friend-response','game','watch']);
const TTL = 300;
const AUTH_TTL = 86400;
const MAX_BODY = 260000;
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
  const created=await cmd('SET',key,digest,'NX','EX',AUTH_TTL);
  if(created==='OK')return true;
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
    if(!p||typeof p!=='object'||Array.isArray(p)||JSON.stringify(p).length>2400)return false;
    if(!/^WT-[A-F0-9]{20}$/.test(p.room||''))return false;
    if(!['invite','accept','decline','ready','state','control','buffer','leave','request-state'].includes(p.action))return false;
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
        if(!(await authorized(req,id)))return response(res,403,{error:'Wrong installation key'});
        const peers=String(req.query?.peers||'').split(',').map(asString).filter(x=>ID.test(x)&&x!==id).slice(0,30);
        if(!peers.length)return response(res,200,{ok:true,peers:{}});
        // One MGET instead of a separate HTTP+Redis request for every friend.
        const results=await cmd('MGET',...peers.map(x=>'mono:r3:online:'+x));
        return response(res,200,{ok:true,peers:Object.fromEntries(peers.map((peer,i)=>[peer,!!results?.[i]]))});
      }
      if(action!=='poll')return response(res,400,{error:'Invalid action'});
      const token=req.headers?.['x-mono-token'];
      if(typeof token!=='string'||token.length<24||token.length>256)return response(res,403,{error:'Wrong installation key'});
      const digest=createHash('sha256').update(token).digest('hex');
      // One Redis command to check auth AND fetch queued messages. No Redis
      // reads at all occur when the browser is closed; the client schedules its
      // own low-frequency fallback when no realtime signaling provider exists.
      const script=`
        if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {0} end
        local ids=redis.call('ZRANGE', KEYS[2], 0, 11)
        local out={1}
        for _,mid in ipairs(ids) do
          local raw=redis.call('HGET',KEYS[3],mid)
          if raw then table.insert(out,raw) end
        end
        return out
      `;
      let results=await cmd('EVAL',script,3,'mono:r3:auth:'+id,idx(id),dataKey(id),digest);
      if(!Array.isArray(results)||Number(results[0])!==1){
        // First run registration follows exactly the old authorization rules.
        if(!(await authorized(req,id)))return response(res,403,{error:'Wrong installation key'});
        results=await cmd('EVAL',script,3,'mono:r3:auth:'+id,idx(id),dataKey(id),digest);
      }
      if(!Array.isArray(results)||Number(results[0])!==1)return response(res,403,{error:'Wrong installation key'});
      const messages=[];
      for(const raw of results.slice(1)){
        try{const envelope=JSON.parse(raw);if(envelope?.id)messages.push(envelope)}catch(_){}
      }
      return response(res,200,{ok:true,messages});
    }
    if(req.method!=='POST')return response(res,405,{error:'Method not allowed'});
    let body=req.body;
    if(typeof body==='string'){try{body=JSON.parse(body)}catch(_){return response(res,400,{error:'Invalid JSON'})}}
    if(!body||typeof body!=='object')return response(res,400,{error:'Invalid JSON object'});
    const action=String(body.action||'');
    if(action==='ping'){
      const id=asString(body.id);
      if(!ID.test(id))return response(res,400,{error:'Invalid Mono ID'});
      if(!(await authorized(req,id)))return response(res,403,{error:'Wrong installation key'});
      await batch([['EXPIRE','mono:r3:auth:'+id,AUTH_TTL],['SET','mono:r3:online:'+id,'1','EX',130]]);
      return response(res,200,{ok:true});
    }
    if(action==='ack'){
      const id=asString(body.id);
      if(!ID.test(id)||!Array.isArray(body.ids)||body.ids.length>36||!body.ids.every(x=>MESSAGE_ID.test(x)))return response(res,400,{error:'Invalid ACK'});
      if(!(await authorized(req,id)))return response(res,403,{error:'Wrong installation key'});
      if(body.ids.length)await batch([['HDEL',dataKey(id),...body.ids],['ZREM',idx(id),...body.ids]]);
      return response(res,200,{ok:true,acknowledged:body.ids.length});
    }
    if(action==='send'){
      const from=asString(body.from),to=asString(body.to);
      if(!ID.test(from)||!ID.test(to)||from===to||!validatePayload(body.payload))return response(res,400,{error:'Invalid message envelope'});
      if(!(await authorized(req,from)))return response(res,403,{error:'Wrong installation key'});
      if(body.payload.type==='blob-chunk' && Number(await cmd('ZCARD',idx(to)))>=48){
        res.setHeader('Retry-After','1');
        return response(res,429,{error:'Recipient queue is busy',retryable:true});
      }
      const messageId=MESSAGE_ID.test(body.id)?body.id:randomUUID().replace(/-/g,'');
      const envelope=JSON.stringify({id:messageId,from,to,createdAt:Date.now(),payload:body.payload});
      if(envelope.length>MAX_BODY)return response(res,413,{error:'Message chunk is too large'});
      const time=Date.now();
      await batch([
        ['HSET',dataKey(to),messageId,envelope],
        ['ZADD',idx(to),time,messageId],
        ['EXPIRE',dataKey(to),TTL],
        ['EXPIRE',idx(to),TTL]
      ]);
      return response(res,202,{ok:true,id:messageId,queuedForSeconds:TTL});
    }
    return response(res,400,{error:'Unknown action'});
  }catch(e){
    console.error('[mono relay]',e.message);
    return response(res,503,{error:'Delivery temporarily unavailable'});
  }
};
