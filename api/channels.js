'use strict';
/* Mono Channels — настоящие каналы на сервере. Все действия требуют Mono ID + X-Mono-Token.
   Права проверяются здесь: клиентским owner/admin/subscriber доверять нельзя.
   POST { id, action, ... } → { ok, channel?, ... }
   Действия: create, mine, get, search, subscribe, unsubscribe, post, delete-post, like, comments, comment,
             delete-comment, update, add-admin, remove-admin, delete. */
const crypto=require('node:crypto');
const {cmd,batch}=require('../lib/redis');
const {authenticate,denyBody,ID}=require('../lib/auth');
const HDR={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,X-Mono-Token','Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8','X-Content-Type-Options':'nosniff'};
const P='mono:chan:v1:';
const META=c=>P+'c:'+c, POSTS=c=>P+'posts:'+c, POSTH=c=>P+'post:'+c, SUBS=c=>P+'subs:'+c, MY=id=>P+'my:'+id;
const LIKES=c=>P+'likes:'+c, LIKEDBY=(c,p)=>P+'likedby:'+c+':'+p, CMT=(c,p)=>P+'cm:'+c+':'+p, INDEX=P+'index', RL=(id,a)=>P+'rl:'+a+':'+id;
const CID=/^C-[a-f0-9]{20}$/, PID=/^[a-f0-9]{20}$/;
const MAX_OWNED=10,MAX_POSTS=300,MAX_COMMENTS=500,PAGE=60;
const rid=()=>crypto.randomBytes(10).toString('hex');
const clean=(s,n)=>typeof s==='string'?s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,n):'';
const color=v=>/^#[0-9a-f]{6}$/i.test(v||'')?v.toLowerCase():'#7b86ff';
const image=(v,max)=>typeof v==='string'&&v.length<=max&&/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v)?v:'';
const BIG=String.fromCodePoint(0x10ffff);
const err=(res,status,error)=>res.status(status).json({error});
const bool=(v,d)=>typeof v==='boolean'?v:d;
const settings=(s,old={})=>({comments:bool(s?.comments,old.comments??true),subscribersOnly:bool(s?.subscribersOnly,old.subscribersOnly??false),showCounts:bool(s?.showCounts,old.showCounts??true),reactions:bool(s?.reactions,old.reactions??true),listed:bool(s?.listed,old.listed??true)});
const isOwner=(c,id)=>c.owner===id, isAdmin=(c,id)=>c.owner===id||(c.admins||[]).includes(id);
async function rateLimit(id,action,ms){return (await cmd('SET',RL(id,action),'1','NX','PX',ms))==='OK'}
async function meta(cid){const raw=await cmd('GET',META(cid));try{return raw?JSON.parse(raw):null}catch(_){return null}}
const indexMember=(title,cid)=>clean(title,72).toLowerCase()+'\u0000'+cid;
/* Представление канала для конкретного пользователя: без списков чужих подписчиков. */
async function view(c,me,{before=0}={}){
  const max=before>0?'('+before:'+inf';
  const ids=await cmd('ZREVRANGEBYSCORE',POSTS(c.id),max,'-inf','LIMIT',0,PAGE);
  const [count,subscribed,...rest]=await batch([['SCARD',SUBS(c.id)],['SISMEMBER',SUBS(c.id),me],
    ...(ids.length?[['HMGET',POSTH(c.id),...ids],['HMGET',LIKES(c.id),...ids]]:[]),
    ...ids.map(p=>['ZCARD',CMT(c.id,p)]),...ids.map(p=>['SISMEMBER',LIKEDBY(c.id,p),me])]);
  const posts=[];
  if(ids.length){
    const raws=rest[0],likes=rest[1],counts=rest.slice(2,2+ids.length),mine=rest.slice(2+ids.length);
    ids.forEach((pid,i)=>{try{const p=JSON.parse(raws[i]);posts.push({...p,likes:Number(likes[i])||0,commentCount:Number(counts[i])||0,liked:!!mine[i]})}catch(_){}});
  }
  posts.sort((a,b)=>a.at-b.at);
  const full=isAdmin(c,me);
  return {id:c.id,title:c.title,bio:c.bio,accent:c.accent,cover:c.cover||'',owner:c.owner,admins:full||isOwner(c,me)?c.admins:[],createdAt:c.createdAt,
    settings:c.settings,subscriberCount:Number(count)||0,subscribers:subscribed?[me]:[],posts,hasMore:ids.length===PAGE,role:isOwner(c,me)?'owner':full?'admin':subscribed?'subscriber':'guest'};
}
module.exports=async(req,res)=>{
  for(const [k,v] of Object.entries(HDR))res.setHeader(k,v);
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='POST')return err(res,405,'Method not allowed');
  try{
    let b=req.body;if(typeof b==='string')b=JSON.parse(b);
    const id=String(b?.id||'').trim().toUpperCase(),action=String(b?.action||'');
    if(!ID.test(id)||!(await authenticate(req,id)))return res.status(403).json(denyBody(req,{error:'Invalid identity'}));
    if(action==='create'){
      const title=clean(b.title,72);if(!title)return err(res,400,'Введи название канала');
      const owned=Number(await cmd('SCARD',MY(id)+':owned'));if(owned>=MAX_OWNED)return err(res,400,'Можно создать не больше '+MAX_OWNED+' каналов');
      if(!(await rateLimit(id,'create',20000)))return err(res,429,'Подожди немного перед созданием следующего канала');
      const c={id:'C-'+rid(),title,bio:clean(b.bio,500),accent:color(b.accent),cover:image(b.cover,190000),owner:id,admins:[],settings:settings(b.settings),createdAt:Date.now()};
      await batch([['SET',META(c.id),JSON.stringify(c)],['SADD',SUBS(c.id),id],['SADD',MY(id),c.id],['SADD',MY(id)+':owned',c.id],
        ...(c.settings.listed?[['ZADD',INDEX,0,indexMember(title,c.id)]]:[])]);
      return res.status(200).json({ok:true,channel:await view(c,id)});
    }
    if(action==='mine'){
      const ids=(await cmd('SMEMBERS',MY(id)))||[];const out=[];
      for(const cid of ids.filter(x=>CID.test(x)).slice(0,60)){const c=await meta(cid);if(c)out.push(await view(c,id));else await cmd('SREM',MY(id),cid)}
      return res.status(200).json({ok:true,channels:out});
    }
    if(action==='search'){
      const q=clean(b.q,72).toLowerCase();
      if(CID.test(String(b.q||'').trim())){const c=await meta(String(b.q).trim());return res.status(200).json({ok:true,results:c?[{id:c.id,title:c.title,bio:c.bio,accent:c.accent}]:[]})}
      if(q.length<2)return res.status(200).json({ok:true,results:[]});
      const rows=await cmd('ZRANGEBYLEX',INDEX,'['+q,'['+q+BIG,'LIMIT',0,20)||[];
      const results=[];
      for(const row of rows){const cid=String(row).split('\u0000')[1];const c=CID.test(cid||'')?await meta(cid):null;if(c&&c.settings?.listed)results.push({id:c.id,title:c.title,bio:c.bio,accent:c.accent})}
      return res.status(200).json({ok:true,results});
    }
    const cid=String(b.channelId||'');if(!CID.test(cid))return err(res,400,'Неверный канал');
    const c=await meta(cid);if(!c)return err(res,404,'Канал не найден');
    if(action==='get')return res.status(200).json({ok:true,channel:await view(c,id,{before:Number(b.before)||0})});
    if(action==='subscribe'){
      await batch([['SADD',SUBS(cid),id],['SADD',MY(id),cid]]);return res.status(200).json({ok:true,channel:await view(c,id)});
    }
    if(action==='unsubscribe'){
      if(isOwner(c,id))return err(res,400,'Владелец не может отписаться — удалите канал');
      await batch([['SREM',SUBS(cid),id],['SREM',MY(id),cid]]);return res.status(200).json({ok:true,channel:await view(c,id)});
    }
    if(action==='post'){
      if(!isAdmin(c,id))return err(res,403,'Публиковать могут владелец и администраторы');
      const text=clean(b.text,8000);if(!text)return err(res,400,'Пустая публикация');
      if(!(await rateLimit(id,'post',1200)))return err(res,429,'Слишком часто');
      const p={id:rid(),text,at:Date.now(),from:id,color:color(b.color||c.accent)};
      await batch([['HSET',POSTH(cid),p.id,JSON.stringify(p)],['ZADD',POSTS(cid),p.at,p.id]]);
      const old=await cmd('ZRANGE',POSTS(cid),0,-MAX_POSTS-1);
      if(old?.length)await batch([['ZREM',POSTS(cid),...old],['HDEL',POSTH(cid),...old],['HDEL',LIKES(cid),...old]]);
      return res.status(200).json({ok:true,channel:await view(c,id)});
    }
    if(action==='delete-post'){
      if(!isAdmin(c,id))return err(res,403,'Нет прав');
      const pid=String(b.postId||'');if(!PID.test(pid))return err(res,400,'Неверная публикация');
      await batch([['ZREM',POSTS(cid),pid],['HDEL',POSTH(cid),pid],['HDEL',LIKES(cid),pid],['DEL',CMT(cid,pid)],['DEL',LIKEDBY(cid,pid)]]);
      return res.status(200).json({ok:true,channel:await view(c,id)});
    }
    if(action==='like'){
      const pid=String(b.postId||'');if(!PID.test(pid)||!c.settings.reactions)return err(res,400,'Реакции недоступны');
      if(!(await cmd('HEXISTS',POSTH(cid),pid)))return err(res,404,'Публикация не найдена');
      if(!(await rateLimit(id,'like',400)))return err(res,429,'Слишком часто');
      const added=Number(await cmd('SADD',LIKEDBY(cid,pid),id))===1;
      if(!added)await cmd('SREM',LIKEDBY(cid,pid),id);
      await cmd('HINCRBY',LIKES(cid),pid,added?1:-1);
      return res.status(200).json({ok:true,channel:await view(c,id)});
    }
    if(action==='comments'){
      const pid=String(b.postId||'');if(!PID.test(pid))return err(res,400,'Неверная публикация');
      const rows=(await cmd('ZRANGE',CMT(cid,pid),-100,-1))||[];
      return res.status(200).json({ok:true,comments:rows.map(r=>{try{return JSON.parse(r)}catch(_){return null}}).filter(Boolean)});
    }
    if(action==='comment'){
      const pid=String(b.postId||'');if(!PID.test(pid))return err(res,400,'Неверная публикация');
      const subscribed=Number(await cmd('SISMEMBER',SUBS(cid),id))===1;
      if(!c.settings.comments||(c.settings.subscribersOnly&&!subscribed&&!isAdmin(c,id)))return err(res,403,'Комментарии недоступны');
      const text=clean(b.text,1800);if(!text)return err(res,400,'Пустой комментарий');
      if(!(await cmd('HEXISTS',POSTH(cid),pid)))return err(res,404,'Публикация не найдена');
      if(!(await rateLimit(id,'comment',1500)))return err(res,429,'Слишком часто');
      const at=Date.now(),item={id:rid(),author:id,text,at};
      await cmd('ZADD',CMT(cid,pid),at,JSON.stringify(item));
      const extra=await cmd('ZRANGE',CMT(cid,pid),0,-MAX_COMMENTS-1);if(extra?.length)await cmd('ZREM',CMT(cid,pid),...extra);
      return res.status(200).json({ok:true,comment:item,channel:await view(c,id)});
    }
    if(action==='delete-comment'){
      const pid=String(b.postId||''),commentId=String(b.commentId||'');if(!PID.test(pid)||!PID.test(commentId))return err(res,400,'Неверный комментарий');
      const rows=(await cmd('ZRANGE',CMT(cid,pid),0,-1))||[];
      const hit=rows.find(r=>{try{return JSON.parse(r).id===commentId}catch(_){return false}});
      if(!hit)return err(res,404,'Комментарий не найден');
      if(!isAdmin(c,id)&&JSON.parse(hit).author!==id)return err(res,403,'Нет прав');
      await cmd('ZREM',CMT(cid,pid),hit);return res.status(200).json({ok:true,channel:await view(c,id)});
    }
    if(action==='update'){
      if(!isOwner(c,id))return err(res,403,'Настройки доступны только владельцу');
      const title=clean(b.title,72);if(!title)return err(res,400,'Название не может быть пустым');
      const next={...c,title,bio:clean(b.bio,500),accent:color(b.accent),cover:b.cover===undefined?c.cover:image(b.cover,190000),settings:settings(b.settings,c.settings)};
      const cmds=[['SET',META(cid),JSON.stringify(next)],['ZREM',INDEX,indexMember(c.title,cid)]];
      if(next.settings.listed)cmds.push(['ZADD',INDEX,0,indexMember(title,cid)]);
      await batch(cmds);return res.status(200).json({ok:true,channel:await view(next,id)});
    }
    if(action==='add-admin'||action==='remove-admin'){
      if(!isOwner(c,id))return err(res,403,'Только владелец назначает администраторов');
      const target=String(b.adminId||'').trim().toUpperCase();if(!ID.test(target)||target===id)return err(res,400,'Введи Mono ID другого пользователя');
      const admins=new Set(c.admins||[]);
      if(action==='add-admin'){if(admins.size>=20)return err(res,400,'Слишком много администраторов');admins.add(target)}else admins.delete(target);
      const next={...c,admins:[...admins]};
      await batch([['SET',META(cid),JSON.stringify(next)],...(action==='add-admin'?[['SADD',MY(target),cid]]:[])]);
      return res.status(200).json({ok:true,channel:await view(next,id)});
    }
    if(action==='delete'){
      if(!isOwner(c,id))return err(res,403,'Удалить канал может только владелец');
      const ids=(await cmd('ZRANGE',POSTS(cid),0,-1))||[];
      await batch([['DEL',META(cid)],['DEL',POSTS(cid)],['DEL',POSTH(cid)],['DEL',LIKES(cid)],['DEL',SUBS(cid)],['ZREM',INDEX,indexMember(c.title,cid)],
        ['SREM',MY(id),cid],['SREM',MY(id)+':owned',cid],...ids.flatMap(p=>[['DEL',CMT(cid,p)],['DEL',LIKEDBY(cid,p)]])]);
      return res.status(200).json({ok:true,deleted:cid});
    }
    return err(res,400,'Unknown channels action');
  }catch(e){console.error('[channels]',e.message);return err(res,503,'Channels service unavailable')}
};
