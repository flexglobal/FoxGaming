'use strict';
/* News are publisher-approved announcements, not chat messages.
   Configured with MONO_NEWS_ADMIN_TOKEN in Vercel env, never in browser source. */
const crypto=require('node:crypto');
const KEY='mono:official:news:v2';
const headers={'Cache-Control':'no-store','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Authorization,Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
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
  const secret=process.env.MONO_NEWS_ADMIN_TOKEN;
  if(!secret||secret.length<24)return res.status(503).json({error:'News publisher not configured'});
  const supplied=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  if(!supplied||Buffer.byteLength(supplied)!==Buffer.byteLength(secret)||!crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(secret)))return res.status(401).json({error:'Unauthorized'});
  let b=req.body;
  if(typeof b==='string'){try{b=JSON.parse(b)}catch(_){return res.status(400).json({error:'Invalid JSON'})}}
  const title=String(b?.title||'').trim(),body=String(b?.body||'').trim();
  if(!title||!body||title.length>150||body.length>1600)return res.status(400).json({error:'Title/body required; title <=150, body <=1600'});
  const item={id:crypto.randomUUID(),title,body,createdAt:Date.now()};
  try{await redis(['LPUSH',KEY,JSON.stringify(item)]);await redis(['LTRIM',KEY,0,29]);return res.status(201).json({ok:true,item})}
  catch(_){return res.status(503).json({error:'Publish failed'})}
};
