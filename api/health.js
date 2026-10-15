'use strict';
module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='GET')return res.status(405).json({ok:false,error:'Method not allowed'});
  const url=process.env.UPSTASH_REDIS_REST_URL,token=process.env.UPSTASH_REDIS_REST_TOKEN;
  if(!url||!token)return res.status(503).json({ok:false,signalingReady:false,redis:'not-configured',version:'2.0.0'});
  try{
    const c=new AbortController(),timeout=setTimeout(()=>c.abort(),5500);
    let r;try{r=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(['PING']),signal:c.signal})}finally{clearTimeout(timeout)}
    const data=await r.json();
    if(!r.ok||data.error||data.result!=='PONG')throw Error('Redis unreachable');
    return res.status(200).json({ok:true,signalingReady:true,redis:'connected',version:'2.0.0'});
  }catch(e){return res.status(503).json({ok:false,signalingReady:false,redis:'unreachable',version:'2.0.0'})}
};
