'use strict';
/* Админ-панель Mono (скрытая) + прежний API наград.
   ─ Панель открывается ТОЛЬКО по секретной ссылке  https://<домен>/a/<MONO_ADMIN_PATH>  (любой другой адрес → 404).
   ─ Два администратора, у каждого свой пароль (Vercel env: MONO_ADMIN1_PASS, MONO_ADMIN2_PASS, ≥12 символов).
     Одновременно может быть не больше 2 сессий: по одной на админа (новый вход вытесняет прежний вход того же админа).
   ─ БЕЗОПАСНОСТЬ ВВОДА ПАРОЛЯ: пароль — это всегда только ДАННЫЕ. Он принимается лишь как строка ≤200 символов,
     хэшируется (scrypt) и сравнивается по хэшу за постоянное время. Он никогда не разбирается как JSON/команда, не попадает
     в Redis, логи и аудит, а действие определяется ТОЛЬКО полем `op` из белого списка (Map), поэтому ввести команду в строку
     пароля и «выполнить» её невозможно. Успешный вход даёт случайный токен сессии (256 бит, хранится как SHA-256).
   ─ Подбор: 5 неверных паролей с одного адреса → блок на 15 минут; 40 неверных на весь сервис → блок входа на 15 минут.
   ─ Опасные действия (правка ELO, сброс ВСЕХ ELO, восстановление) требуют повторного ввода пароля именно этого админа.
   ─ Все действия пишутся в журнал (без паролей) — вкладка «Консоль».
   Прежний API (заголовок X-Mono-Admin = MONO_ADMIN_TOKEN, поля action/id) работает как раньше:
     grant / revoke (role — любая медаль), set-vip (id, days), set-created (id, at), show (id). */
const crypto=require('node:crypto');
const {cmd,batch}=require('../lib/redis');
const {ID,CREATED}=require('../lib/auth');
const {ROLES,VIP,MANUAL,ALL,verifiedBadges}=require('../lib/badges');
const banLib=require('../lib/ban');
const PAGE=require('../lib/admin-page');

const A='mono:adm:v1:';
const SESS=hx=>A+'sess:'+hx, CUR=n=>A+'cur:'+n, FAIL_IP=ip=>A+'fail:ip:'+ip, FAIL_ALL=A+'fail:all';
const AUDIT=A+'audit', DAILY=A+'daily', ELO_META=A+'eloreset';
const NEWS='mono:official:news:v2', BUG_IDX='mono:bug:v1:idx', BUG_HASH='mono:bug:v1:r';
const RATINGS='mono:chess:v1:ratings', RATINGS_BACKUP='mono:chess:v1:ratings:backup';
const NICKS='mono:chess:v1:nicknames', COUNTRIES='mono:chess:v1:countries', NAMES='mono:public-profile:v1:usernames';
const PROFILE=id=>'mono:public-profile:v1:'+id;
const BAL=id=>'mono:wal:v1:bal:'+id, LED=id=>'mono:wal:v1:led:'+id, INV=id=>'mono:wal:v1:inv:'+id, CLAIMED=id=>'mono:wal:v1:claimed:'+id;
const ONLINE=id=>'mono:r3:online:'+id;
const MAX_FAIL_IP=5, MAX_FAIL_ALL=40, LOCK_SEC=900, SESSION_IDLE=7200, SESSION_ABS=12*3600*1000, PAGE_SIZE=40;
const SECURITY_HEADERS={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow, noarchive','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'};
const sha=v=>crypto.createHash('sha256').update(String(v)).digest();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const parse=raw=>{try{return JSON.parse(raw)}catch(_){return null}};
const safeEq=(a,b)=>crypto.timingSafeEqual(sha(a),sha(b));
const ipHash=req=>{const raw=String(req.headers?.['x-forwarded-for']||req.headers?.['x-real-ip']||req.socket?.remoteAddress||'').split(',')[0].trim();return crypto.createHash('sha256').update('mono-adm|'+raw).digest('hex').slice(0,24)};
/* плоский ответ HGETALL → объект без прототипа (имена пользователей вроде «__proto__» безопасны) */
const pairs=flat=>{const o=Object.create(null);for(let i=0;i+1<(flat||[]).length;i+=2)o[flat[i]]=flat[i+1];return o};
const uid=v=>{const x=typeof v==='string'?v.trim().toUpperCase():'';return ID.test(x)?x:null};
const int=(v,min,max)=>{const n=typeof v==='number'?v:(typeof v==='string'&&/^-?\d{1,12}$/.test(v)?Number(v):NaN);return Number.isSafeInteger(n)&&n>=min&&n<=max?n:null};
const str=(v,max)=>typeof v==='string'?v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,max):'';

