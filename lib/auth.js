'use strict';
/* Единая проверка Mono ID + токена установки (заголовок X-Mono-Token).
   Владелец ID закрепляется НАВСЕГДА: после истечения короткого ключа mono:r3:auth:<id> (24 ч без мессенджера)
   другой человек, знающий чужой публичный Mono ID, больше не может «перехватить» аккаунт.
   Дата регистрации (acct:created) нужна для медалей «N лет в Mono». */
const {createHash}=require('node:crypto');
const {cmd}=require('./redis');
const banLib=require('./ban');
const OWNER=id=>'mono:acct:v1:owner:'+id;
const CREATED='mono:acct:v1:created';
const ID=/^MONO-[A-F0-9]{20}$/;
function tokenDigest(req){
  const token=req.headers?.['x-mono-token'];
  if(typeof token!=='string'||token.length<24||token.length>256)return '';
  return createHash('sha256').update(token).digest('hex');
}
async function authenticate(req,id){
  if(!ID.test(id||''))return false;
  const digest=tokenDigest(req);if(!digest)return false;
  const owner=await cmd('GET',OWNER(id));
  if(owner&&owner.startsWith('banned:')){
    // Заблокирован: токен совпасть не может. Причину показываем только прежнему владельцу.
    const rec=await banLib.current(id);
    if(rec){if(rec.prev&&rec.prev===digest)req.monoBan=rec;return false}
    return authenticate(req,id); // временный бан истёк и снят — проверяем заново
  }
  if(owner)return owner===digest;
  // Ещё не закреплён: учитываем старые источники (relay-сессия, шахматный владелец).
  const [chessOwner,session]=[await cmd('GET','mono:chess:v1:owner:'+id),await cmd('GET','mono:r3:auth:'+id)];
  if(chessOwner&&chessOwner!==digest)return false;
  if(session&&session!==digest)return false;
  await cmd('SET',OWNER(id),digest,'NX');
  if(await cmd('GET',OWNER(id))!==digest)return false;
  await cmd('HSETNX',CREATED,id,String(Date.now()));
  if(!session)await cmd('SET','mono:r3:auth:'+id,digest,'NX','EX',86400);
  return true;
}
/* Тело ответа 403: для заблокированного — понятное сообщение, для остальных — прежнее. */
const denyBody=(req,fallback)=>req&&req.monoBan?banLib.payload(req.monoBan):fallback;
module.exports={authenticate,tokenDigest,denyBody,OWNER,CREATED,ID};
