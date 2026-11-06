'use strict';
/* Тесты админ-панели, банов, баг-репортов и защиты ввода пароля.
   Запуск: redis-server --port 6390 --save "" --daemonize yes && node tests/admin-test.cjs */
const assert=require('node:assert/strict');
const {createProxy}=require('./upstash-proxy.cjs');
const hex=n=>[...Array(n)].map(()=>'0123456789ABCDEF'[Math.floor(Math.random()*16)]).join('');
const mkUser=()=>({id:'MONO-'+hex(20),token:hex(40)});
function invoke(handler,{method='POST',body=null,query={},headers={}}){
  return new Promise((resolve,reject)=>{
    const res={headers:{},setHeader(k,v){this.headers[k]=v},status(c){this.code=c;return this},json(o){resolve({code:this.code,body:o,headers:this.headers})},end(b){resolve({code:this.code||this.statusCode,body:b===undefined?null:b,headers:this.headers})}};
    Promise.resolve(handler({method,body,query,headers},res)).catch(reject);
  });
}
(async()=>{
  const proxy=await createProxy(6390,0);
  process.env.UPSTASH_REDIS_REST_URL='http://127.0.0.1:'+proxy.port;process.env.UPSTASH_REDIS_REST_TOKEN='test-token';
  const SLUG='s3cret'+hex(24).toLowerCase(),PASS1='Alpha-'+hex(14),PASS2='Bravo-'+hex(14);
  process.env.MONO_ADMIN_PATH=SLUG;process.env.MONO_ADMIN1_PASS=PASS1;process.env.MONO_ADMIN2_PASS=PASS2;
  process.env.MONO_ADMIN1_NAME='Первый';process.env.MONO_ADMIN2_NAME='Второй';
  await proxy.run(['FLUSHALL']);
  const messages=require('../api/messages'),profile=require('../api/profile'),chess=require('../api/chess'),wallet=require('../api/wallet'),news=require('../api/news'),admin=require('../api/admin');
  const H=u=>({'x-mono-token':u.token});
  const as=(h,u,body,method='POST',query={})=>invoke(h,{method,body:{id:u.id,...body},query,headers:H(u)});
  let ipn=1;const freshIp=()=>'10.1.'+Math.floor(ipn/250)+'.'+(ipn++%250);
  const call=(body,token,ip)=>invoke(admin,{body,headers:{...(token?{'x-mono-admin-session':token}:{}),'x-forwarded-for':ip||freshIp()}});
  const login=async(password,ip)=>call({op:'login',slug:SLUG,password},null,ip);
  const clearFails=async()=>{for(const k of await proxy.run(['KEYS','mono:adm:v1:fail:*']))await proxy.run(['DEL',k])};
  let passed=0;const t=async(name,fn)=>{try{await fn();passed++;console.log('ok  ',name)}catch(e){console.log('FAIL',name,'\n    ',e.message.split('\n').slice(0,5).join('\n     '),'\n      @',(e.stack.split('\n').find(l=>l.includes('admin-test.cjs'))||'').trim());process.exitCode=1}};

  // ---- пользователи для тестов ----
  const alice=mkUser(),bob=mkUser(),eve=mkUser();
  for(const u of [alice,bob,eve])assert.equal((await invoke(messages,{body:{action:'ping',id:u.id},headers:H(u)})).code,200);
  await proxy.run(['HSET','mono:chess:v1:nicknames',alice.id,'Алиса',bob.id,'Боб']);
  await proxy.run(['ZADD','mono:chess:v1:ratings','900',alice.id,'450',bob.id]);

  // ---- страница и вход ----
  await t('страница панели: только по секретной ссылке, строгий CSP, пароли в HTML не встречаются',async()=>{
    const q=(page,slug)=>invoke(admin,{method:'GET',query:{page,slug}});
    assert.equal((await q('1','wrong-'+SLUG)).code,404);
    assert.equal((await q('1','')).code,404);
    assert.equal((await q('0',SLUG)).code,404);
    assert.equal((await invoke(admin,{method:'GET',query:{}})).code,404);
    const ok=await q('1',SLUG);assert.equal(ok.code,200);
    assert.match(ok.headers['Content-Type'],/text\/html/);
    const csp=ok.headers['Content-Security-Policy'];assert.match(csp,/default-src 'none'/);assert.match(csp,/frame-ancestors 'none'/);assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
    const nonce=/nonce-([A-Za-z0-9+/=]+)/.exec(csp)[1];assert.ok(ok.body.includes('nonce="'+nonce+'"'));assert.ok(!ok.body.includes('{{NONCE}}'));
    assert.ok(!ok.body.includes(PASS1)&&!ok.body.includes(PASS2)&&!ok.body.includes(process.env.MONO_ADMIN_PATH.slice(0,8)+'x'));
    assert.match(ok.headers['X-Robots-Tag'],/noindex/);
    const second=await q('1',SLUG);assert.notEqual(/nonce-([A-Za-z0-9+/=]+)/.exec(second.headers['Content-Security-Policy'])[1],nonce);
  });
  let s1,s2;
  await t('вход: неверный слаг → 404, неверный пароль → 401, два админа получают свои сессии',async()=>{
    assert.equal((await call({op:'login',slug:'nope'+SLUG,password:PASS1})).code,404);
    assert.equal((await call({op:'login',password:PASS1})).code,404);
    assert.equal((await login('wrong-password-123')).code,401);
    const a=await login(PASS1);assert.equal(a.code,200);assert.equal(a.body.admin,1);assert.equal(a.body.name,'Первый');assert.match(a.body.token,/^[a-f0-9]{64}$/);s1=a.body.token;
    const b=await login(PASS2);assert.equal(b.code,200);assert.equal(b.body.admin,2);s2=b.body.token;assert.notEqual(s1,s2);
    assert.equal((await call({op:'me'},s1)).body.admin,1);assert.equal((await call({op:'me'},s2)).body.admin,2);
    // сам токен в Redis хранится только как хэш
    const keys=await proxy.run(['KEYS','mono:adm:v1:sess:*']);assert.equal(keys.length,2);assert.ok(!keys.some(k=>k.includes(s1)||k.includes(s2)));
  });
  await t('не больше 2 сессий: повторный вход админа вытесняет его прежнюю сессию',async()=>{
    const again=await login(PASS1);assert.equal(again.code,200);
    assert.equal((await call({op:'me'},s1)).code,401);assert.equal((await call({op:'me'},again.body.token)).code,200);
    s1=again.body.token;assert.equal((await call({op:'me'},s2)).code,200);
    assert.equal((await proxy.run(['KEYS','mono:adm:v1:sess:*'])).length,2);
  });
  await t('без сессии / с мусорным токеном все операции — 401; неизвестные и «служебные» op — 400',async()=>{
    for(const tok of [undefined,'','x','a'.repeat(64),'A'.repeat(64),'../'.repeat(30),'{"op":"users"}'])assert.equal((await call({op:'users'},tok)).code,401,String(tok));
    for(const op of ['__proto__','constructor','toString','hasOwnProperty','login2','LOGIN','users ','users;ban','  ','eval','FLUSHALL',PASS1,PASS2])assert.equal((await call({op},s1)).code,400,'op '+op);
    assert.equal((await call({op:5},s1)).code,403);        // не строка → «старый» API без заголовка X-Mono-Admin → отказ
    assert.equal((await call({},s1)).code,403);
    assert.equal((await invoke(admin,{method:'PUT',body:{op:'users'}})).code,405);
  });

  // ---- главное: пароль — это только данные ----
  await t('ПАРОЛЬ-КОМАНДА: что бы ни ввели в поле пароля — это просто неверный пароль, действий нет, сессии нет',async()=>{
    await clearFails();
    const before=await proxy.run(['KEYS','*']);
    const hostile=[
      '{"op":"users"}','{"op":"ban","id":"'+alice.id+'"}','users','ban '+alice.id,'op=users&password='+PASS1,'/ban '+alice.id,'/admin '+PASS1,'sudo admin','login '+PASS1,
      PASS1+' ; DROP','"'+PASS1+'"',' '+PASS1,PASS1+' ',PASS1.toUpperCase(),PASS1.slice(0,-1),PASS1+PASS2,'\'; FLUSHALL; --','\r\nX-Mono-Admin-Session: '+s1,'${PASS1}','`'+PASS1+'`','$(echo '+PASS1+')',
      '__proto__','constructor','admin','admin1','Первый','1','true','null','undefined','[]','{}','{"$ne":""}','{"password":"'+PASS1+'"}','elo-reset-all','СБРОС','FLUSHALL','EVAL "return 1" 0','A'.repeat(5000)
    ];
    let n=0;
    for(const pw of hostile){if(++n%8===0)await clearFails();const r=await login(pw);assert.equal(r.code,401,JSON.stringify(pw).slice(0,60)+' → '+r.code);assert.equal(r.body.token,undefined)}
    const odd=[null,undefined,0,1,-1,true,false,[],[PASS1],{},{$ne:''},{$gt:''},{toString:()=>PASS1},{password:PASS1},[[PASS1]],12345678901234567890,NaN,'' ];
    let k=0;for(const pw of odd){if(++k%8===0)await clearFails();const r=await login(pw);assert.equal(r.code,401,'non-string '+JSON.stringify(pw));assert.equal(r.body.token,undefined)}
    // побочных эффектов нет: новых сессий нет, баны/ELO/серебро не менялись
    const after=await proxy.run(['KEYS','*']);const created=after.filter(k=>!before.includes(k));
    assert.ok(created.every(k=>k.startsWith('mono:adm:v1:fail:')),'неожиданные ключи: '+created.join(','));
    assert.equal(await proxy.run(['HLEN','mono:adm:v1:bans']),0);assert.equal(Number(await proxy.run(['ZSCORE','mono:chess:v1:ratings',alice.id])),900);
    assert.equal(await proxy.run(['LLEN','mono:adm:v1:audit']).then(Number)>=0,true);
    const audit=JSON.stringify(await proxy.run(['LRANGE','mono:adm:v1:audit',0,-1]));assert.ok(!audit.includes('FLUSHALL')&&!audit.includes(PASS1)&&!audit.includes(PASS2));
    await clearFails();
  });
  await t('ПАРОЛЬ-КОМАНДА при повторной проверке (опасные действия): чужая/«командная» строка не выполняет и не проходит',async()=>{
    for(const pw of ['{"op":"users"}',PASS2,'СБРОС',PASS1+'x','',null,{$ne:''},[PASS1],'FLUSHALL']){
      const r=await call({op:'elo-set',id:alice.id,elo:1,password:pw},s1);
      assert.equal(r.code,403,JSON.stringify(pw)+' → '+r.code);
      assert.equal(Number(await proxy.run(['ZSCORE','mono:chess:v1:ratings',alice.id])),900);
      // сессия пока жива? После 3 неверных подряд она закрывается — перелогиниваемся
      if((await call({op:'me'},s1)).code!==200){s1=(await login(PASS1)).body.token}
    }
    await clearFails();s1=(await login(PASS1)).body.token;
  });
  await t('перебор: 5 неверных с одного адреса → блок 15 мин (даже верный пароль), другой адрес не затронут',async()=>{
    await clearFails();const ip='203.0.113.77';
    for(let i=0;i<5;i++)assert.equal((await login('bad-'+i+'-password',ip)).code,401);
    const locked=await login(PASS1,ip);assert.equal(locked.code,429);assert.ok(locked.body.retryAfter>=60);assert.equal(locked.body.token,undefined);
    assert.equal((await login(PASS1,'203.0.113.78')).code,200);
    await clearFails();assert.equal((await login(PASS1,ip)).code,200);
    s1=(await login(PASS1)).body.token;
  });
  await t('глобальный лимит: 40 неверных на весь сервис → вход закрыт на время блока',async()=>{
    await clearFails();await proxy.run(['SET','mono:adm:v1:fail:all','40','EX','900']);
    assert.equal((await login(PASS1)).code,429);await clearFails();assert.equal((await login(PASS1)).code,200);s1=(await login(PASS1)).body.token;
  });
  await t('одинаковые пароли у двух админов недопустимы: второй отключается; короткие пароли не принимаются',async()=>{
    const old=[process.env.MONO_ADMIN1_PASS,process.env.MONO_ADMIN2_PASS];
    process.env.MONO_ADMIN2_PASS=PASS1;assert.equal((await login(PASS1)).body.admin,1);assert.equal((await login(PASS2)).code,401);
    process.env.MONO_ADMIN2_PASS='short';assert.equal((await login('short')).code,401);
    process.env.MONO_ADMIN1_PASS='';process.env.MONO_ADMIN2_PASS='';assert.equal((await login(PASS1)).code,503);
    [process.env.MONO_ADMIN1_PASS,process.env.MONO_ADMIN2_PASS]=old;assert.equal((await login(PASS2)).code,200);
    s1=(await login(PASS1)).body.token;s2=(await login(PASS2)).body.token;
  });

  // ---- пользователи ----
  await t('список пользователей: поиск по нику и ID, сортировка по ELO, постраничность, онлайн/серебро',async()=>{
    const all=await call({op:'users'},s1);assert.equal(all.code,200);assert.equal(all.body.total,3);assert.equal(all.body.users.length,3);
    const byNick=await call({op:'users',q:'алис'},s1);assert.equal(byNick.body.users.length,1);assert.equal(byNick.body.users[0].id,alice.id);assert.equal(byNick.body.users[0].elo,900);
    assert.equal((await call({op:'users',q:bob.id.slice(5,15)},s1)).body.users[0].id,bob.id);
    const byElo=await call({op:'users',sort:'elo'},s1);assert.equal(byElo.body.users[0].id,alice.id);
    assert.equal(byElo.body.users[0].online,true);
    assert.equal((await call({op:'users',page:5},s1)).body.users.length,0);
    assert.equal((await call({op:'users',q:'"><script>alert(1)</script>'},s1)).body.users.length,0);
    const d=await call({op:'user',id:alice.id},s1);assert.equal(d.body.nick,'Алиса');assert.equal(d.body.elo,900);assert.equal(d.body.tier,'Серебро');
    assert.equal((await call({op:'user',id:'MONO-'+'0'.repeat(20)},s1)).code,404);assert.equal((await call({op:'user',id:'drop'},s1)).code,400);
  });

  // ---- бан ----
  await t('бан: все функции закрыты с понятной причиной, остальных не касается, разбан возвращает доступ тем же токеном',async()=>{
    const peers=bob.id;
    assert.equal((await invoke(messages,{method:'GET',query:{action:'poll',id:eve.id},headers:H(eve)})).code,200);
    const b=await call({op:'ban',id:eve.id,reason:'Спам в чатах',days:0},s1);assert.equal(b.code,200);
    const poll=await invoke(messages,{method:'GET',query:{action:'poll',id:eve.id,peers},headers:H(eve)});
    assert.equal(poll.code,403);assert.equal(poll.body.banned,true);assert.match(poll.body.error,/Спам в чатах/);
    for(const [h,body] of [[wallet,{action:'state'}],[chess,{action:'leaderboard'}],[profile,{profile:{nick:'x'}}]]){
      const r=await as(h,eve,body);assert.equal(r.code,403);assert.equal(r.body.banned,true);
    }
    assert.equal((await invoke(messages,{body:{action:'send',from:eve.id,to:bob.id,payload:{type:'text',text:'hi'}},headers:H(eve)})).code,403);
    assert.equal((await invoke(messages,{body:{action:'ping',id:eve.id},headers:H(eve)})).code,403);
    // чужой токен не узнаёт, что аккаунт забанен
    const stranger=await invoke(messages,{method:'GET',query:{action:'poll',id:eve.id},headers:H(mkUser())});assert.equal(stranger.code,403);assert.equal(stranger.body.banned,undefined);
    // остальные работают
    assert.equal((await invoke(messages,{method:'GET',query:{action:'poll',id:bob.id},headers:H(bob)})).code,200);
    assert.equal((await as(wallet,bob,{action:'state'})).code,200);
    assert.equal((await call({op:'ban',id:eve.id,reason:'ещё раз'},s1)).body.already,true);
    assert.equal((await call({op:'user',id:eve.id},s1)).body.ban.reason,'Спам в чатах');
    assert.equal((await call({op:'users',q:eve.id.slice(5)},s1)).body.users[0].banned,true);
    assert.equal((await call({op:'unban',id:eve.id},s1)).code,200);
    assert.equal((await invoke(messages,{method:'GET',query:{action:'poll',id:eve.id},headers:H(eve)})).code,200);
    assert.equal((await as(wallet,eve,{action:'state'})).code,200);
    assert.equal(await proxy.run(['GET','mono:acct:v1:owner:'+eve.id]).then(x=>x.startsWith('banned:')),false);
  });
  await t('временный бан сам заканчивается; бан незарегистрированного ID не ломает ничего',async()=>{
    const u=mkUser();await invoke(messages,{body:{action:'ping',id:u.id},headers:H(u)});
    assert.equal((await call({op:'ban',id:u.id,reason:'тест',days:1},s1)).code,200);
    assert.equal((await as(wallet,u,{action:'state'})).code,403);
    const rec=JSON.parse(await proxy.run(['HGET','mono:adm:v1:bans',u.id]));rec.until=Date.now()-1000;await proxy.run(['HSET','mono:adm:v1:bans',u.id,JSON.stringify(rec)]);
    assert.equal((await as(wallet,u,{action:'state'})).code,200);assert.equal(await proxy.run(['HEXISTS','mono:adm:v1:bans',u.id]),0);
    assert.equal((await call({op:'ban',id:u.id,days:-5},s1)).code,400);assert.equal((await call({op:'ban',id:u.id,days:'abc'},s1)).code,400);
    assert.equal((await call({op:'ban',id:'MONO-'+'1'.repeat(20)},s1)).code,404);
  });

  // ---- серебро ----
  await t('серебро: начислить, забрать, не уходит в минус, неверные суммы отклоняются, баланс виден в кошельке',async()=>{
    const give=await call({op:'silver',id:bob.id,amount:500,note:'Подарок'},s1);assert.equal(give.code,200);assert.equal(give.body.balance,500);
    assert.equal((await as(wallet,bob,{action:'state'})).body.balance,500);
    const take=await call({op:'silver',id:bob.id,amount:-200},s2);assert.equal(take.body.balance,300);assert.equal(take.body.delta,-200);
    const over=await call({op:'silver',id:bob.id,amount:-9999},s1);assert.equal(over.body.balance,0);assert.equal(over.body.delta,-300);assert.equal(over.body.clamped,true);
    assert.equal((await as(wallet,bob,{action:'state'})).body.balance,0);
    for(const amount of [0,1.5,'abc',null,undefined,1000001,-1000001,{},[]])assert.equal((await call({op:'silver',id:bob.id,amount},s1)).code,400,JSON.stringify(amount));
    assert.equal((await call({op:'silver',id:'MONO-'+'2'.repeat(20),amount:5},s1)).code,404);
    const led=(await as(wallet,bob,{action:'state'})).body.ledger;assert.equal(led[0].t,'admin');
  });
  await t('серебро: гонка 20 одновременных «забрать» не уводит баланс ниже нуля',async()=>{
    await call({op:'silver',id:bob.id,amount:100},s1);
    const rs=await Promise.all(Array.from({length:20},()=>call({op:'silver',id:bob.id,amount:-30},s1)));
    assert.ok(rs.every(r=>r.code===200));assert.equal((await as(wallet,bob,{action:'state'})).body.balance,0);
  });

  // ---- медали ----
  await t('медали: выдать любую из 12, забрать, скрыть автоматическую; профиль показывает серверный результат',async()=>{
    const ALL=['year','year2','year3','year4','year5','beta','vip','chess_top1','chess_top2','chess_top3','staff','bug_hunter'];
    for(const m of ALL)assert.equal((await call({op:'medal',id:alice.id,medal:m,mode:'grant'},s1)).code,200,m);
    const pr=await invoke(profile,{method:'GET',query:{id:alice.id}});
    // профиль без публикации: 404, а медали видны через публичное чтение после публикации профиля
    await as(profile,alice,{profile:{nick:'Алиса'}});
    const g=await invoke(profile,{method:'GET',query:{id:alice.id}});assert.deepEqual([...g.body.verifiedBadges].sort(),[...ALL].sort());
    const r=await call({op:'medal',id:alice.id,medal:'staff',mode:'revoke'},s2);assert.ok(!r.body.badges.includes('staff'));
    assert.equal((await call({op:'medal',id:alice.id,medal:'ultra',mode:'grant'},s1)).code,400);
    assert.equal((await call({op:'medal',id:alice.id,medal:'staff',mode:'steal'},s1)).code,400);
    assert.equal((await call({op:'medal',id:alice.id,medal:{$ne:''},mode:'grant'},s1)).code,400);
    // естественная медаль «1 год» скрывается через deny
    await proxy.run(['DEL','mono:acct:v1:roles:'+bob.id]);await proxy.run(['HSET','mono:acct:v1:created',bob.id,String(Date.now()-400*86400000)]);
    assert.ok((await call({op:'user',id:bob.id},s1)).body.badges.includes('year'));
    assert.ok(!(await call({op:'medal',id:bob.id,medal:'year',mode:'revoke'},s1)).body.badges.includes('year'));
    assert.ok((await call({op:'medal',id:bob.id,medal:'year',mode:'grant'},s1)).body.badges.includes('year'));
    await proxy.run(['DEL','mono:acct:v1:roles:'+alice.id]);
  });

  // ---- ELO ----
  await t('ELO: правка требует пароль именно этого админа; чужой пароль, пустой и неверный — отказ; верный — применяется',async()=>{
    assert.equal((await call({op:'elo-set',id:alice.id,elo:1234},s1)).code,403);
    assert.equal((await call({op:'elo-set',id:alice.id,elo:1234,password:PASS2},s1)).code,403);   // пароль другого админа
    assert.equal((await call({op:'elo-set',id:alice.id,elo:1234,password:'nope'},s1)).code,403);
    assert.equal(Number(await proxy.run(['ZSCORE','mono:chess:v1:ratings',alice.id])),900);
    await clearFails();s1=(await login(PASS1)).body.token;
    const ok=await call({op:'elo-set',id:alice.id,elo:1234,password:PASS1},s1);assert.equal(ok.code,200);assert.equal(ok.body.old,900);assert.equal(ok.body.tier,'Золото');
    assert.equal(Number(await proxy.run(['ZSCORE','mono:chess:v1:ratings',alice.id])),1234);
    for(const elo of [-1,100001,1.5,'abc',null])assert.equal((await call({op:'elo-set',id:alice.id,elo,password:PASS1},s1)).code,400,String(elo));
    assert.equal((await call({op:'elo-set',id:'MONO-'+'3'.repeat(20),elo:5,password:PASS1},s1)).code,404);
    assert.equal((await call({op:'elo-set',id:bob.id,elo:2,password:PASS2},s2)).code,200);
    await proxy.run(['ZADD','mono:chess:v1:ratings','900',alice.id,'450',bob.id]);
  });
  await t('3 неверных пароля подряд при повторной проверке закрывают сессию',async()=>{
    await clearFails();const s=(await login(PASS1)).body.token,ip='7.7.7.7';
    assert.equal((await call({op:'elo-set',id:bob.id,elo:5,password:'x1'},s,ip)).code,403);assert.equal((await call({op:'elo-set',id:bob.id,elo:5,password:'x2'},s,ip)).code,403);
    assert.equal((await call({op:'me'},s)).code,200);
    const third=await call({op:'elo-set',id:bob.id,elo:5,password:'x3'},s,ip);assert.equal(third.code,403);assert.equal(third.body.closed,true);
    assert.equal((await call({op:'me'},s)).code,401);await clearFails();s1=(await login(PASS1)).body.token;
  });
  await t('сброс ВСЕХ ELO: нужен пароль и слово СБРОС; все становятся 200; копия 30 дней; возврат из копии',async()=>{
    await proxy.run(['ZADD','mono:chess:v1:ratings','900',alice.id,'450',bob.id,'1700',eve.id]);
    assert.equal((await call({op:'elo-reset-all',password:PASS1},s1)).code,400);
    assert.equal((await call({op:'elo-reset-all',password:PASS1,confirm:'сброс'},s1)).code,400);
    assert.equal((await call({op:'elo-reset-all',confirm:'СБРОС'},s1)).code,403);
    assert.equal((await call({op:'elo-reset-all',confirm:'СБРОС',password:PASS2},s1)).code,403);
    assert.equal(Number(await proxy.run(['ZSCORE','mono:chess:v1:ratings',alice.id])),900);
    await clearFails();s1=(await login(PASS1)).body.token;
    const r=await call({op:'elo-reset-all',confirm:'СБРОС',password:PASS1},s1);assert.equal(r.code,200);assert.equal(r.body.players,3);
    for(const u of [alice,bob,eve])assert.equal(Number(await proxy.run(['ZSCORE','mono:chess:v1:ratings',u.id])),200);
    const ttl=await proxy.run(['TTL','mono:chess:v1:ratings:backup']);assert.ok(ttl>29*86400);
    const info=await call({op:'chess'},s1);assert.equal(info.body.backup.count,3);assert.equal(info.body.total,3);assert.equal(info.body.avg,200);
    assert.equal((await call({op:'elo-restore',password:PASS1},s1)).code,400);
    const back=await call({op:'elo-restore',confirm:'ВЕРНУТЬ',password:PASS1},s1);assert.equal(back.code,200);
    assert.equal(Number(await proxy.run(['ZSCORE','mono:chess:v1:ratings',alice.id])),900);assert.equal(Number(await proxy.run(['ZSCORE','mono:chess:v1:ratings',eve.id])),1700);
    await proxy.run(['DEL','mono:chess:v1:ratings:backup']);
    assert.equal((await call({op:'elo-restore',confirm:'ВЕРНУТЬ',password:PASS1},s1)).code,404);
  });
  await t('сброс ELO на большом рейтинге (3000 игроков) работает атомарно за один вызов',async()=>{
    const args=['ZADD','mono:chess:v1:ratings'];for(let i=0;i<3000;i++){args.push(String(300+i),'MONO-'+i.toString(16).toUpperCase().padStart(20,'0'))}
    await proxy.run(args);
    const r=await call({op:'elo-reset-all',confirm:'СБРОС',password:PASS1},s1);assert.equal(r.code,200);assert.ok(r.body.players>=3000);
    assert.equal(await proxy.run(['ZCOUNT','mono:chess:v1:ratings','200','200']),r.body.players);
    await proxy.run(['DEL','mono:chess:v1:ratings','mono:chess:v1:ratings:backup']);await proxy.run(['ZADD','mono:chess:v1:ratings','900',alice.id,'450',bob.id]);
  });

  // ---- аналитика ----
  await t('аналитика: счётчики пользователей, регистрации, шахматы, серебро',async()=>{
    await call({op:'silver',id:alice.id,amount:700},s1);
    const a=await call({op:'analytics'},s1);assert.equal(a.code,200);
    assert.equal(a.body.users.total,4);assert.ok(a.body.users.new1>=3);assert.ok(a.body.users.online>=3);assert.ok(a.body.users.active24>=3);
    assert.equal(a.body.registrations.length,30);assert.ok(a.body.registrations.reduce((s,x)=>s+x.n,0)>=3);
    assert.equal(a.body.chess.players,2);assert.equal(a.body.wallet.silverTotal,700);assert.equal(a.body.wallet.top[0].nick,'Алиса');
    assert.ok(a.body.history.length>=1&&a.body.history[a.body.history.length-1].dau>=3);
  });

  // ---- объявления ----
  await t('объявления: публикация видна всем через /api/news, удаление, лимиты',async()=>{
    assert.equal((await call({op:'announce',title:'',body:'x'},s1)).code,400);assert.equal((await call({op:'announce',title:'x',body:'y'.repeat(1700)},s1)).code,200);
    const r=await call({op:'announce',title:'Технические работы',body:'Сегодня в 23:00 обновление'},s2);assert.equal(r.code,201-1);
    const feed=await invoke(news,{method:'GET'});assert.equal(feed.code,200);const item=feed.body.items.find(x=>x.id===r.body.item.id);
    assert.equal(item.title,'Технические работы');assert.equal(item.kind,'announce');
    assert.equal((await call({op:'announce-list'},s1)).body.items.length,2);
    assert.equal((await call({op:'announce-delete',id:r.body.item.id},s1)).code,200);
    assert.ok(!(await invoke(news,{method:'GET'})).body.items.some(x=>x.id===r.body.item.id));
    assert.equal((await call({op:'announce-delete',id:r.body.item.id},s1)).code,404);assert.equal((await call({op:'announce-delete',id:'../x'},s1)).code,400);
    for(const it of (await call({op:'announce-list'},s1)).body.items)await call({op:'announce-delete',id:it.id},s1);
  });

  // ---- баг-репорты ----
  const bug=(u,text,extra={})=>invoke(news,{body:{action:'bug',id:u.id,text,...extra},headers:H(u)});
  await t('баг-репорт: 3 в сутки, до 1000 слов, нужен свой токен; лишнее не списывает лимит',async()=>{
    const u=alice;
    assert.equal((await invoke(news,{body:{action:'bug',id:u.id,text:'x'},headers:H(mkUser())})).code,403);
    assert.equal((await bug(u,'')).code,400);assert.equal((await bug(u,'   \n ')).code,400);assert.equal((await bug(u,12345)).code,400);
    assert.equal((await bug(u,'слово '.repeat(1001))).code,413);assert.equal((await bug(u,'я'.repeat(13000))).code,413);
    assert.equal(await proxy.run(['GET','mono:bug:v1:cnt:'+u.id]),null);
    const first=await bug(u,'Не открывается чат',{meta:{v:'4.8.0',os:'Windows 11',theme:'dark',evil:'<b>x</b>'}});assert.equal(first.code,201);assert.equal(first.body.left,2);assert.equal(first.body.words,3);
    const max=await bug(u,'слово '.repeat(1000));assert.equal(max.code,201);assert.equal(max.body.left,1);
    assert.equal((await bug(u,'Третья проблема')).body.left,0);
    const fourth=await bug(u,'Четвёртая');assert.equal(fourth.code,429);assert.equal(fourth.body.left,0);assert.ok(fourth.body.retryAfter>3000&&fourth.body.retryAfter<=86400);
    const ttl=await proxy.run(['TTL','mono:bug:v1:cnt:'+u.id]);assert.ok(ttl>0&&ttl<=86400);
    assert.equal((await bug(bob,'Мой отчёт')).code,201);    // у другого пользователя свой лимит
  });
  await t('баг-репорты в консоли админа: текст, автор, версия; статусы; удаление; чужие поля очищены',async()=>{
    const r=await call({op:'bugs'},s1);assert.equal(r.code,200);assert.equal(r.body.counts.new,4);
    const mine=r.body.items.find(x=>x.text==='Не открывается чат');assert.equal(mine.nick,'Алиса');assert.equal(mine.meta.v,'4.8.0');assert.equal(mine.meta.evil,undefined);assert.equal(mine.words,3);
    assert.ok(r.body.items.some(x=>x.words===1000));
    assert.equal((await call({op:'bug-status',rid:mine.rid,status:'done'},s2)).code,200);
    assert.equal((await call({op:'bugs',status:'done'},s1)).body.items.length,1);assert.equal((await call({op:'bugs',status:'new'},s1)).body.items.length,3);
    assert.equal((await call({op:'bug-status',rid:mine.rid,status:'hack'},s1)).code,400);assert.equal((await call({op:'bug-status',rid:'ffffffff-ffff',status:'seen'},s1)).code,404);
    assert.equal((await call({op:'bug-delete',rid:mine.rid},s1)).code,200);assert.equal((await call({op:'bugs'},s1)).body.items.length,3);
  });
  await t('забаненный не может слать баг-репорты; хранится не более 1000 отчётов',async()=>{
    const u=mkUser();await invoke(messages,{body:{action:'ping',id:u.id},headers:H(u)});await call({op:'ban',id:u.id,reason:'x'},s1);
    const r=await bug(u,'Пустите');assert.equal(r.code,403);assert.equal(r.body.banned,true);
    const many=[];for(let i=0;i<1005;i++)many.push(['ZADD','mono:bug:v1:idx',String(1000+i),'r'+String(i).padStart(10,'0')]);
    for(const c of many)await proxy.run(c);await proxy.run(['DEL','mono:bug:v1:cnt:'+bob.id]);
    assert.equal((await bug(bob,'Ещё один')).code,201);assert.ok(Number(await proxy.run(['ZCARD','mono:bug:v1:idx']))<=1000);
  });

  // ---- журнал ----
  await t('журнал действий: записано кто и что делал, пароли и токены не попадают в журнал',async()=>{
    const a=await call({op:'audit'},s1);assert.equal(a.code,200);
    const ops=new Set(a.body.items.map(x=>x.op));for(const need of ['login','ban','unban','silver+','silver-','medal-grant','medal-revoke','elo-set','elo-reset-all','elo-restore','announce','announce-delete','bug-status','bug-delete'])assert.ok(ops.has(need),'нет '+need);
    const text=JSON.stringify(a.body);assert.ok(!text.includes(PASS1)&&!text.includes(PASS2)&&!text.includes(s1)&&!text.includes(s2));
    assert.ok(a.body.items.every(x=>x.name==='Первый'||x.name==='Второй'));
    const dump=JSON.stringify(await Promise.all((await proxy.run(['KEYS','*'])).map(async k=>[k,await proxy.run(['TYPE',k]).then(async ty=>ty==='string'?proxy.run(['GET',k]):ty==='list'?proxy.run(['LRANGE',k,0,-1]):ty==='hash'?proxy.run(['HGETALL',k]):ty==='set'?proxy.run(['SMEMBERS',k]):null)])));
    assert.ok(!dump.includes(PASS1)&&!dump.includes(PASS2),'пароль найден в Redis');
  });
  await t('выход закрывает сессию',async()=>{
    assert.equal((await call({op:'logout'},s2)).code,200);assert.equal((await call({op:'me'},s2)).code,401);
  });
  console.log('\nпройдено',passed);proxy.close();
})().catch(e=>{console.error(e);process.exit(1)});