/* ───────── конфигурация (Vercel env, в репозитории секретов нет) ───────── */
function config(){
  const slug=String(process.env.MONO_ADMIN_PATH||'');
  const admins=[1,2].map(n=>({n,name:str(process.env['MONO_ADMIN'+n+'_NAME']||'',30)||'Админ '+n,pass:String(process.env['MONO_ADMIN'+n+'_PASS']||'')})).filter(a=>a.pass.length>=12);
  if(admins.length===2&&admins[0].pass===admins[1].pass)admins.pop(); // одинаковые пароли недопустимы: админ 2 отключается
  return {slug:/^[A-Za-z0-9_-]{16,80}$/.test(slug)?slug:'',admins};
}
const slugOk=slug=>{const c=config();return !!c.slug&&typeof slug==='string'&&slug.length<=200&&safeEq(slug,c.slug)};
const scrypt=(pw,salt)=>new Promise((ok,no)=>crypto.scrypt(pw,salt,32,{N:16384,r:8,p:1,maxmem:64*1024*1024},(e,k)=>e?no(e):ok(k)));
const salt=()=>'mono-admin-v1|'+(process.env.MONO_ADMIN_PATH||'');
const expectedCache=new Map();
const expectedDigest=a=>{const k=a.n+'|'+a.pass+'|'+salt();if(!expectedCache.has(k))expectedCache.set(k,scrypt(a.pass,salt()));return expectedCache.get(k)};
/* Какому админу принадлежит пароль (0 — никому). Сравниваются ОБА пароля всегда, независимо от результата. */
async function matchAdmin(given){
  if(typeof given!=='string'||given.length<1||given.length>200)return 0;
  const {admins}=config();let found=0;
  const g=await scrypt(given,salt());
  for(const a of admins){const ok=crypto.timingSafeEqual(g,await expectedDigest(a));if(ok&&!found)found=a.n}
  return found;
}
async function lockState(req){
  const ip=ipHash(req);
  const [f,all,ttl]=await batch([['GET',FAIL_IP(ip)],['GET',FAIL_ALL],['TTL',FAIL_IP(ip)]]);
  const locked=Number(f)>=MAX_FAIL_IP||Number(all)>=MAX_FAIL_ALL;
  return {ip,locked,retry:Math.max(60,Number(ttl)>0?Number(ttl):LOCK_SEC)};
}
async function registerFail(ip){
  const [n,m]=await batch([['INCR',FAIL_IP(ip)],['INCR',FAIL_ALL]]);
  if(n===1)await cmd('EXPIRE',FAIL_IP(ip),LOCK_SEC);
  if(m===1)await cmd('EXPIRE',FAIL_ALL,LOCK_SEC);
  return Number(n);
}
const LUA_SESSION=`
local old=redis.call('GET',KEYS[1])
if old then redis.call('DEL','mono:adm:v1:sess:'..old) end
redis.call('SET',KEYS[1],ARGV[1],'EX',tonumber(ARGV[3]))
redis.call('SET',KEYS[2],ARGV[2],'EX',tonumber(ARGV[3]))
return 1`;
async function getSession(req){
  const t=req.headers?.['x-mono-admin-session'];
  if(typeof t!=='string'||!/^[a-f0-9]{64}$/.test(t))return null;
  const hx=sha(t).toString('hex');
  const rec=parse(await cmd('GET',SESS(hx)));
  if(!rec||!config().admins.some(a=>a.n===rec.admin))return null;
  if(Date.now()-rec.at>SESSION_ABS){await cmd('DEL',SESS(hx));return null}
  await cmd('EXPIRE',SESS(hx),SESSION_IDLE);
  return {...rec,hx};
}
async function audit(s,op,target,detail){
  try{await batch([['LPUSH',AUDIT,JSON.stringify({at:Date.now(),admin:s.admin,name:s.name,op,target:target||'',detail:detail||{}})],['LTRIM',AUDIT,0,1999]])}catch(e){console.error('[admin audit]',e.message)}
}
class Fail extends Error{constructor(code,msg,extra){super(msg);this.code=code;this.extra=extra||{}}}
/* Повторный ввод пароля для опасных действий. Пароль — данные; проверяется ровно как при входе. */
async function reauth(req,s,b){
  const st=await lockState(req);
  if(st.locked){await cmd('DEL',SESS(s.hx));throw new Fail(429,'Слишком много неверных паролей. Сессия закрыта, повтори вход позже',{retryAfter:st.retry})}
  const who=await matchAdmin(b.password);
  if(who!==s.admin){
    const n=await registerFail(st.ip);await sleep(400);
    if(n>=3)await cmd('DEL',SESS(s.hx));
    throw new Fail(403,n>=3?'Неверный пароль. Сессия закрыта':'Неверный пароль',{code:'reauth',closed:n>=3});
  }
  await cmd('DEL',FAIL_IP(st.ip));
}
const rank=p=>p<200?'Железо':p<=500?'Бронза':p<=900?'Серебро':p<=1500?'Золото':p<=2000?'Платина':p<=2750?'Алмаз':p<4000?'Рассвет':'Грандмастер';
const TIERS=['Железо','Бронза','Серебро','Золото','Платина','Алмаз','Рассвет','Грандмастер'];
const scanCount=async match=>{let cur='0',n=0,loops=0;do{const r=await cmd('SCAN',cur,'MATCH',match,'COUNT',1000);cur=String(r[0]);n+=(r[1]||[]).length;loops++}while(cur!=='0'&&loops<300);return n};
const must=async id=>{if(!id)throw new Fail(400,'Неверный Mono ID');if(!Number(await cmd('HEXISTS',CREATED,id)))throw new Fail(404,'Такого пользователя нет');return id};

