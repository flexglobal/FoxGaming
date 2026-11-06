'use strict';
/* Администрирование наград. Работает ТОЛЬКО если в Vercel задана переменная MONO_ADMIN_TOKEN (длинная случайная строка).
   Заголовок X-Mono-Admin: <токен>. Пример:
     curl -X POST https://<ваш-домен>/api/admin -H "X-Mono-Admin: $TOKEN" -H "Content-Type: application/json" \
          -d '{"action":"grant","id":"MONO-…","role":"beta"}'
   Действия: grant / revoke (role: beta | staff | bug_hunter), set-vip (id, days; days=-1 — бессрочно, 0 — снять),
             set-created (id, at — миллисекунды: для старых пользователей, чья регистрация была раньше), show (id). */
const {timingSafeEqual,createHash}=require('node:crypto');
const {cmd}=require('../lib/redis');
const {ID,CREATED}=require('../lib/auth');
const {ROLES,VIP,MANUAL,verifiedBadges}=require('../lib/badges');
const HDR={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,X-Mono-Admin','Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8','X-Content-Type-Options':'nosniff'};
const h=v=>createHash('sha256').update(String(v)).digest();
function isAdmin(req){
  const expected=process.env.MONO_ADMIN_TOKEN||'';
  const got=req.headers?.['x-mono-admin'];
  return expected.length>=24&&typeof got==='string'&&timingSafeEqual(h(got),h(expected));
}
module.exports=async(req,res)=>{
  for(const [k,v] of Object.entries(HDR))res.setHeader(k,v);
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  try{
    if(!isAdmin(req))return res.status(403).json({error:'Forbidden'});
    let b=req.body;if(typeof b==='string')b=JSON.parse(b);
    const id=String(b?.id||'').trim().toUpperCase(),action=String(b?.action||'');
    if(!ID.test(id))return res.status(400).json({error:'Invalid Mono ID'});
    const log=entry=>cmd('LPUSH','mono:acct:v1:audit',JSON.stringify({...entry,id,at:Date.now()})).then(()=>cmd('LTRIM','mono:acct:v1:audit',0,999));
    if(action==='grant'||action==='revoke'){
      const role=String(b.role||'');if(!MANUAL.includes(role))return res.status(400).json({error:'Role must be one of '+MANUAL.join(', ')});
      await cmd(action==='grant'?'SADD':'SREM',ROLES(id),role);await log({action,role});
    }else if(action==='set-vip'){
      const days=Number(b.days);if(!Number.isFinite(days)||days<-1||days>3650)return res.status(400).json({error:'days must be -1, 0 or up to 3650'});
      if(days===0)await cmd('HDEL',VIP,id);else await cmd('HSET',VIP,id,String(days===-1?-1:Date.now()+Math.floor(days*86400000)));
      await log({action,days});
    }else if(action==='set-created'){
      const at=Number(b.at);if(!Number.isSafeInteger(at)||at<1262304000000||at>Date.now())return res.status(400).json({error:'Invalid date'});
      await cmd('HSET',CREATED,id,String(at));await log({action,at});
    }else if(action!=='show')return res.status(400).json({error:'Unknown action'});
    return res.status(200).json({ok:true,id,verifiedBadges:await verifiedBadges(id),roles:await cmd('SMEMBERS',ROLES(id)),created:Number(await cmd('HGET',CREATED,id))||null});
  }catch(e){console.error('[admin]',e.message);return res.status(503).json({error:'Admin service unavailable'})}
};
