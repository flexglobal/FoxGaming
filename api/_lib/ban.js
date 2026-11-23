'use strict';
/* Блокировки аккаунтов. Бан не добавляет НИ ОДНОЙ лишней команды в обычные запросы:
   значение ключа владельца mono:acct:v1:owner:<id> меняется на «banned:<прежний хэш токена>», поэтому обычная проверка
   токена просто перестаёт совпадать — все сервисы Mono (мессенджер, шахматы, кошелёк, профиль…) сразу отказывают.
   Причина/срок лежат в хэше mono:adm:v1:bans и читаются только когда аккаунт заблокирован.

   Привязка к устройству: клиент присылает хэш устройства (sha256 от серийного номера платы или от id установки,
   сам серийный номер на сервер не уходит). Хэши устройств заблокированного аккаунта лежат в mono:adm:v1:banhw —
   новый Mono ID с того же компьютера (переустановка, удалённые данные) блокируется автоматически.

   Апелляции: одна в неделю. Попытки отправить чаще (спам) копятся; 3 попытки в период ожидания делают бан
   перманентным без права апелляции. Перманентный бан без апелляций может выдать и администратор. */
const crypto=require('node:crypto');
const {cmd}=require('./redis');
const OWNER=id=>'mono:acct:v1:owner:'+id;
const BANS='mono:adm:v1:bans';
const BAN_HW='mono:adm:v1:banhw';          // хэш устройства → заблокированный Mono ID
const DEVICE_HW='mono:acct:v1:hw';         // Mono ID → последний хэш устройства
const APPEALS='mono:adm:v1:appeals', APPEAL_IDX='mono:adm:v1:appeals:idx';
const SESSION=id=>'mono:r3:auth:'+id;
const QUEUE='mono:chess:v1:queue';
const WEEK=7*86400000, SPAM_STRIKES=3, APPEAL_KEEP=2000;
const HW=/^[a-f0-9]{64}$/;
const LUA_BAN=`
local o=redis.call('GET',KEYS[1])
if o and string.sub(o,1,7)=='banned:' then return 0 end
local rec=cjson.decode(ARGV[2])
rec.prev=o or ''
redis.call('HSET',KEYS[2],ARGV[1],cjson.encode(rec))
redis.call('SET',KEYS[1],'banned:'..(o or ''))
redis.call('DEL',KEYS[3])
redis.call('ZREM',KEYS[4],ARGV[1])
return 1`;
const LUA_UNBAN=`
local raw=redis.call('HGET',KEYS[2],ARGV[1])
local o=redis.call('GET',KEYS[1])
if o and string.sub(o,1,7)=='banned:' then
  local prev=''
  if raw then prev=cjson.decode(raw).prev or '' end
  if prev=='' then prev=string.sub(o,8) end
  if prev~='' then redis.call('SET',KEYS[1],prev) else redis.call('DEL',KEYS[1]) end
end
redis.call('HDEL',KEYS[2],ARGV[1])
if raw or (o and string.sub(o,1,7)=='banned:') then return 1 end
return 0`;
const parse=raw=>{try{return JSON.parse(raw)}catch(_){return null}};
const save=(id,rec)=>cmd('HSET',BANS,id,JSON.stringify(rec));
async function linkHw(id,rec,hw){
  if(!HW.test(hw||''))return;
  rec.hws=Array.isArray(rec.hws)?rec.hws:[];
  if(rec.hws.includes(hw)){await cmd('HSET',BAN_HW,hw,id);return}
  // Не больше 10 устройств на бан: заблокированный не может «засорить» базу или привязать чужие устройства без конца.
  if(rec.hws.length>=10)return;
  rec.hws=rec.hws.concat(hw);await save(id,rec);
  await cmd('HSET',BAN_HW,hw,id);
}
/* Бан. Если аккаунт уже заблокирован — обновляет причину/срок/перманентность. */
async function ban(id,{reason='',until=0,by='',perm=false,linked=''}={}){
  const rec={reason:String(reason).slice(0,300),at:Date.now(),until:Number(until)||0,by:String(by).slice(0,60),perm:!!perm};
  if(linked)rec.linked=String(linked);
  const done=Number(await cmd('EVAL',LUA_BAN,4,OWNER(id),BANS,SESSION(id),QUEUE,id,JSON.stringify(rec)))===1;
  let cur=parse(await cmd('HGET',BANS,id));
  if(!done&&cur){Object.assign(cur,{reason:rec.reason,until:rec.until,by:rec.by,perm:rec.perm||!!cur.perm&&cur.permReason==='spam'});await save(id,cur)}
  if(cur){const hw=await cmd('HGET',DEVICE_HW,id);if(hw)await linkHw(id,cur,hw)}
  return done;
}
async function unban(id,{cascade=true}={}){
  const rec=parse(await cmd('HGET',BANS,id));
  const done=Number(await cmd('EVAL',LUA_UNBAN,2,OWNER(id),BANS,id))===1;
  for(const hw of (rec&&rec.hws)||[]){if(await cmd('HGET',BAN_HW,hw)===id)await cmd('HDEL',BAN_HW,hw)}
  if(cascade){
    // аккаунты, заблокированные автоматически за обход этого бана, разблокируются вместе с ним
    const all=await cmd('HGETALL',BANS)||[];
    for(let i=0;i+1<all.length;i+=2){const r=parse(all[i+1]);if(r&&r.linked===id)await unban(all[i],{cascade:false})}
  }
  return done;
}
/* Действующая блокировка (или null). Просроченный временный бан снимается автоматически. */
async function current(id){
  const rec=parse(await cmd('HGET',BANS,id));
  if(!rec)return null;
  if(rec.until&&rec.until<=Date.now()){await unban(id);return null}
  return rec;
}
const payload=rec=>({error:'Аккаунт заблокирован'+(rec?.reason?': '+rec.reason:''),banned:true,reason:rec?.reason||'',until:rec?.until||0,at:rec?.at||0,perm:!!rec?.perm,code:'banned'});