/* ───────── Lua ───────── */
const LUA_SILVER=`
local bal=tonumber(redis.call('GET',KEYS[1]) or '0')
local d=tonumber(ARGV[1])
if d<0 and bal+d<0 then d=-bal end
if d==0 then return cjson.encode({balance=bal,delta=0}) end
local nb=redis.call('INCRBY',KEYS[1],d)
redis.call('LPUSH',KEYS[2],cjson.encode({t='admin',a=d,ts=tonumber(ARGV[2]),ref=ARGV[3]}))
redis.call('LTRIM',KEYS[2],0,tonumber(ARGV[4])-1)
return cjson.encode({balance=nb,delta=d})`;
const LUA_ELO_RESET=`
redis.call('DEL',KEYS[2])
local n=redis.call('ZCARD',KEYS[1])
if n==0 then return 0 end
redis.call('ZUNIONSTORE',KEYS[2],1,KEYS[1])
redis.call('EXPIRE',KEYS[2],tonumber(ARGV[2]))
local off=0
while true do
  local part=redis.call('ZRANGE',KEYS[2],off,off+999)
  if #part==0 then break end
  local args={}
  for _,m in ipairs(part) do args[#args+1]=ARGV[1]; args[#args+1]=m end
  redis.call('ZADD',KEYS[1],unpack(args))
  off=off+1000
end
return n`;
const LUA_ELO_RESTORE=`
if redis.call('EXISTS',KEYS[2])==0 then return -1 end
redis.call('DEL',KEYS[1])
redis.call('ZUNIONSTORE',KEYS[1],1,KEYS[2])
return redis.call('ZCARD',KEYS[1])`;

