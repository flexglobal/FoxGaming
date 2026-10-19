'use strict';
/* Google OAuth for Mono desktop: confidential client secret stays on server.
   Temporary identity session only; no Google tokens persisted. */
const crypto=require('node:crypto');
const PFX='mono:google:pending:';
const CID=process.env.GOOGLE_OAUTH_CLIENT_ID||'';
const SECRET=process.env.GOOGLE_OAUTH_CLIENT_SECRET||'';
const REDIRECT=process.env.GOOGLE_OAUTH_REDIRECT_URI||'';
const HASH=/^[a-f0-9]{64}$/;
const SESSION=/^[a-f0-9]{48}$/;
const reply=(res,code,body)=>res.status(code).json(body);
async function redis(...args){const endpoint=String(process.env.UPSTASH_REDIS_REST_URL||'').replace(/\/$/,'');const token=process.env.UPSTASH_REDIS_REST_TOKEN;if(!endpoint||!token)throw Error('redis');const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(args),signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('Redis unavailable');const x=await r.json();if(x.error)throw Error('Redis error');return x.result;}
const bodySHA=v=>crypto.createHash('sha256').update(v).digest('hex');
const validConfig=()=>CID&&SECRET&&/^https:\/\/[^/]+\/api\/google\/callback$/.test(REDIRECT);
module.exports=async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  if(req.method==='OPTIONS')return res.status(204).end();
  if(!validConfig())return reply(res,503,{error:'Google OAuth не настроен на сервере (Client ID, Secret, Redirect URI)'});
  if(req.method!=='POST')return reply(res,405,{error:'Use POST'});
  const b=typeof req.body==='object'&&req.body?req.body:{};
  try{
    if(b.action==='begin'){
      if(!SESSION.test(b.session||'')||!HASH.test(b.pollHash||''))return reply(res,400,{error:'Invalid session'});
      const state=crypto.randomBytes(24).toString('hex');const verifier=crypto.randomBytes(32).toString('base64url');
      const entry={pollHash:b.pollHash,state,verifier,createdAt:Date.now(),status:'pending'};
      const created=await redis('SET',PFX+b.session,JSON.stringify(entry),'NX','EX',300);
      if(created!=='OK')return reply(res,409,{error:'Session already exists'});
      const u=new URL('https://accounts.google.com/o/oauth2/v2/auth');u.search=new URLSearchParams({client_id:CID,redirect_uri:REDIRECT,response_type:'code',scope:'openid email profile',state:b.session+'.'+state,code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',prompt:'select_account'}).toString();
      return reply(res,200,{ok:true,url:u.toString()});
    }
    if(b.action==='poll'){
      if(!SESSION.test(b.session||'')||typeof b.secret!=='string'||b.secret.length<24||b.secret.length>250)return reply(res,400,{error:'Invalid session'});
      const raw=await redis('GET',PFX+b.session);if(!raw)return reply(res,404,{error:'Session expired'});
      const entry=JSON.parse(raw),digest=bodySHA(b.secret);
      if(!crypto.timingSafeEqual(Buffer.from(digest,'hex'),Buffer.from(entry.pollHash,'hex')))return reply(res,403,{error:'Not authorized'});
      if(entry.status==='completed'){await redis('DEL',PFX+b.session);return reply(res,200,{ok:true,account:entry.account});}
      if(entry.status==='error'){await redis('DEL',PFX+b.session);return reply(res,400,{error:entry.error||'Google authentication failed'});}
      return reply(res,200,{ok:true,pending:true});
    }
    return reply(res,400,{error:'Invalid action'});
  }catch(e){console.error('[mono oauth]',e.message);return reply(res,503,{error:'OAuth временно недоступен'});}
};
module.exports._config=validConfig;
module.exports._redis=redis;
