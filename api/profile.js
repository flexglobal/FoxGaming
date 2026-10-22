'use strict';
// Public, opt-in Mono Messenger profiles. No private chat history stored here.
const {createHash}=require('node:crypto');
const ID=/^MONO-[A-F0-9]{20}$/;
const USERNAME=/^[a-z0-9_]{3,32}$/;
const KEY=id=>'mono:public-profile:v1:'+id;
const NAMES='mono:public-profile:v1:usernames';
const HDR={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,X-Mono-Token','Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8','X-Content-Type-Options':'nosniff'};
const url=(process.env.UPSTASH_REDIS_REST_URL||'').replace(/\/$/,'');
const secret=process.env.UPSTASH_REDIS_REST_TOKEN||'';
async function cmd(...args){
 if(!url||!secret)throw Error('Redis not configured');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
 try{const r=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify(args),signal:controller.signal});if(!r.ok)throw Error('Redis '+r.status);const j=await r.json();if(j.error)throw Error('Redis command error');return j.result}finally{clearTimeout(timer)}
}
const clean=(s,n)=>typeof s==='string'?s.trim().slice(0,n):'';
const image=(value,max)=>{if(typeof value!=='string'||value.length>max)return '';return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)?value:''};
const country=c=>/^[A-Z]{2}$/.test(c||'')?c:'unknown';
const badges=new Set(['youtube','twitch','mono','chat','bronze_star','silver_star','gold_star','diamond_star','community','building','bird','bronze_chess','silver_chess','gold_chess','diamond_chess','settings','snake']);
function validate(input){
 if(!input||typeof input!=='object'||Array.isArray(input))return null;
 const username=clean(input.username,32).toLowerCase().replace(/^@/,'');
 if(username&&!USERNAME.test(username))return null;
 const links=(Array.isArray(input.links)?input.links:[]).slice(0,5).filter(o=>o&&typeof o.url==='string'&&/^https:\/\//i.test(o.url)&&o.url.length<350).map(o=>({type:clean(o.type,25),url:o.url}));
 const langs=(Array.isArray(input.languages)?input.languages:[]).slice(0,5).map(x=>clean(x,22)).filter(Boolean);
 return {username,nick:clean(input.nick,64)||'Пользователь Mono',bio:clean(input.bio,400),avatar:image(input.avatar,120000),cover:image(input.cover,190000),country:country(input.country),languages:langs,links,achievements:(Array.isArray(input.achievements)?input.achievements:[]).filter(id=>badges.has(id)).slice(0,17)};
}
async function authorized(req,id){const token=req.headers?.['x-mono-token'];if(typeof token!=='string'||token.length<24||token.length>256)return false;const digest=createHash('sha256').update(token).digest('hex');const found=await cmd('GET','mono:r3:auth:'+id);return !!found&&found===digest}
module.exports=async(req,res)=>{
 for(const [k,v] of Object.entries(HDR))res.setHeader(k,v);
 if(req.method==='OPTIONS')return res.status(204).end();
 try{
  if(req.method==='GET'){
   let id=clean(req.query?.id,26).toUpperCase();const username=clean(req.query?.username,32).toLowerCase().replace(/^@/,'');
   if(!ID.test(id)){if(!USERNAME.test(username))return res.status(400).json({error:'Invalid profile query'});id=await cmd('HGET',NAMES,username)}
   if(!id)return res.status(404).json({error:'Profile not found'});
   const raw=await cmd('GET',KEY(id));if(!raw)return res.status(404).json({error:'Profile not found'});
   return res.status(200).json({ok:true,id,profile:JSON.parse(raw)});
  }
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  const b=typeof req.body==='string'?JSON.parse(req.body):req.body;
  const id=clean(b?.id,26).toUpperCase();if(!ID.test(id))return res.status(400).json({error:'Invalid Mono ID'});
  if(!(await authorized(req,id)))return res.status(403).json({error:'Invalid identity'});
  const profile=validate(b.profile);if(!profile)return res.status(400).json({error:'Invalid profile'});
  const old=await cmd('GET',KEY(id));const prev=old?JSON.parse(old):{};
  // Atomic username reservation and profile write. Old names are released only
  // when they belong to the same Mono ID. No user can claim someone else's name.
  const lua=`
  local old=ARGV[3];local new=ARGV[2];local id=ARGV[1]
  if new~='' then local owner=redis.call('HGET',KEYS[2],new);if owner and owner~=id then return 0 end end
  if old~='' and old~=new and redis.call('HGET',KEYS[2],old)==id then redis.call('HDEL',KEYS[2],old) end
  if new~='' then redis.call('HSET',KEYS[2],new,id) end
  redis.call('SET',KEYS[1],ARGV[4]);return 1`;
  const result=await cmd('EVAL',lua,2,KEY(id),NAMES,id,profile.username,prev.username||'',JSON.stringify({...profile,updatedAt:Date.now()}));
  if(Number(result)!==1)return res.status(409).json({error:'Username already taken'});
  return res.status(200).json({ok:true,id,username:profile.username});
 }catch(e){console.error('[profile api]',e.message);return res.status(503).json({error:'Profile service unavailable'})}
};