/* ───────── операции панели (белый список; никаких динамических имён) ───────── */
const OPS=new Map();
OPS.set('me',async({s})=>({ok:true,admin:s.admin,name:s.name,medals:[...ALL]}));
OPS.set('logout',async({s})=>{await cmd('DEL',SESS(s.hx));return {ok:true}});

OPS.set('users',async({b})=>{
  const q=str(b.q,64).toLowerCase().replace(/^@/,'');
  const sort=['new','old','elo','nick'].includes(b.sort)?b.sort:'new';
  const page=int(b.page,0,100000)??0;
  const cmds=[['HGETALL',CREATED],['HGETALL',NICKS],['HGETALL',NAMES],['HGETALL',banLib.BANS]];
  if(sort==='elo')cmds.push(['ZRANGE',RATINGS,0,-1,'WITHSCORES']);
  const res=await batch(cmds);
  const created=pairs(res[0]),nicks=pairs(res[1]),names=pairs(res[2]),bans=pairs(res[3]);
  const nameById=Object.create(null);for(const u in names)nameById[names[u]]=u;
  let rows=Object.keys(created).map(id=>({id,created:Number(created[id])||0,nick:nicks[id]||'',username:nameById[id]||'',banned:!!bans[id]}));
  const total=rows.length;
  if(q)rows=rows.filter(r=>r.id.toLowerCase().includes(q)||r.nick.toLowerCase().includes(q)||r.username.includes(q));
  if(sort==='elo'){const e=pairs(res[4]);for(const r of rows)r.elo=Number(e[r.id])||0;rows.sort((a,c)=>(c.elo||0)-(a.elo||0))}
  else if(sort==='old')rows.sort((a,c)=>a.created-c.created);
  else if(sort==='nick')rows.sort((a,c)=>(a.nick||'~').localeCompare(c.nick||'~','ru'));
  else rows.sort((a,c)=>c.created-a.created);
  const slice=rows.slice(page*PAGE_SIZE,page*PAGE_SIZE+PAGE_SIZE);
  if(slice.length){
    const ids=slice.map(r=>r.id);
    const [elos,bals,onl]=await batch([['ZMSCORE',RATINGS,...ids],['MGET',...ids.map(BAL)],['MGET',...ids.map(ONLINE)]]);
    slice.forEach((r,i)=>{r.elo=elos?.[i]===null||elos?.[i]===undefined?null:Number(elos[i]);r.silver=Number(bals?.[i])||0;r.online=!!onl?.[i]});
  }
  return {ok:true,total,matched:rows.length,page,pageSize:PAGE_SIZE,users:slice,banned:Object.keys(bans).length};
});

OPS.set('user',async({b})=>{
  const id=await must(uid(b.id));
  const [created,nick,profileRaw,elo,pos,bal,roles,vip,banRaw,led,inv,country,online,claimed]=await batch([
    ['HGET',CREATED,id],['HGET',NICKS,id],['GET',PROFILE(id)],['ZSCORE',RATINGS,id],['ZREVRANK',RATINGS,id],['GET',BAL(id)],['SMEMBERS',ROLES(id)],['HGET',VIP,id],
    ['HGET',banLib.BANS,id],['LRANGE',LED(id),0,14],['HVALS',INV(id)],['HGET',COUNTRIES,id],['EXISTS',ONLINE(id)],['HKEYS',CLAIMED(id)]]);
  const profile=parse(profileRaw)||{};
  const ban=parse(banRaw);if(ban)delete ban.prev;
  const gifts=(inv||[]).map(parse).filter(Boolean).map(g=>({type:g.type,from:g.from,price:g.price,sentAt:g.sentAt}));
  return {ok:true,id,created:Number(created)||0,nick:nick||profile.nick||'',username:profile.username||'',bio:str(profile.bio,200),country:country||profile.country||'',
    elo:elo===null?null:Number(elo),tier:elo===null?null:rank(Number(elo)),position:pos===null?null:Number(pos)+1,silver:Number(bal)||0,roles:(roles||[]).filter(r=>ALL.has(r)||(r.startsWith('deny:')&&ALL.has(r.slice(5)))),
    vipUntil:vip===null?0:Number(vip),badges:await verifiedBadges(id),ban:ban||null,ledger:(led||[]).map(parse).filter(Boolean),gifts,claimedLevels:(claimed||[]).map(Number).sort((a,c)=>a-c),online:!!online};
});

