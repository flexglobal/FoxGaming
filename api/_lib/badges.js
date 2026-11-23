'use strict';
/* Серверная выдача медалей. Клиентские профили и P2P-сообщения медалей НЕ содержат и ничего не определяют.
   year…year5 — полные годы с даты регистрации (acct:created, ставит сервер); chess_top1-3 — позиция в мировом ELO;
   beta/vip/staff/bug_hunter — только решением администрации (api/admin.js). */
const {batch}=require('./redis');
const {CREATED}=require('./auth');
const RATINGS='mono:chess:v1:ratings';
const ROLES=id=>'mono:acct:v1:roles:'+id;
const VIP='mono:acct:v1:vip';
const ALL=new Set(['year','year2','year3','year4','year5','beta','vip','chess_top1','chess_top2','chess_top3','staff','bug_hunter']);
/* Администрация может выдать ЛЮБУЮ медаль (запись в roles). «deny:<медаль>» скрывает медаль, которую человек получил автоматически. */
const MANUAL=[...ALL];
/* Полные календарные годы между двумя датами (UTC). */
function fullYears(fromMs,toMs){
  const a=new Date(fromMs),b=new Date(toMs);let years=b.getUTCFullYear()-a.getUTCFullYear();
  if(b.getUTCMonth()<a.getUTCMonth()||(b.getUTCMonth()===a.getUTCMonth()&&b.getUTCDate()<a.getUTCDate()))years--;
  return Math.max(0,years);
}
function compute({created,roles,vipUntil,rank,elo},now=Date.now()){
  const out=[],set=new Set(roles||[]),shown=k=>!set.has('deny:'+k);
  const years=Number(created)>0&&Number(created)<=now?fullYears(Number(created),now):0;
  if(years>=1){const k=years>=5?'year5':years>=4?'year4':years>=3?'year3':years>=2?'year2':'year';if(shown(k))out.push(k)}
  for(const r of MANUAL)if(set.has(r))out.push(r);
  if((Number(vipUntil)>now||Number(vipUntil)===-1)&&shown('vip'))out.push('vip');
  if(Number.isInteger(rank)&&rank>=0&&rank<3&&Number(elo)>200&&shown('chess_top'+(rank+1)))out.push('chess_top'+(rank+1));
  return [...new Set(out)].filter(x=>ALL.has(x));
}
/* Один pipeline-запрос в Redis на все источники. */
async function verifiedBadges(id,now=Date.now()){
  const [created,roles,vip,rank,elo]=await batch([['HGET',CREATED,id],['SMEMBERS',ROLES(id)],['HGET',VIP,id],['ZREVRANK',RATINGS,id],['ZSCORE',RATINGS,id]]);
  return compute({created,roles:Array.isArray(roles)?roles:[],vipUntil:vip===null?0:Number(vip),rank:rank===null?-1:Number(rank),elo:elo===null?0:Number(elo)},now);
}
module.exports={verifiedBadges,compute,fullYears,ROLES,VIP,MANUAL,ALL};
