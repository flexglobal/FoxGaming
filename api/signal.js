'use strict';
/**
 * Minimal stateless HTTP handler for Vercel. Only WebRTC SDP OFFER/ANSWER messages.
 * No chat, voice or attachment data ever pass through this API.
 * Upstash holds each signaling envelope for at most 120s or until one GET consumes it.
 */
const ID=/^MONO-[A-F0-9]{20}$/;
const TTL=120;
const NO_CACHE={'Cache-Control':'no-store, max-age=0','Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'};
async function redis(cmd){
  const url=process.env.UPSTASH_REDIS_REST_URL,token=process.env.UPSTASH_REDIS_REST_TOKEN;
  if(!url||!token)throw new Error('Missing Upstash Redis credentials');
  const res=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(cmd),signal:AbortSignal.timeout(8000)});
  if(!res.ok)throw Error('Redis HTTP '+res.status);
  const data=await res.json();if(data.error)throw Error('Redis error');return data.result;
}
module.exports=async function handler(req,res){
  for(const [k,v] of Object.entries(NO_CACHE))res.setHeader(k,v);
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method==='GET'){
    const id=String(req.query?.id||'').trim().toUpperCase();
    if(!ID.test(id))return res.status(400).json({error:'Invalid Mono ID'});
    try{
      const value=await redis(['LPOP','mono:signal:v1:'+id]);
      return res.status(200).json({signal:value?JSON.parse(value):null});
    }catch(e){console.error('[relay] GET:',e.message);return res.status(503).json({error:'Signaling temporarily unavailable'})}
  }
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  let b=req.body;
  if(typeof b==='string'){try{b=JSON.parse(b)}catch(_){return res.status(400).json({error:'Invalid JSON'})}}
  if(!b||typeof b!=='object')return res.status(400).json({error:'Invalid body'});
  const from=String(b.from||'').trim().toUpperCase(),to=String(b.to||'').trim().toUpperCase();
  if(!ID.test(from)||!ID.test(to)||from===to||!['offer','answer'].includes(b.type))return res.status(400).json({error:'Invalid address or type'});
  const sdp=b.payload?.sdp;
  if(typeof sdp!=='string'||sdp.length>45000||sdp.length<20||!sdp.startsWith('v=0')||b.payload?.type!==b.type)return res.status(400).json({error:'Invalid SDP'});
  const address=String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim().slice(0,120);
  const rateKey='mono:ratelimit:v1:'+require('node:crypto').createHash('sha256').update(address).digest('hex').slice(0,22);
  try{
    const count=await redis(['INCR',rateKey]);
    if(count===1)await redis(['EXPIRE',rateKey,60]);
    if(count>50)return res.status(429).json({error:'Too many connection requests'});
    const entry=JSON.stringify({from,to,type:b.type,payload:{type:b.type,sdp},time:Date.now()});
    const key='mono:signal:v1:'+to;
    await redis(['RPUSH',key,entry]);
    await redis(['EXPIRE',key,TTL]);
    await redis(['LTRIM',key,-8,-1]);
    return res.status(202).json({ok:true,queuedForSeconds:TTL});
  }catch(e){console.error('[relay] POST:',e.message);return res.status(503).json({error:'Signaling temporarily unavailable'})}
};