OPS.set('ban',async({b,s})=>{
  const id=await must(uid(b.id));const reason=str(b.reason,300);const days=b.days===undefined?0:int(b.days,0,3650);
  if(days===null)throw new Fail(400,'Срок: от 0 (навсегда) до 3650 дней');
  const done=await banLib.ban(id,{reason,until:days?Date.now()+days*86400000:0,by:s.name});
  await audit(s,'ban',id,{reason,days});
  return {ok:true,id,already:!done};
});
OPS.set('unban',async({b,s})=>{const id=uid(b.id);if(!id)throw new Fail(400,'Неверный Mono ID');const done=await banLib.unban(id);await audit(s,'unban',id,{});return {ok:true,id,wasBanned:done}});

OPS.set('silver',async({b,s})=>{
  const id=await must(uid(b.id));const amount=int(b.amount,-1000000,1000000);
  if(!amount)throw new Fail(400,'Сумма: целое число от −1 000 000 до 1 000 000, не ноль');
  const note=str(b.note,60)||(amount>0?'Начислено администрацией':'Списано администрацией');
  const out=parse(await cmd('EVAL',LUA_SILVER,2,BAL(id),LED(id),String(amount),String(Date.now()),note,'100'));
  await audit(s,amount>0?'silver+':'silver-',id,{requested:amount,delta:out.delta,balance:out.balance,note});
  return {ok:true,id,balance:out.balance,delta:out.delta,clamped:out.delta!==amount};
});

OPS.set('medal',async({b,s})=>{
  const id=await must(uid(b.id));const medal=str(b.medal,40),mode=b.mode;
  if(!ALL.has(medal))throw new Fail(400,'Неизвестная медаль');
  if(mode!=='grant'&&mode!=='revoke')throw new Fail(400,'mode: grant или revoke');
  if(mode==='grant')await batch([['SADD',ROLES(id),medal],['SREM',ROLES(id),'deny:'+medal]]);
  else await batch([['SREM',ROLES(id),medal],['SADD',ROLES(id),'deny:'+medal]]);
  await audit(s,'medal-'+mode,id,{medal});
  return {ok:true,id,badges:await verifiedBadges(id)};
});

OPS.set('chess',async()=>{
  const [all,total,backupN,meta]=await batch([['ZREVRANGE',RATINGS,0,-1,'WITHSCORES'],['ZCARD',RATINGS],['ZCARD',RATINGS_BACKUP],['GET',ELO_META]]);
  const players=[];for(let i=0;i+1<(all||[]).length;i+=2)players.push({id:all[i],elo:Number(all[i+1])});
  const tiers=Object.fromEntries(TIERS.map(t=>[t,0]));let sum=0;for(const p of players){tiers[rank(p.elo)]++;sum+=p.elo}
  const top=players.slice(0,15);
  const nicks=top.length?await cmd('HMGET',NICKS,...top.map(p=>p.id)):[];
  top.forEach((p,i)=>p.nick=nicks?.[i]||'');
  return {ok:true,total:Number(total)||0,avg:players.length?Math.round(sum/players.length):0,tiers,top,backup:Number(backupN)?{count:Number(backupN),...(parse(meta)||{})}:null};
});
OPS.set('elo-set',async({b,s,req})=>{
  const id=await must(uid(b.id));const elo=int(b.elo,0,100000);
  if(elo===null)throw new Fail(400,'ELO: целое число от 0 до 100000');
  await reauth(req,s,b);
  const old=await cmd('ZSCORE',RATINGS,id);
  await cmd('ZADD',RATINGS,String(elo),id);
  await audit(s,'elo-set',id,{old:old===null?null:Number(old),new:elo});
  return {ok:true,id,old:old===null?null:Number(old),elo,tier:rank(elo)};
});
OPS.set('elo-reset-all',async({b,s,req})=>{
  if(b.confirm!=='СБРОС')throw new Fail(400,'Для сброса введи слово СБРОС');
  await reauth(req,s,b);
  const n=Number(await cmd('EVAL',LUA_ELO_RESET,2,RATINGS,RATINGS_BACKUP,'200',String(30*86400)));
  await cmd('SET',ELO_META,JSON.stringify({at:Date.now(),by:s.name}),'EX',30*86400);
  await audit(s,'elo-reset-all','*',{players:n,to:200});
  return {ok:true,players:n,to:200};
});
OPS.set('elo-restore',async({b,s,req})=>{
  if(b.confirm!=='ВЕРНУТЬ')throw new Fail(400,'Для возврата введи слово ВЕРНУТЬ');
  await reauth(req,s,b);
  const n=Number(await cmd('EVAL',LUA_ELO_RESTORE,2,RATINGS,RATINGS_BACKUP));
  if(n<0)throw new Fail(404,'Копии рейтинга нет (она хранится 30 дней после сброса)');
  await audit(s,'elo-restore','*',{players:n});
  return {ok:true,players:n};
});

