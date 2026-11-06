'use strict';
/* Собирает lib/admin-page.js из lib/admin-page.html (страница хранится как строка, чтобы Vercel гарантированно включил её в функцию). */
const fs=require('node:fs'),path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../lib/admin-page.html'),'utf8');
fs.writeFileSync(path.join(__dirname,'../lib/admin-page.js'),"'use strict';\n/* АВТОГЕНЕРАЦИЯ: node tools/build-admin-page.cjs (источник — lib/admin-page.html) */\nmodule.exports="+JSON.stringify(src)+";\n");
console.log('admin-page.js',src.length,'chars');
