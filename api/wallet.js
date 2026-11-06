'use strict';
/* Mono Wallet — серебряные монеты и подарки. Сервер — единственный источник истины.
   Защита от дюпа:
   • каждое изменение баланса — ОДИН атомарный Lua-скрипт (проверка + списание + выдача), без гонок между запросами;
   • каждая операция требует одноразовый ключ идемпотентности: повтор/дубль запроса возвращает прежний результат и ничего не меняет;
   • подарок — запись с серверным uid в инвентаре одного владельца; продать/получить деньги за него можно ровно один раз;
   • цены, награды уровней и 70 % возврата определяет сервер; клиентские числа игнорируются;
   • лимиты: 60 отправок/час на аккаунт, 60 наград/сутки на IP, не более 500 подарков в инвентаре.
   POST { id, action, key?, ... } → { ok, balance, ... }
   Действия: state, claim-level {level}, send-gift {to, gift}, sell-gift {uid}. */
const crypto=require('node:crypto');
const {cmd}=require('../lib/redis');
const {authenticate,denyBody,ID,OWNER,CREATED}=require('../lib/auth');
const {GIFTS,LEVEL_SILVER,SELL_HOLD_MS,SELL_PERCENT}=require('../lib/gifts');
const HDR={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,X-Mono-Token','Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8','X-Content-Type-Options':'nosniff'};
const P='mono:wal:v1:';
const BAL=id=>P+'bal:'+id, CLAIMED=id=>P+'claimed:'+id, INV=id=>P+'inv:'+id, GONE=id=>P+'gone:'+id, LED=id=>P+'led:'+id;
const IDEM=(id,k)=>P+'idem:'+id+':'+k, RATE=id=>P+'rate:send:'+id;
const KEY=/^[A-Za-z0-9_-]{16,64}$/;
const MAX_INV=500, SEND_PER_HOUR=60, CLAIMS_PER_IP_DAY=60, MIN_ACCOUNT_AGE_MS=20000, GONE_TTL=30*86400, LED_MAX=100;
const err=(res,status,error,extra)=>res.status(status).json({error,...extra});

/* ---- Lua ---- */
const LUA_CLAIM=`
local prev=redis.call('GET',KEYS[1]); if prev then return prev end
if redis.call('HSETNX',KEYS[2],ARGV[1],ARGV[3])==0 then
  return cjson.encode({ok=false,error='already',balance=tonumber(redis.call('GET',KEYS[3])) or 0})
end
local nb=redis.call('INCRBY',KEYS[3],tonumber(ARGV[2]))
redis.call('LPUSH',KEYS[4],cjson.encode({t='claim',a=tonumber(ARGV[2]),ts=tonumber(ARGV[3]),ref='L'..ARGV[1]}))
redis.call('LTRIM',KEYS[4],0,tonumber(ARGV[4])-1)
local res=cjson.encode({ok=true,balance=nb,level=tonumber(ARGV[1]),amount=tonumber(ARGV[2])})
redis.call('SET',KEYS[1],res,'EX',86400)
return res`;
const LUA_SEND=`
local prev=redis.call('GET',KEYS[1]); if prev then return prev end
local n=redis.call('INCR',KEYS[5]); if n==1 then redis.call('EXPIRE',KEYS[5],3600) end
if n>tonumber(ARGV[7]) then return cjson.encode({ok=false,error='rate'}) end
if redis.call('EXISTS',KEYS[6])==0 then return cjson.encode({ok=false,error='norecipient'}) end
if redis.call('HLEN',KEYS[3])>=tonumber(ARGV[8]) then return cjson.encode({ok=false,error='inventory_full'}) end
local price=tonumber(ARGV[1])
local bal=tonumber(redis.call('GET',KEYS[2])) or 0
if bal<price then return cjson.encode({ok=false,error='funds',balance=bal}) end
local nb=redis.call('DECRBY',KEYS[2],price)
local gift={uid=ARGV[2],type=ARGV[5],from=ARGV[3],price=price,sentAt=tonumber(ARGV[6])}
redis.call('HSET',KEYS[3],ARGV[2],cjson.encode(gift))
redis.call('LPUSH',KEYS[4],cjson.encode({t='gift-out',a=-price,ts=tonumber(ARGV[6]),ref=ARGV[5],to=ARGV[4]}))
redis.call('LTRIM',KEYS[4],0,99)
redis.call('LPUSH',KEYS[7],cjson.encode({t='gift-in',a=0,ts=tonumber(ARGV[6]),ref=ARGV[5],from=ARGV[3]}))
redis.call('LTRIM',KEYS[7],0,99)
local res=cjson.encode({ok=true,balance=nb,gift=gift})
redis.call('SET',KEYS[1],res,'EX',86400)
return res`;
const LUA_SELL=`
local prev=redis.call('GET',KEYS[1]); if prev then return prev end
local raw=redis.call('HGET',KEYS[2],ARGV[1])
if not raw then return cjson.encode({ok=false,error='gone',balance=tonumber(redis.call('GET',KEYS[3])) or 0}) end
local g=cjson.decode(raw)
local now=tonumber(ARGV[2])
local unlock=g.sentAt+tonumber(ARGV[3])
if now<unlock then return cjson.encode({ok=false,error='early',unlockAt=unlock,balance=tonumber(redis.call('GET',KEYS[3])) or 0}) end
local refund=math.floor(g.price*tonumber(ARGV[4])/100)
redis.call('HDEL',KEYS[2],ARGV[1])
local nb=redis.call('INCRBY',KEYS[3],refund)
local goneFrom='mono:wal:v1:gone:'..g.from
redis.call('HSET',KEYS[5],ARGV[1],now); redis.call('EXPIRE',KEYS[5],tonumber(ARGV[5]))
redis.call('HSET',goneFrom,ARGV[1],now); redis.call('EXPIRE',goneFrom,tonumber(ARGV[5]))
redis.call('LPUSH',KEYS[4],cjson.encode({t='gift-sell',a=refund,ts=now,ref=g.type}))
redis.call('LTRIM',KEYS[4],0,99)
local res=cjson.encode({ok=true,balance=nb,uid=ARGV[1],refund=refund})
redis.call('SET',KEYS[1],res,'EX',86400)
return res`;

const parse=raw=>{try{return JSON.parse(raw)}catch(_){return null}};
async function stateOf(id){
  const [bal,claimed,inv,gone,led]=await Promise.all([
    cmd('GET',BAL(id)),cmd('HKEYS',CLAIMED(id)),cmd('HGETALL',INV(id)),cmd('HKEYS',GONE(id)),cmd('LRANGE',LED(id),0,19)]);
  const gifts=[];
  for(let i=0;i+1<(inv||[]).length;i+=2){const g=parse(inv[i+1]);if(g&&g.uid&&GIFTS[g.type])gifts.push({uid:g.uid,type:g.type,from:g.from,price:g.price,sentAt:g.sentAt})}
  gifts.sort((a,b)=>b.sentAt-a.sentAt);
  return {balance:Number(bal)||0,claimed:(claimed||[]).map(Number).filter(n=>LEVEL_SILVER[n]).sort((a,b)=>a-b),gifts,gone:gone||[],ledger:(led||[]).map(parse).filter(Boolean),now:Date.now(),sellHoldMs:SELL_HOLD_MS,sellPercent:SELL_PERCENT};
}
const ipHash=req=>{const raw=String(req.headers?.['x-forwarded-for']||req.headers?.['x-real-ip']||req.socket?.remoteAddress||'').split(',')[0].trim();return crypto.createHash('sha256').update('mono-wal|'+raw).digest('hex').slice(0,24)};

module.exports=async function handler(req,res){
  for(const [k,v] of Object.entries(HDR))res.setHeader(k,v);
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='POST')return err(res,405,'Method not allowed');
  try{
    let body=req.body;if(typeof body==='string'){try{body=JSON.parse(body)}catch(_){return err(res,400,'Invalid JSON')}}
    if(!body||typeof body!=='object')return err(res,400,'Invalid JSON object');
    const id=String(body.id||''),action=String(body.action||'');
    if(!ID.test(id))return err(res,400,'Invalid Mono ID');
    if(!(await authenticate(req,id)))return res.status(403).json(denyBody(req,{error:'Wrong installation key'}));
    if(action==='state')return res.status(200).json({ok:true,...(await stateOf(id))});
    const key=String(body.key||'');
    if(!KEY.test(key))return err(res,400,'Нужен ключ операции (key)');
    const now=Date.now();
    if(action==='claim-level'){
      const level=Number(body.level);const amount=LEVEL_SILVER[level];
      if(!Number.isInteger(level)||!amount)return err(res,400,'Для этого уровня нет серебряной награды');
      const created=Number(await cmd('HGET',CREATED,id))||now;
      if(now-created<MIN_ACCOUNT_AGE_MS)return err(res,429,'Аккаунт только что создан, повтори через несколько секунд');
      const ipKey=P+'ip:'+ipHash(req)+':'+Math.floor(now/86400000);
      const used=await cmd('INCR',ipKey);if(used===1)await cmd('EXPIRE',ipKey,172800);
      if(used>CLAIMS_PER_IP_DAY)return err(res,429,'Слишком много наград с одного адреса за сутки');
      const out=parse(await cmd('EVAL',LUA_CLAIM,4,IDEM(id,key),CLAIMED(id),BAL(id),LED(id),String(level),String(amount),String(now),String(LED_MAX)));
      return res.status(out?.ok||out?.error==='already'?200:400).json(out||{ok:false,error:'Ошибка кошелька'});
    }
    if(action==='send-gift'){
      const to=String(body.to||''),type=String(body.gift||'');
      if(!ID.test(to)||to===id)return err(res,400,'Укажи другого пользователя Mono');
      const gift=GIFTS[type];if(!gift)return err(res,400,'Неизвестный подарок');
      const uid=crypto.randomBytes(12).toString('hex');
      const out=parse(await cmd('EVAL',LUA_SEND,7,IDEM(id,key),BAL(id),INV(to),LED(id),RATE(id),OWNER(to),LED(to),
        String(gift.price),uid,id,to,type,String(now),String(SEND_PER_HOUR),String(MAX_INV)));
      if(!out)return err(res,500,'Ошибка кошелька');
      const map={funds:402,rate:429,norecipient:404,inventory_full:409};
      return res.status(out.ok?200:(map[out.error]||400)).json(out.ok?out:{...out,error:({funds:'Недостаточно серебряных монет',rate:'Слишком много подарков за час',norecipient:'Получатель ещё не зарегистрирован в Mono',inventory_full:'У получателя переполнен инвентарь'})[out.error]||out.error,code:out.error});
    }
    if(action==='sell-gift'){
      const uid=String(body.uid||'');if(!/^[a-f0-9]{24}$/.test(uid))return err(res,400,'Неверный подарок');
      const out=parse(await cmd('EVAL',LUA_SELL,5,IDEM(id,key),INV(id),BAL(id),LED(id),GONE(id),uid,String(now),String(SELL_HOLD_MS),String(SELL_PERCENT),String(GONE_TTL)));
      if(!out)return err(res,500,'Ошибка кошелька');
      return res.status(out.ok?200:(out.error==='early'?425:410)).json(out.ok?out:{...out,error:out.error==='early'?'Подарок можно продать через 3 дня после получения':'Подарок уже продан или не принадлежит тебе',code:out.error});
    }
    return err(res,400,'Unknown action');
  }catch(e){return err(res,500,'Wallet error')}
};