OPS.set('analytics',async()=>{
  const day=new Date().toISOString().slice(0,10);
  const res=await batch([['HGETALL',CREATED],['HLEN',banLib.BANS],['ZRANGE',RATINGS,0,-1,'WITHSCORES'],['ZCARD',BUG_IDX],['HGETALL',DAILY]]);
  const created=pairs(res[0]),ids=Object.keys(created);
  const now=Date.now(),D=86400000;let d1=0,d7=0,d30=0;const perDay=Object.create(null);
  for(const id of ids){const t=Number(created[id])||0;if(now-t<D)d1++;if(now-t<7*D)d7++;if(now-t<30*D){d30++;const k=new Date(t).toISOString().slice(0,10);perDay[k]=(perDay[k]||0)+1}}
  const reg=[];for(let i=29;i>=0;i--){const k=new Date(now-i*D).toISOString().slice(0,10);reg.push({day:k,n:perDay[k]||0})}
  const [online,active24]=[await scanCount('mono:r3:online:*'),await scanCount('mono:r3:auth:*')];
  const elo=[];for(let i=0;i+1<(res[2]||[]).length;i+=2)elo.push(Number(res[2][i+1]));
  const tiers=Object.fromEntries(TIERS.map(t=>[t,0]));for(const e of elo)tiers[rank(e)]++;
  let silverTotal=0,holders=0;const top=[];
  for(let i=0;i<ids.length;i+=500){
    const chunk=ids.slice(i,i+500),vals=await cmd('MGET',...chunk.map(BAL));
    vals.forEach((v,j)=>{const n=Number(v)||0;if(n>0){silverTotal+=n;holders++;top.push({id:chunk[j],silver:n})}});
  }
  top.sort((a,c)=>c.silver-a.silver);
  // История «активных за 24 ч» копится ежедневным снимком (максимум за день): сервер не пишет ничего лишнего при обычных запросах.
  const hist=pairs(res[4]);const prev=parse(hist[day])||{};
  const snap={dau:Math.max(active24,prev.dau||0),online:Math.max(online,prev.online||0),total:ids.length};
  await cmd('HSET',DAILY,day,JSON.stringify(snap));hist[day]=JSON.stringify(snap);
  const history=Object.keys(hist).sort().slice(-30).map(k=>({day:k,...(parse(hist[k])||{})}));
  const topNicks=top.length?await cmd('HMGET',NICKS,...top.slice(0,5).map(t=>t.id)):[];
  return {ok:true,users:{total:ids.length,new1:d1,new7:d7,new30:d30,online,active24,banned:Number(res[1])||0},registrations:reg,history,
    chess:{players:elo.length,avg:elo.length?Math.round(elo.reduce((a,c)=>a+c,0)/elo.length):0,tiers},
    wallet:{silverTotal,holders,top:top.slice(0,5).map((t,i)=>({...t,nick:topNicks?.[i]||''}))},bugs:Number(res[3])||0,at:now};
});