/* Что видит заблокированный пользователь на экране бана. */
async function info(id,rec){
  let last=null;
  if(rec.lastAppealId){const a=parse(await cmd('HGET',APPEALS,rec.lastAppealId));if(a)last={status:a.status,at:a.at,note:a.note||'',decidedAt:a.decidedAt||0}}
  const nextAt=rec.lastAppealAt?rec.lastAppealAt+WEEK:0;
  const pending=!!(last&&last.status==='new');
  return {banned:true,id,at:rec.at||0,until:rec.until||0,reason:rec.reason||'',perm:!!rec.perm,permReason:rec.permReason||'',
    linked:rec.linked?true:false,appeal:{allowed:!rec.perm,canAppeal:!rec.perm&&!pending&&Date.now()>=nextAt,nextAt,pending,last}};
}
/* Проверка при запуске браузера и раз в несколько минут. ok — токен совпал (аккаунт не заблокирован). */
async function status(req,id,hw,ok){
  hw=HW.test(hw||'')?hw:'';
  if(req.monoBan){const rec=await current(id);if(rec){if(hw)await linkHw(id,rec,hw);return info(id,rec)}return {banned:false}}
  if(!ok)return null;
  if(hw){
    await cmd('HSET',DEVICE_HW,id,hw);
    const other=await cmd('HGET',BAN_HW,hw);
    if(other&&other!==id){
      const src=await current(other);
      if(src){
        // тот же компьютер, новый Mono ID — это обход бана
        await ban(id,{reason:src.reason,until:src.until,by:'Mono: обход блокировки '+other,perm:!!src.perm,linked:other});
        const rec=await current(id);if(rec)return info(id,rec);
      }else await cmd('HDEL',BAN_HW,hw);
    }
  }
  return {banned:false};
}
const cleanText=t=>typeof t==='string'?t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim():'';
class AppealError extends Error{constructor(code,msg,extra){super(msg);this.status=code;this.extra=extra||{}}}
async function appeal(req,id,text){
  if(!req.monoBan)throw new AppealError(403,'Аккаунт не заблокирован или ключ установки не совпадает');
  const rec=await current(id);if(!rec)throw new AppealError(409,'Блокировка уже снята — перезапусти Mono');
  if(rec.perm)throw new AppealError(403,rec.permReason==='spam'?'Апелляции закрыты: бан стал перманентным из-за спама апелляциями':'Это перманентная блокировка — апелляции недоступны',{info:await info(id,rec)});
  const now=Date.now();
  const pendingRaw=rec.lastAppealId?parse(await cmd('HGET',APPEALS,rec.lastAppealId)):null;
  if((rec.lastAppealAt&&now<rec.lastAppealAt+WEEK)||(pendingRaw&&pendingRaw.status==='new')){
    rec.strikes=(rec.strikes||0)+1;
    if(rec.strikes>=SPAM_STRIKES){rec.perm=true;rec.permReason='spam';rec.permAt=now;await save(id,rec);
      throw new AppealError(403,'Слишком много попыток отправить апелляцию. Бан стал перманентным, апелляции больше недоступны.',{info:await info(id,rec)})}
    await save(id,rec);
    throw new AppealError(429,'Апелляцию можно подавать один раз в неделю. Повторные попытки считаются спамом: после '+SPAM_STRIKES+' бан станет перманентным (осталось попыток: '+(SPAM_STRIKES-rec.strikes)+').',{info:await info(id,rec)});
  }
  text=cleanText(text);
  if(text.length<10)throw new AppealError(400,'Опиши ситуацию подробнее (от 10 символов)');
  if(text.length>1500)throw new AppealError(413,'Слишком длинный текст — до 1500 символов');
  const aid=crypto.randomUUID();
  const a={aid,id,text,at:now,status:'new',ban:{reason:rec.reason||'',at:rec.at||0,until:rec.until||0,by:rec.by||''}};
  await cmd('HSET',APPEALS,aid,JSON.stringify(a));await cmd('ZADD',APPEAL_IDX,now,aid);
  const n=Number(await cmd('ZCARD',APPEAL_IDX));
  if(n>APPEAL_KEEP){const old=await cmd('ZRANGE',APPEAL_IDX,0,n-APPEAL_KEEP-1)||[];for(const x of old){await cmd('HDEL',APPEALS,x);await cmd('ZREM',APPEAL_IDX,x)}}
  rec.lastAppealAt=now;rec.lastAppealId=aid;rec.strikes=0;await save(id,rec);
  return info(id,rec);
}
module.exports={ban,unban,current,payload,info,status,appeal,AppealError,BANS,BAN_HW,DEVICE_HW,APPEALS,APPEAL_IDX,WEEK,SPAM_STRIKES};
