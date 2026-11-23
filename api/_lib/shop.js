'use strict';
/* Каталог магазина Mono (темы, рамки, эффекты профиля, наборы смайлов) — единственный источник цен.
   Клиентская цена не доверяется: сервер списывает монеты по этой таблице с учётом настроек администратора
   (цена, валюта, зачёркнутая «старая» цена, теги «новинка»/«акция»/«предложение», редкость) из Redis.
   Цена 0 в базовой таблице — системный бесплатный предмет, он есть у всех и не редактируется. */
const {cmd}=require('./redis');
const ITEMS={};
const add=(cat,list)=>{for(const [key,price,rarity] of list)ITEMS[cat+':'+key]={cat,key,price,rarity}};
add('theme',[['light',0,'common'],['dark',0,'common'],['peaks',400,'rare'],['moon',400,'rare'],['dawn',450,'rare'],['ocean',450,'rare'],['aurora',650,'epic'],['city',900,'legend']]);
add('frame',[['none',0,'common'],['neon',250,'rare'],['royal',350,'epic'],['ice',300,'rare'],['emerald',300,'rare'],['flame',450,'epic'],['aurora',900,'legend']]);
add('effect',[['none',0,'common'],['orbit',300,'rare'],['goldflow',300,'rare'],['comet',450,'epic'],['blizzard',450,'epic'],['stardust',350,'rare'],['fireflies',350,'rare'],['aurora',900,'legend']]);
add('emoji',[['mony',0,'common'],['fox',350,'rare'],['cat',350,'rare'],['slime',300,'rare'],['neon',700,'epic']]);
const CATS=['theme','frame','effect','emoji'];
const DEFAULT_EQ={theme:'theme:light',frame:'frame:none',effect:'effect:none',emoji:'emoji:mony'};
const RARITIES=['common','rare','epic','legend'];
const TAGS=['new','sale','offer'];
const CFG='mono:shop:v1:cfg';
const FREE=new Set(Object.keys(ITEMS).filter(k=>!ITEMS[k].price));
const parse=r=>{try{return JSON.parse(r)}catch(_){return null}};
/* Проверка настроек от администратора — всё, что не прошло, отбрасывается. */
function cleanCfg(id,c){
  const base=ITEMS[id];if(!base||FREE.has(id)||!c||typeof c!=='object')return null;
  const out={};
  const n=v=>Number.isInteger(v)&&v>=0&&v<=1000000;
  if(n(c.price)&&c.price>0)out.price=c.price;
  if(n(c.old)&&c.old>0)out.old=c.old;
  if(c.cur==='gold'||c.cur==='silver')out.cur=c.cur;
  if(RARITIES.includes(c.rarity))out.rarity=c.rarity;
  if(Array.isArray(c.tags))out.tags=[...new Set(c.tags.filter(t=>TAGS.includes(t)))];
  return out;
}
/* Итоговый каталог: базовая таблица + настройки администратора. */
async function catalog(){
  const raw=await cmd('HGETALL',CFG)||[];const cfg={};
  for(let i=0;i+1<raw.length;i+=2){const c=cleanCfg(raw[i],parse(raw[i+1]));if(c)cfg[raw[i]]=c}
  const out={};
  for(const [id,b] of Object.entries(ITEMS)){const c=cfg[id]||{};
    const price=FREE.has(id)?0:(c.price??b.price);
    out[id]={id,cat:b.cat,key:b.key,price,basePrice:b.price,cur:c.cur||'silver',rarity:c.rarity||b.rarity,
      old:c.old&&c.old>price?c.old:0,tags:c.tags||[],free:FREE.has(id),custom:!!cfg[id]}}
  return out;
}
/* Публичная часть настроек для клиента (только то, что отличается от базы). */
async function publicOverrides(){
  const cat=await catalog();const out={};
  for(const [id,it] of Object.entries(cat))if(it.custom)out[id]={price:it.price,cur:it.cur,rarity:it.rarity,old:it.old,tags:it.tags};
  return out;
}
async function setCfg(id,c){
  if(!ITEMS[id])throw new Error('unknown');if(FREE.has(id))throw new Error('free');
  const clean=cleanCfg(id,c);
  if(!clean||!Object.keys(clean).length){await cmd('HDEL',CFG,id);return null}
  await cmd('HSET',CFG,id,JSON.stringify(clean));return clean;
}
module.exports={SHOP_ITEMS:ITEMS,SHOP_CATS:CATS,SHOP_DEFAULT_EQ:DEFAULT_EQ,SHOP_RARITIES:RARITIES,SHOP_TAGS:TAGS,SHOP_FREE:FREE,shopCatalog:catalog,shopPublic:publicOverrides,shopSetCfg:setCfg};
