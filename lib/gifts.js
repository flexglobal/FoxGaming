'use strict';
/* Каталог подарков и награды уровней — единственный источник цен (клиенту цена не доверяется). */
const GIFTS={
  bear:{name:'Мишка',price:100},
  cat:{name:'Котик',price:100},
  cake:{name:'Торт',price:150},
  headphones:{name:'Наушники',price:150},
  cocoa:{name:'Горячий шоколад',price:150},
  heart:{name:'Сердце',price:200},
  jar:{name:'Банка звёзд',price:200},
  crown:{name:'Корона',price:300},
  roses:{name:'Букет роз',price:350},
  box:{name:'Подарочная коробка',price:1000}
};
/* Серебро за уровни (как в клиентском mono-levels.js). Золото выдаётся отдельно. */
const LEVEL_SILVER={1:100,2:200,4:250,6:250,8:250,10:500,12:250,13:350,14:500};
const SELL_HOLD_MS=3*86400000;   // продать можно через 3 дня после получения
const SELL_PERCENT=70;           // продавец получает 70 % цены
module.exports={GIFTS,LEVEL_SILVER,SELL_HOLD_MS,SELL_PERCENT};
