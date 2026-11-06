'use strict';
/* Блокировки аккаунтов. Бан не добавляет НИ ОДНОЙ лишней команды в обычные запросы:
   значение ключа владельца mono:acct:v1:owner:<id> меняется на «banned:<прежний хэш токена>», поэтому обычная проверка
   токена просто перестаёт совпадать. Причина/срок лежат в хэше mono:adm:v1:bans и читаются только когда аккаунт заблокирован. */
const {cmd}=require('./redis');
const OWNER=id=>'mono:acct:v1:owner:'+id;
const BANS='mono:adm:v1:bans';
const SESSION=id=>'mono:r3:auth:'+id;
const QUEUE='mono:chess:v1:queue';
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
async function ban(id,{reason='',until=0,by=''}={}){
  const rec={reason:String(reason).slice(0,300),at:Date.now(),until:Number(until)||0,by:String(by).slice(0,40)};
  return Number(await cmd('EVAL',LUA_BAN,4,OWNER(id),BANS,SESSION(id),QUEUE,id,JSON.stringify(rec)))===1;
}
async function unban(id){return Number(await cmd('EVAL',LUA_UNBAN,2,OWNER(id),BANS,id))===1}
/* Действующая блокировка (или null). Просроченный временный бан снимается автоматически. */
async function current(id){
  const rec=parse(await cmd('HGET',BANS,id));
  if(!rec)return null;
  if(rec.until&&rec.until<=Date.now()){await unban(id);return null}
  return rec;
}
const payload=rec=>({error:'Аккаунт заблокирован'+(rec?.reason?': '+rec.reason:''),banned:true,reason:rec?.reason||'',until:rec?.until||0,code:'banned'});
module.exports={ban,unban,current,payload,BANS};
