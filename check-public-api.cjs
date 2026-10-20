'use strict';
/* Read-only public deployment probe. No authentication data is sent. */
const base=String(process.env.MONO_API_BASE||'https://fox-gaming563gc.vercel.app').replace(/\/+$/,'');
if(!(/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(base)||/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(base)))throw Error('Expected an HTTPS API base or localhost; set MONO_API_BASE.');
const probes=[
  {name:'Health',path:'/api/health',method:'GET'},
  {name:'Chess',path:'/api/chess',method:'POST',body:{id:'invalid',action:'leaderboard'}},
  {name:'Google OAuth',path:'/api/google',method:'POST',body:{action:'diagnostic'}}
];
let failure=false;
async function run(p){
  const options={method:p.method,redirect:'manual',signal:AbortSignal.timeout(10000),headers:{Accept:'application/json'}};
  if(p.body){options.headers['Content-Type']='application/json';options.body=JSON.stringify(p.body)}
  try{
    const response=await fetch(base+p.path,options);
    const contentType=response.headers.get('content-type')||'не указан';
    const body=await response.text();let parsed;try{parsed=JSON.parse(body)}catch(_){}
    const json=parsed!==null&&typeof parsed==='object';
    let message;
    if(response.status===404){failure=true;message='API-маршрут не найден в опубликованном проекте. Проверь корневую папку, ветку и последний production deploy.';}
    else if(!json){failure=true;message='Ответ не JSON. Сервер может возвращать страницу ошибки или страницу приложения.';}
    else if(response.status===503){message='Маршрут найден, но сервер не настроен или сервис недоступен: '+String(parsed.error||parsed.redis||'HTTP 503').slice(0,120);}
    else if(p.name==='Chess'&&response.status===403)message='Маршрут работает: тестовый запрос без Mono ID ожидаемо отклонён.';
    else if(p.name==='Google OAuth'&&response.status===400)message='Маршрут работает: тестовое действие ожидаемо отклонено.';
    else message='Ответ получен: '+String(parsed.error||parsed.version||'OK').slice(0,120);
    console.log(`${p.name}: HTTP ${response.status} | ${contentType} | ${message}`);
  }catch(error){failure=true;console.log(`${p.name}: ошибка сети — ${String(error?.message||error).slice(0,180)}`)}
}
(async()=>{for(const p of probes)await run(p);if(failure){console.error('Проверка не пройдена: исправь публикацию серверных маршрутов и повтори.');process.exitCode=1}else console.log('Проверка маршрутов завершена. HTTP 503 для Google означает, что нужно настроить OAuth переменные на сервере.')})().catch(e=>{console.error(e);process.exitCode=1});
