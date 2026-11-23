'use strict';
/* Общий клиент Upstash REST для новых эндпоинтов (profile, game-activity, channels, admin). */
const url=()=>String(process.env.UPSTASH_REDIS_REST_URL||'').replace(/\/$/,'');
const secret=()=>String(process.env.UPSTASH_REDIS_REST_TOKEN||'');
async function call(path,body){
  if(!url()||!secret())throw Error('Redis not configured');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  try{
    const r=await fetch(url()+path,{method:'POST',headers:{Authorization:'Bearer '+secret(),'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
    if(!r.ok)throw Error('Redis HTTP '+r.status);
    const j=await r.json();
    if(j?.error||(Array.isArray(j)&&j.some(x=>x?.error)))throw Error('Redis command failed');
    return j;
  }finally{clearTimeout(timer)}
}
const cmd=async(...args)=>(await call('',args)).result;
/* Несколько команд одним HTTP-запросом (экономит лимит Upstash). */
const batch=async commands=>commands.length?(await call('/pipeline',commands)).map(x=>x.result):[];
module.exports={cmd,batch};
