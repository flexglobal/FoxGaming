'use strict';
module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='GET')return res.status(405).json({ok:false,error:'Method not allowed'});
  const url=(process.env.UPSTASH_REDIS_REST_URL||'').replace(/\/$/,''),token=process.env.UPSTASH_REDIS_REST_TOKEN;
  if(!url||!token)return res.status(503).json({ok:false,relayReady:false,redis:'not-configured',version:'3.0.0'});
  const c=new AbortController(),timeout=setTimeout(()=>c.abort(),5500);
  try{
    const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(['PING']),signal:c.signal});
    const value=await response.json();
    if(!response.ok||value.error||value.result!=='PONG')throw Error('PING failed');
    return res.status(200).json({ok:true,relayReady:true,redis:'connected',version:'3.0.0'});
  }catch(e){return res.status(503).json({ok:false,relayReady:false,redis:'unreachable',version:'3.0.0'});
  }finally{clearTimeout(timeout)}
};
