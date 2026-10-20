'use strict';
/* Authoritative chess service for Mono. Clients never submit FEN, time or ELO.
   Requires same installation identity + Upstash credentials as Messenger. */
const crypto=require('node:crypto');
const C=require('../lib/chess-engine');
const ID=/^MONO-[A-F0-9]{20}$/;
const ROOM=/^MC-[A-F0-9]{24}$/;
const PREFIX='mono:chess:v1:';
const RATING_KEY=PREFIX+'ratings';
const pairKey=(a,b)=>PREFIX+'repeat:'+crypto.createHash('sha256').update([a,b].sort().join('|')).digest('hex');
const QUEUE=PREFIX+'queue';
const HEADERS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,X-Mono-Token','Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const redisURL=()=>String(process.env.UPSTASH_REDIS_REST_URL||'').replace(/\/$/,'');
const redisToken=()=>String(process.env.UPSTASH_REDIS_REST_TOKEN||'');
async function command(...args){
  if(!redisURL()||!redisToken())throw Error('Redis не настроен');
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),6000);
  try{const response=await fetch(redisURL(),{method:'POST',headers:{Authorization:'Bearer '+redisToken(),'Content-Type':'application/json'},body:JSON.stringify(args),signal:abort.signal});if(!response.ok)throw Error('Redis '+response.status);const result=await response.json();if(result.error)throw Error('Redis '+result.error);return result.result;}finally{clearTimeout(timer)}
}
const key=n=>PREFIX+n;
const json=async n=>{const v=await command('GET',key(n));return v?JSON.parse(v):null};
const save=async (n,v,seconds=172800)=>command('SET',key(n),JSON.stringify(v),'EX',seconds);
const reply=(res,status,value)=>res.status(status).json(value);
const clean=id=>String(id||'').trim().toUpperCase();
async function auth(req,id){
 const token=req.headers?.['x-mono-token'];if(typeof token!=='string'||token.length<24||token.length>256)return false;
 const digest=crypto.createHash('sha256').update(token).digest('hex');
 const recorded=await command('GET','mono:r3:auth:'+id);
 if(recorded!==digest)return false;
 // Identity ownership is pinned permanently in Chess, even when the short-
 // lived Messenger auth expires. Prevents rebinding known ELO identities.
 const permanent=key('owner:'+id);
 const owner=await command('GET',permanent);
 if(owner)return owner===digest;
 await command('SET',permanent,digest,'NX');
 return await command('GET',permanent)===digest;
}
async function lock(name,task){
  const lk=key('lock:'+name),token=crypto.randomBytes(12).toString('hex');
  if(await command('SET',lk,token,'NX','PX',30000)!=='OK')return {busy:true};
  try{return await task();}finally{await command('EVAL','if redis.call("GET",KEYS[1]) == ARGV[1] then return redis.call("DEL",KEYS[1]) else return 0 end',1,lk,token).catch(()=>{});}
}
const rank=points=>points<200?'Железо':points<=500?'Бронза':points<=900?'Серебро':points<=1500?'Золото':points<=2000?'Платина':points<=2750?'Алмаз':points<4000?'Рассвет':'Грандмастер';
function diff(points,win){if(points<=900)return win?50:-10;if(points<=1500)return win?50:-15;if(points<=2000)return win?45:-30;if(points<=2750)return win?40:-35;if(points<4000)return win?40:-40;return win?30:-50;}
async function rating(id){const v=await command('ZSCORE',RATING_KEY,id);return v===null?200:Math.max(200,Math.min(100000,Number(v)||200));}
async function ensureRating(id){await command('ZADD',RATING_KEY,'NX',200,id)}
function view(g,id){return {id:g.id,mode:g.rated?'ranked':'friend',rated:!!g.rated,white:g.white,black:g.black,side:g.white===id?'w':'b',fen:C.fen(g.state),state:g.state,turn:g.state.turn,seq:g.seq,clocks:g.clocks,seconds:g.seconds,clockAt:g.clockAt,started:g.started,finished:g.finished,winner:g.winner,reason:g.reason,votes:g.rematchVotes?.length||0,updatedAt:g.updatedAt};}
async function active(id){const gid=await command('GET',key('active:'+id));return ROOM.test(gid||'')?gid:null}
async function settle(g,reason,winner){
  if(g.finished)return;
  g.finished=true;g.winner=winner||null;g.reason=reason;g.started=false;g.updatedAt=Date.now();
  if(winner&&g.rated){
    // Apply both ELO changes AND the settlement marker as ONE Redis operation.
    // Replays and server crashes cannot double-credit a completed match.
    const L=`
      if redis.call('EXISTS', KEYS[2])==1 then
        return {0,tonumber(redis.call('ZSCORE',KEYS[1],ARGV[1]) or 200),tonumber(redis.call('ZSCORE',KEYS[1],ARGV[2]) or 200)}
      end
      local function delta(p,win)
        if p <= 900 then return win and 50 or -10 end
        if p <= 1500 then return win and 50 or -15 end
        if p <= 2000 then return win and 45 or -30 end
        if p <= 2750 then return win and 40 or -35 end
        if p < 4000 then return win and 40 or -40 end
        return win and 30 or -50
      end
      local w=tonumber(redis.call('ZSCORE',KEYS[1],ARGV[1]) or 200)
      local b=tonumber(redis.call('ZSCORE',KEYS[1],ARGV[2]) or 200)
      local nw=math.max(200,w+delta(w,ARGV[3]=='w'))
      local nb=math.max(200,b+delta(b,ARGV[3]=='b'))
      redis.call('ZADD',KEYS[1],nw,ARGV[1],nb,ARGV[2])
      redis.call('SET',KEYS[2],'1','EX',604800)
      return {1,nw,nb}
    `;
    const [applied,nw,nb]=await command('EVAL',L,2,RATING_KEY,key('settled:'+g.id),g.white,g.black,winner);
    if(applied){g.ratingApplied=true;await command('SET',pairKey(g.white,g.black),'1','EX',300);}
  }
  await command('DEL',key('active:'+g.white));await command('DEL',key('active:'+g.black));
}
function elapsedClock(g){
  if(!g.started||g.finished||!g.seconds)return;
  const n=Date.now(),dt=Math.max(0,Math.min(86400000,n-g.clockAt));
  g.clocks[g.state.turn]=Math.max(0,g.clocks[g.state.turn]-dt);g.clockAt=n;
}
async function progress(g){
  if(g.started&&!g.finished){elapsedClock(g);if(g.seconds&&g.clocks[g.state.turn]===0)await settle(g,'Время истекло',C.enemy(g.state.turn));}
}
async function gameFor(id){const gid=await active(id);if(!gid)return null;const g=await json('match:'+gid);return g&&(g.white===id||g.black===id)?g:null}
const MAX_NAME=48;
module.exports=async(req,res)=>{
  for(const [k,v] of Object.entries(HEADERS))res.setHeader(k,v);
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='POST')return reply(res,405,{error:'Method not allowed'});
  try{
    const b=req.body||{};const id=clean(b.id),action=String(b.action||'');
    if(!ID.test(id)||!(await auth(req,id)))return reply(res,403,{error:'Проверка Mono ID не пройдена'});
    // Optional, authenticated country preference. User's choice only changes display, not ELO.
    if(action==='set-country'){
      const allowed=new Set(['unknown','KZ','RU','UA','US','CA','DE','FR','GB','NO','PL','NL','CN','IN','BR','AM','AZ','UZ','IT','ES','auto']);
      const requested=String(b.country||'unknown');
      if(!allowed.has(requested))return reply(res,400,{error:'Недопустимая страна'});
      // Geo header is used only when the user explicitly chooses Auto.
      const geo=String(req.headers?.['x-vercel-ip-country']||'').toUpperCase();
      const value=requested==='auto'?(allowed.has(geo)?geo:'unknown'):requested;
      await command('HSET',key('countries'),id,value);
      return reply(res,200,{ok:true,country:value});
    }
    if(action==='set-profile'){
      // Same visible nickname as local Messenger, including Unicode letters and emoji.
      // The chess server owns the rating; this changes only the authenticated player's display name.
      const nickname=String(b.nickname||'').trim().replace(/\s+/g,' ');
      if(!nickname||Array.from(nickname).length>48||/[\u0000-\u001f\u007f<>]/u.test(nickname))return reply(res,400,{error:'Ник Messenger должен быть от 1 до 48 символов'});
      await command('HSET',key('nicknames'),id,nickname);
      return reply(res,200,{ok:true,nickname});
    }
    if(action==='leaderboard'){
      // 101 REAL registered players, no generated ranks or fabricated entries.
      const ids=await command('ZREVRANGE',RATING_KEY,0,100,'WITHSCORES')||[];
      const users=[];for(let i=0;i<ids.length;i+=2)users.push({position:i/2+1,id:ids[i],elo:Number(ids[i+1]),tier:rank(Number(ids[i+1]))});
      const countryKey=key('countries');
      const countries=users.length?await command('HMGET',countryKey,...users.map(u=>u.id)):[];
      const nicknames=users.length?await command('HMGET',key('nicknames'),...users.map(u=>u.id)):[];
      for(let i=0;i<users.length;i++){
        users[i].country=typeof countries?.[i]==='string'?countries[i]:'unknown';
        users[i].name=typeof nicknames?.[i]==='string'?nicknames[i]:null;
      }
      const pos=await command('ZREVRANK',RATING_KEY,id),elo=await rating(id),myCountry=await command('HGET',countryKey,id),myName=await command('HGET',key('nicknames'),id);
      const total=Number(await command('ZCARD',RATING_KEY))||0;
      return reply(res,200,{ok:true,leaders:users,total,me:{id,elo,tier:rank(elo),position:pos===null?null:Number(pos)+1,country:myCountry||'unknown',name:myName||null},updatedAt:Date.now()});
    }
    if(action==='friend-create'){
      const friend=clean(b.friendId),side=b.side==='b'?'b':'w';
      const seconds=Number(b.seconds);
      if(!ID.test(friend)||friend===id||![0,180,300,600,900].includes(seconds))return reply(res,400,{error:'Неверное приглашение'});
      const result=await lock('friend-create:'+id,async()=>{
        if(await active(id))return {error:'Сначала заверши активную партию'};
        if(await active(friend))return {error:'Друг уже играет'};
        const gid='MC-'+crypto.randomBytes(12).toString('hex').toUpperCase(),now=Date.now();
        const state=C.start();state.counts[C.signature(state)]=1;
        const g={id:gid,white:side==='w'?id:friend,black:side==='b'?id:friend,rated:false,state,seq:0,
          seconds,clocks:{w:seconds*1000,b:seconds*1000},clockAt:now,started:false,finished:false,
          winner:null,reason:'',updatedAt:now,createdAt:now};
        await save('match:'+gid,g);await command('SET',key('active:'+id),gid,'EX',600);
        // Do not reserve the invited user until they have accepted.
        return {ok:true,match:view(g,id)};
      });return reply(res,result.busy?409:result.error?400:200,result);
    }
    if(action==='friend-cancel'){
      const gid=String(b.matchId||'');if(!ROOM.test(gid))return reply(res,400,{error:'Invalid match'});
      const result=await lock('game:'+gid,async()=>{
        const g=await json('match:'+gid);if(!g||g.rated||![g.white,g.black].includes(id)||g.started)return {error:'Нельзя отменить начавшуюся партию'};
        await command('DEL',key('active:'+g.white));await command('DEL',key('active:'+g.black));
        await command('DEL',key('match:'+gid));return {ok:true};
      });return reply(res,result.busy?409:result.error?400:200,result);
    }
    if(action==='friend-join'){
      const gid=String(b.matchId||'');if(!ROOM.test(gid))return reply(res,400,{error:'Неизвестная комната'});
      const result=await lock('game:'+gid,async()=>{
        const g=await json('match:'+gid);
        if(!g||g.rated||![g.white,g.black].includes(id)||g.finished)return {error:'Приглашение недействительно'};
        if(await active(id)&&await active(id)!==gid)return {error:'Сначала заверши другую партию'};
        if(!g.started){g.started=true;g.clockAt=Date.now();g.updatedAt=g.clockAt;await command('SET',key('active:'+id),gid,'EX',172800);await command('SET',key('active:'+(g.white===id?g.black:g.white)),gid,'EX',172800);await save('match:'+gid,g);}
        return {ok:true,match:view(g,id)};
      });return reply(res,result.busy?409:result.error?400:200,result);
    }
    if(action==='rematch'){
      const gid=String(b.matchId||'');if(!ROOM.test(gid))return reply(res,400,{error:'Неверная комната'});
      const result=await lock('game:'+gid,async()=>{
        const g=await json('match:'+gid);
        if(!g||g.rated||![g.white,g.black].includes(id)||!g.finished)return {error:'Голосование сейчас недоступно'};
        if(!g.rematchVotes)g.rematchVotes=[];
        if(!g.rematchVotes.includes(id))g.rematchVotes.push(id);
        if(g.rematchVotes.length>=2){
          [g.white,g.black]=[g.black,g.white];g.state=C.start();g.state.counts[C.signature(g.state)]=1;
          g.seq=0;g.clocks={w:g.seconds*1000,b:g.seconds*1000};g.clockAt=Date.now();g.started=true;
          g.finished=false;g.winner=null;g.reason='';g.rematchVotes=[];g.updatedAt=Date.now();
          await command('SET',key('active:'+g.white),g.id,'EX',172800);
          await command('SET',key('active:'+g.black),g.id,'EX',172800);
        }
        await save('match:'+gid,g);return {ok:true,match:view(g,id),votes:g.rematchVotes?.length||0};
      });return reply(res,result.busy?409:result.error?400:200,result);
    }
    if(action==='cancel'){
      await command('ZREM',QUEUE,id);return reply(res,200,{ok:true});
    }
    if(action==='queue'){
      const result=await lock('matchmaker',async()=>{
        const existing=await gameFor(id);if(existing)return {ok:true,match:view(existing,id)};
        await ensureRating(id);
        const now=Date.now(),waiting=await command('ZRANGE',QUEUE,0,25,'WITHSCORES')||[];
        let candidate=null;
        for(let i=0;i<waiting.length;i+=2){const p=waiting[i],ts=Number(waiting[i+1]);if(p===id)continue;
          if(!ID.test(p)||now-ts>30000||await active(p)){await command('ZREM',QUEUE,p);continue;}
          if(await command('GET',pairKey(id,p)))continue;
          candidate=p;break;
        }
        if(!candidate){await command('ZADD',QUEUE,now,id);return {ok:true,searching:true};}
        const gameId='MC-'+crypto.randomBytes(12).toString('hex').toUpperCase();
        const white=crypto.randomInt(2)===0?id:candidate,black=white===id?candidate:id;
        const s=C.start();s.counts[C.signature(s)]=1;
        const g={id:gameId,white,black,rated:true,state:s,seq:0,seconds:600,clocks:{w:600000,b:600000},clockAt:now,started:true,finished:false,winner:null,reason:'',updatedAt:now};
        await save('match:'+gameId,g);
        await command('SET',key('active:'+white),gameId,'EX',172800);
        await command('SET',key('active:'+black),gameId,'EX',172800);
        await command('ZREM',QUEUE,id,candidate);
        return {ok:true,match:view(g,id)};
      });return reply(res,result.busy?409:200,result);
    }
    if(action==='state'||action==='move'||action==='resign'){
      const gid=String(b.matchId||await active(id)||'');if(!ROOM.test(gid))return reply(res,404,{error:'Активной партии нет'});
      const result=await lock('game:'+gid,async()=>{
        const g=await json('match:'+gid);if(!g||![g.white,g.black].includes(id))return {error:'Партия не найдена'};
        await progress(g);
        if(action==='move'){
          if(g.finished)return {ok:true,match:view(g,id)};
          if(!g.started||g.state.turn!==(g.white===id?'w':'b'))return {error:'Сейчас не твой ход'};
          if(!Number.isSafeInteger(b.seq)||b.seq!==g.seq)return {error:'Позиция устарела',match:view(g,id)};
          if(typeof b.uci!=='string'||!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(b.uci))return {error:'Неверный формат хода'};
          const a=C.fromCoord(b.uci.slice(0,2)),to=C.fromCoord(b.uci.slice(2,4));
          const m=C.move(g.state,a,to,b.uci[4]||'q');if(!m)return {error:'Недопустимый ход',match:view(g,id)};
          g.state=m.state;g.seq++;g.updatedAt=Date.now();
          const outcome=C.outcome(g.state);if(outcome.over)await settle(g,outcome.reason,outcome.winner);
        }
        if(action==='resign'&&!g.finished){await settle(g,'Сдача',g.white===id?'b':'w');}
        await save('match:'+gid,g);
        return {ok:true,match:view(g,id)};
      });return reply(res,result.busy?409:result.error?400:200,result);
    }
    return reply(res,400,{error:'Unknown chess action'});
  }catch(e){console.error('[mono chess]',e);return reply(res,503,{error:'Шахматный сервер временно недоступен'});}
};
module.exports._internal={rank,diff,progress};