OPS.set('announce',async({b,s})=>{
  const title=str(b.title,150),body=typeof b.body==='string'?b.body.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,1600):'';
  if(!title||!body)throw new Fail(400,'Нужны заголовок (до 150 символов) и текст (до 1600)');
  const item={id:crypto.randomUUID(),title,body,createdAt:Date.now(),kind:'announce'};
  await batch([['LPUSH',NEWS,JSON.stringify(item)],['LTRIM',NEWS,0,29]]);
  await audit(s,'announce',item.id,{title});
  return {ok:true,item};
});
OPS.set('announce-list',async()=>({ok:true,items:((await cmd('LRANGE',NEWS,0,29))||[]).map(parse).filter(Boolean)}));
OPS.set('announce-delete',async({b,s})=>{
  const id=str(b.id,64);if(!/^[A-Za-z0-9-]{8,64}$/.test(id))throw new Fail(400,'Неверный id');
  const list=(await cmd('LRANGE',NEWS,0,29))||[];const hit=list.find(raw=>parse(raw)?.id===id);
  if(!hit)throw new Fail(404,'Объявление не найдено');
  await cmd('LREM',NEWS,0,hit);await audit(s,'announce-delete',id,{});return {ok:true};
});

OPS.set('bugs',async({b})=>{
  const status=['new','seen','done'].includes(b.status)?b.status:'';
  const ids=(await cmd('ZREVRANGE',BUG_IDX,0,299))||[];
  const raws=ids.length?await cmd('HMGET',BUG_HASH,...ids):[];
  let items=(raws||[]).map(parse).filter(Boolean);
  const counts={new:0,seen:0,done:0};for(const r of items)counts[r.status||'new']++;
  if(status)items=items.filter(r=>(r.status||'new')===status);
  const who=[...new Set(items.map(r=>r.id))];
  const nicks=who.length?await cmd('HMGET',NICKS,...who):[];const map=Object.fromEntries(who.map((id,i)=>[id,nicks?.[i]||'']));
  return {ok:true,counts,items:items.slice(0,100).map(r=>({...r,nick:map[r.id]||''}))};
});
OPS.set('bug-status',async({b,s})=>{
  const rid=str(b.rid,40),status=b.status;if(!/^[A-Za-z0-9-]{8,40}$/.test(rid)||!['new','seen','done'].includes(status))throw new Fail(400,'Неверные данные');
  const rec=parse(await cmd('HGET',BUG_HASH,rid));if(!rec)throw new Fail(404,'Отчёт не найден');
  rec.status=status;await cmd('HSET',BUG_HASH,rid,JSON.stringify(rec));await audit(s,'bug-status',rid,{status});return {ok:true};
});
OPS.set('bug-delete',async({b,s})=>{
  const rid=str(b.rid,40);if(!/^[A-Za-z0-9-]{8,40}$/.test(rid))throw new Fail(400,'Неверный id');
  await batch([['HDEL',BUG_HASH,rid],['ZREM',BUG_IDX,rid]]);await audit(s,'bug-delete',rid,{});return {ok:true};
});
OPS.set('audit',async()=>({ok:true,items:((await cmd('LRANGE',AUDIT,0,199))||[]).map(parse).filter(Boolean)}));

