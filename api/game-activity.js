'use strict';
/* «Играет в»: серверный статус активной полноэкранной игры. Информационный, НЕ основание для наград/ELO/доступа.
   POST {monoId, activity:{gameId,details,iconPng,startedAt}|null}, заголовок X-Mono-Token.
   Название берётся из каталога сервера; пути, PID и заголовки окон не принимаются. Статус живёт 12 минут. */
const {cmd}=require('../lib/redis');
const {authenticate,ID}=require('../lib/auth');
const {GAMES,isGame}=require('../lib/game-catalog');
const HDR={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,X-Mono-Token','Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8','X-Content-Type-Options':'nosniff'};
const KEY=id=>'mono:activity:v1:'+id;
const LIMIT=id=>'mono:activity:v1:rl:'+id;
const TTL=720, MIN_INTERVAL=540;
const PNG_SIG=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
function icon(value){
  if(typeof value!=='string'||value.length>48000||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value))return '';
  try{const raw=Buffer.from(value.slice(22),'base64');return raw.length<=36000&&raw.subarray(0,8).equals(PNG_SIG)?value:''}catch(_){return ''}
}
function normalize(activity,now=Date.now()){
  if(!activity||typeof activity!=='object'||Array.isArray(activity))return null;
  const gameId=String(activity.gameId||'');if(!isGame(gameId))return null;
  const details=typeof activity.details==='string'?activity.details.replace(/[\u0000-\u001f\u007f<>]/g,'').trim().slice(0,110):'';
  const started=Number(activity.startedAt);
  return {gameId,name:GAMES[gameId],details,iconDataUrl:icon(activity.iconPng),startedAt:Number.isFinite(started)&&started>now-86400000&&started<=now+60000?Math.floor(started):0};
}
module.exports=async(req,res)=>{
  for(const [k,v] of Object.entries(HDR))res.setHeader(k,v);
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  try{
    let b=req.body;if(typeof b==='string')b=JSON.parse(b);
    const id=String(b?.monoId||'').trim().toUpperCase();
    if(!ID.test(id)||!(await authenticate(req,id)))return res.status(403).json({error:'Invalid identity'});
    if(b.activity===null||b.activity===undefined){await cmd('DEL',KEY(id));return res.status(200).json({ok:true,activity:null})}
    const game=normalize(b.activity);
    if(!game)return res.status(400).json({error:'Unknown game'});
    // Не чаще одной публикации в ~9 минут на аккаунт (очистка статуса разрешена всегда).
    if(await cmd('SET',LIMIT(id),'1','NX','EX',MIN_INTERVAL)!=='OK'){
      const wait=Number(await cmd('TTL',LIMIT(id)))||MIN_INTERVAL;
      res.setHeader('Retry-After',String(wait));return res.status(429).json({error:'Too many updates',retryAfter:wait});
    }
    await cmd('SET',KEY(id),JSON.stringify({...game,updatedAt:Date.now()}),'EX',TTL);
    return res.status(200).json({ok:true,activity:{...game,updatedAt:Date.now()}});
  }catch(e){console.error('[game-activity]',e.message);return res.status(503).json({error:'Activity service unavailable'})}
};
module.exports._internal={normalize,icon};
