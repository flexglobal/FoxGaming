'use strict';
const crypto=require('node:crypto');
const g=require('../google.js');
const SESSION=/^[a-f0-9]{48}$/;
const STATE=/^[a-f0-9]{48}$/;
function finish(res,ok){res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'");res.setHeader('Content-Type','text/html; charset=utf-8');res.status(ok?200:400).end(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Mono Browser</title><body style="font-family:system-ui;background:#171d31;color:#eaf0ff;text-align:center;padding:70px"><h2>${ok?'Вход Google подтверждён':'Не удалось войти в Google'}</h2><p>Вернитесь в Mono Browser и закройте эту вкладку.</p></body></html>`)}
module.exports=async(req,res)=>{
  if(req.method!=='GET')return finish(res,false);
  const [session,state]=(String(req.query?.state||'')).split('.');if(!SESSION.test(session||'')||!STATE.test(state||''))return finish(res,false);
  let entry;
  try{const raw=await g._redis('GET','mono:google:pending:'+session);if(!raw)return finish(res,false);entry=JSON.parse(raw);if(entry.state!==state||entry.status!=='pending')return finish(res,false);
    if(req.query?.error||!req.query?.code)throw Error(String(req.query.error||'No authorization code').slice(0,100));
    const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:process.env.GOOGLE_OAUTH_CLIENT_ID,client_secret:process.env.GOOGLE_OAUTH_CLIENT_SECRET,code:String(req.query.code),code_verifier:entry.verifier,redirect_uri:process.env.GOOGLE_OAUTH_REDIRECT_URI,grant_type:'authorization_code'}),signal:AbortSignal.timeout(12000)});
    const token=await response.json();if(!response.ok||!token.access_token)throw Error('Google rejected the authorization code');
    const infoRes=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:'Bearer '+token.access_token},signal:AbortSignal.timeout(12000)});
    const info=await infoRes.json();if(!infoRes.ok||!info.sub||info.email_verified!==true)throw Error('Google did not verify this account');
    // Never store Google access tokens or refresh tokens in Redis.
    entry.account={sub:String(info.sub).slice(0,128),name:String(info.name||'').slice(0,128),email:String(info.email||'').slice(0,200),picture: /^https:\/\/([a-z0-9.-]+\.)?googleusercontent\.com\//i.test(info.picture||'')?info.picture:''};entry.status='completed';
  }catch(e){entry.status='error';entry.error='Google: '+e.message;}
  try{await g._redis('SET','mono:google:pending:'+session,JSON.stringify(entry),'EX',180)}catch(_){return finish(res,false)}
  finish(res,entry.status==='completed');
};
