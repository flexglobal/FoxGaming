'use strict';
/* Каталог магазина Mono (темы, рамки, эффекты профиля, наборы смайлов) — единственный источник цен.
   Клиентская цена не доверяется: сервер списывает серебро по этой таблице. Цена 0 — предмет есть у всех. */
const ITEMS={};
const add=(cat,list)=>{for(const [key,price] of list)ITEMS[cat+':'+key]={cat,key,price}};
add('theme',[['light',0],['dark',0],['sakura',350],['ocean',350],['forest',350],['paper',200],['graphite',200],['aurora',700],['gold',700],['synth',1200]]);
add('frame',[['none',0],['neon',300],['pixel',150],['cat',400],['sakura',450],['laurel',800],['ice',800],['orbit',900],['flame',1500]]);
add('effect',[['none',0],['snow',200],['bubbles',200],['hearts',400],['confetti',400],['sparkles',450],['fireflies',750],['matrix',750],['stars',800],['aurora',1400]]);
add('emoji',[['mony',0],['fox',350],['cat',350],['slime',300],['pixel',600],['neon',1000]]);
const CATS=['theme','frame','effect','emoji'];
const DEFAULT_EQ={theme:'theme:light',frame:'frame:none',effect:'effect:none',emoji:'emoji:mony'};
module.exports={SHOP_ITEMS:ITEMS,SHOP_CATS:CATS,SHOP_DEFAULT_EQ:DEFAULT_EQ};