/* ───────── обработчик ───────── */
const fail=(res,code,error,extra)=>res.status(code).json({error,...extra});
async function legacy(req,res,b){
  const expected=process.env.MONO_ADMIN_TOKEN||'',got=req.headers?.['x-mono-admin'];
  if(!(expected.length>=24&&typeof got==='string'&&safeEq(got,expected)))return fail(res,403,'Forbidden');
  const id=String(b?.id||'').trim().toUpperCase(),action=String(b?.action||'');
  if(!ID.test(id))return fail(res,400,'Invalid Mono ID');
  const log=entry=>cmd('LPUSH','mono:acct:v1:audit',JSON.stringify({...entry,id,at:Date.now()})).then(()=>cmd('LTRIM','mono:acct:v1:audit',0,999));
  if(action==='grant'||action==='revoke'){
    const role=String(b.role||'');if(!MANUAL.includes(role))return fail(res,400,'Role must be one of '+MANUAL.join(', '));
    await cmd(action==='grant'?'SADD':'SREM',ROLES(id),role);await log({action,role});
  }else if(action==='set-vip'){
    const days=Number(b.days);if(!Number.isFinite(days)||days<-1||days>3650)return fail(res,400,'days must be -1, 0 or up to 3650');
    if(days===0)await cmd('HDEL',VIP,id);else await cmd('HSET',VIP,id,String(days===-1?-1:Date.now()+Math.floor(days*86400000)));
    await log({action,days});
  }else if(action==='set-created'){
    const at=Number(b.at);if(!Number.isSafeInteger(at)||at<1262304000000||at>Date.now())return fail(res,400,'Invalid date');
    await cmd('HSET',CREATED,id,String(at));await log({action,at});
  }else if(action!=='show')return fail(res,400,'Unknown action');
  return res.status(200).json({ok:true,id,verifiedBadges:await verifiedBadges(id),roles:await cmd('SMEMBERS',ROLES(id)),created:Number(await cmd('HGET',CREATED,id))||null});
}
module.exports=async(req,res)=>{
  for(const [k,v] of Object.entries(SECURITY_HEADERS))res.setHeader(k,v);
  try{
    // 1) Страница панели — только по секретной ссылке (vercel.json: /a/:slug → /api/admin?page=1&slug=:slug).
    if(req.method==='GET'){
      if(String(req.query?.page||'')!=='1'||!slugOk(String(req.query?.slug||'')))return fail(res,404,'Not found');
      const nonce=crypto.randomBytes(16).toString('base64');
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'nonce-"+nonce+"'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      res.statusCode=200;return res.end(PAGE.split('{{NONCE}}').join(nonce));
    }
    res.setHeader('Content-Type','application/json; charset=utf-8');
    if(req.method==='OPTIONS')return res.status(204).end();
    if(req.method!=='POST')return fail(res,405,'Method not allowed');
    let b=req.body;if(typeof b==='string'){try{b=JSON.parse(b)}catch(_){return fail(res,400,'Invalid JSON')}}
    if(!b||typeof b!=='object'||Array.isArray(b))return fail(res,400,'Invalid JSON object');
    if(typeof b.op!=='string')return await legacy(req,res,b); // прежний API наград (по заголовку X-Mono-Admin)
    const op=b.op;
    if(op==='login'){
      if(!slugOk(b.slug))return fail(res,404,'Not found');
      const cfg=config();if(!cfg.admins.length)return fail(res,503,'Панель не настроена: задай MONO_ADMIN1_PASS (≥12 символов) в Vercel');
      const st=await lockState(req);
      if(st.locked)return fail(res,429,'Слишком много попыток входа. Подожди '+Math.ceil(st.retry/60)+' мин.',{retryAfter:st.retry});
      const who=await matchAdmin(b.password); // что бы ни ввели — это только пароль-строка; всё остальное = «неверный пароль»
      if(!who){await registerFail(st.ip);await sleep(500);return fail(res,401,'Неверный пароль')}
      await cmd('DEL',FAIL_IP(st.ip));
      const admin=cfg.admins.find(a=>a.n===who);
      const token=crypto.randomBytes(32).toString('hex'),hx=sha(token).toString('hex');
      await cmd('EVAL',LUA_SESSION,2,CUR(who),SESS(hx),hx,JSON.stringify({admin:who,name:admin.name,at:Date.now()}),String(SESSION_IDLE));
      await audit({admin:who,name:admin.name},'login','',{});
      return res.status(200).json({ok:true,token,admin:who,name:admin.name,idleSeconds:SESSION_IDLE});
    }
    const handler=OPS.get(op);
    if(!handler)return fail(res,400,'Unknown operation');
    const s=await getSession(req);
    if(!s)return fail(res,401,'Сессия не найдена или истекла — войди заново',{code:'session'});
    const out=await handler({b,s,req});
    return res.status(200).json(out);
  }catch(e){
    if(e instanceof Fail)return fail(res,e.code,e.message,e.extra);
    console.error('[admin]',e.message);return fail(res,503,'Admin service unavailable');
  }
};
