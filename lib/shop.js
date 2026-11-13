'use strict';
/* Каталог магазина Mono (темы, рамки, эффекты профиля, наборы смайлов) — единственный источник цен.
   Клиентская цена не доверяется: сервер списывает серебро по этой таблице. Цена 0 — предмет есть у всех. */
const ITEMS={};
const add=(cat,list)=>{for(const [key,price] of list)ITEMS[cat+':'+key]={cat,key,price}};
add('theme',[['light',0],['dark',0],['peaks',400],['moon',400],['dawn',450],['ocean',450],['aurora',650],['city',900]]);
add('frame',[['none',0],['neon',250],['royal',350],['ice',300],['emerald',300],['flame',450],['aurora',900]]);
add('effect',[['none',0],['orbit',300],['goldflow',300],['comet',450],['blizzard',450],['stardust',350],['fireflies',350],['aurora',900]]);
add('emoji',[['mony',0],['fox',350],['cat',350],['slime',300],['neon',700]]);
const CATS=['theme','frame','effect','emoji'];
const DEFAULT_EQ={theme:'theme:light',frame:'frame:none',effect:'effect:none',emoji:'emoji:mony'};
module.exports={SHOP_ITEMS:ITEMS,SHOP_CATS:CATS,SHOP_DEFAULT_EQ:DEFAULT_EQ};
