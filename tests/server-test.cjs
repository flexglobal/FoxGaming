'use strict';
/* Интеграционные тесты сервера на настоящем Redis (redis-server на :6390) через заменитель Upstash REST.
   Запуск: redis-server --port 6390 --save "" --daemonize yes && node tests/server-test.cjs */
const assert=require('node:assert/strict');
const {createProxy}=require('./upstash-proxy.cjs');
const hex=n=>[...Array(n)].map(()=>'0123456789ABCDEF'[Math.floor(Math.random()*16)]).join('');
const mkUser=()=>({id:'MONO-'+hex(20),token:hex(40)});
function invoke(handler,{method='POST',body=null,query={},headers={}}){
  return new Promise((resolve,reject)=>{
    const res={headers:{},setHeader(k,v){this.headers[k]=v},status(c){this.code=c;return this},json(o){resolve({code:this.code,body:o,headers:this.headers})},end(){resolve({code:this.code,body:null,headers:this.headers})}};
    Promise.resolve(handler({method,body,query,headers},res)).catch(reject);
  });
}
(async()=>{
  const proxy=await createProxy(6390,0);
  process.env.UPSTASH_REDIS_REST_URL='http://127.0.0.1:'+proxy.port;process.env.UPSTASH_REDIS_REST_TOKEN='test-token';
  process.env.MONO_ADMIN_TOKEN='admin-token-'+hex(30);
  await proxy.run(['FLUSHALL']);
  const messages=require('../api/messages'),profile=require('../api/profile'),chess=require('../api/chess'),channels=require('../api/channels'),activity=require('../api/game-activity'),admin=require('../api/admin');
  const C=require('../lib/chess-engine');
  const H=u=>({'x-mono-token':u.token});
  const as=(h,u,body,method='POST',query={})=>invoke(h,{method,body:{id:u.id,...body},query,headers:H(u)});
  let passed=0;const t=async(name,fn)=>{try{await fn();passed++;console.log('ok  ',name)}catch(e){console.log('FAIL',name,'\n    ',e.message.split('\n').slice(0,4).join('\n     '));process.exitCode=1}};

  // ---------- Аккаунт и угон ID ----------
  const alice=mkUser(),bob=mkUser(),eve=mkUser();
  await t('первый ping закрепляет владельца и дату регистрации',async()=>{
    const r=await invoke(messages,{body:{action:'ping',id:alice.id},headers:H(alice)});assert.equal(r.code,200);
    assert.equal(await proxy.run(['GET','mono:acct:v1:owner:'+alice.id]).then(x=>typeof x),'string');
    assert.ok(Number(await proxy.run(['HGET','mono:acct:v1:created',alice.id]))>0);
  });
  await t('после истечения сессии чужой токен НЕ может занять ID (угон)',async()=>{
    await proxy.run(['DEL','mono:r3:auth:'+alice.id]);
    const r=await invoke(messages,{body:{action:'ping',id:alice.id},headers:H(eve)});assert.equal(r.code,403);
    const ok=await invoke(messages,{body:{action:'ping',id:alice.id},headers:H(alice)});assert.equal(ok.code,200);
  });
  await t('профиль и шахматы с истёкшей сессией работают для владельца и закрыты для чужих',async()=>{
    await proxy.run(['DEL','mono:r3:auth:'+alice.id]);
    assert.equal((await as(chess,alice,{action:'leaderboard'})).code,200);
    await proxy.run(['DEL','mono:r3:auth:'+alice.id]);
    assert.equal((await as(chess,eve,{id:alice.id,action:'leaderboard'},'POST')).code,403);
  });

  // ---------- Медали ----------
  await t('профиль: медали приходят отдельным полем и не берутся из профиля клиента',async()=>{
    const r=await as(profile,alice,{profile:{nick:'Alice',bio:'hi',specialBadges:['staff','chess_top1'],verifiedBadges:['staff']}});assert.equal(r.code,200);
    const g=await invoke(profile,{method:'GET',query:{id:alice.id}});assert.equal(g.code,200);
    assert.deepEqual(g.body.verifiedBadges,[]);assert.equal(g.body.profile.specialBadges,undefined);assert.equal(g.body.gameActivity,null);
  });
  const adminReq=(body,token=process.env.MONO_ADMIN_TOKEN)=>invoke(admin,{body,headers:{'x-mono-admin':token}});
  await t('admin: без токена/с чужим токеном — 403; выдача beta/staff/bug_hunter',async()=>{
    assert.equal((await adminReq({action:'grant',id:alice.id,role:'beta'},'x'.repeat(40))).code,403);
    assert.equal((await invoke(admin,{body:{action:'grant',id:alice.id,role:'beta'}})).code,403);
    assert.equal((await adminReq({action:'grant',id:alice.id,role:'vip'})).code,400);
    for(const role of ['beta','staff','bug_hunter'])assert.equal((await adminReq({action:'grant',id:alice.id,role})).code,200);
    const g=await invoke(profile,{method:'GET',query:{id:alice.id}});
    assert.deepEqual(g.body.verifiedBadges.sort(),['beta','bug_hunter','staff']);
  });
  await t('год в Mono считает сервер по дате регистрации (1,2,5 лет)',async()=>{
    const day=86400000,now=Date.now();
    for(const [years,expect] of [[0.5,null],[1.01,'year'],[2.2,'year2'],[7,'year5']]){
      assert.equal((await adminReq({action:'set-created',id:alice.id,at:Math.floor(now-years*365.25*day)})).code,200);
      const b=(await invoke(profile,{method:'GET',query:{id:alice.id}})).body.verifiedBadges;
      const y=b.find(x=>/^year/.test(x))||null;assert.equal(y,expect,years+' лет → '+JSON.stringify(b));
    }
  });
  await t('VIP: срок действия и бессрочно',async()=>{
    await adminReq({action:'set-vip',id:alice.id,days:30});
    assert.ok((await invoke(profile,{method:'GET',query:{id:alice.id}})).body.verifiedBadges.includes('vip'));
    await proxy.run(['HSET','mono:acct:v1:vip',alice.id,String(Date.now()-1000)]);
    assert.ok(!(await invoke(profile,{method:'GET',query:{id:alice.id}})).body.verifiedBadges.includes('vip'));
    await adminReq({action:'set-vip',id:alice.id,days:-1});
    assert.ok((await invoke(profile,{method:'GET',query:{id:alice.id}})).body.verifiedBadges.includes('vip'));
    await adminReq({action:'set-vip',id:alice.id,days:0});
    assert.ok(!(await invoke(profile,{method:'GET',query:{id:alice.id}})).body.verifiedBadges.includes('vip'));
  });
  await t('топ-3 шахмат из серверного ELO (нужно >200)',async()=>{
    await proxy.run(['ZADD','mono:chess:v1:ratings',500,alice.id,400,bob.id,300,eve.id,200,'MONO-'+hex(20)]);
    const top=async u=>(await invoke(profile,{method:'GET',query:{id:u.id}})).body?.verifiedBadges?.filter(x=>x.startsWith('chess'));
    await as(profile,bob,{profile:{nick:'Bob'}});await as(profile,eve,{profile:{nick:'Eve'}});
    assert.deepEqual(await top(alice),['chess_top1']);assert.deepEqual(await top(bob),['chess_top2']);assert.deepEqual(await top(eve),['chess_top3']);
    await proxy.run(['ZADD','mono:chess:v1:ratings',200,alice.id]);assert.deepEqual(await top(alice),[]);
  });

  // ---------- Играет в ----------
  await t('game-activity: каталог, лимит, очистка, чужой токен',async()=>{
    const png='data:image/png;base64,'+Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.alloc(100)]).toString('base64');
    const post=(u,activityObj,extra={})=>invoke(activity,{body:{monoId:u.id,activity:activityObj,...extra},headers:H(u)});
    assert.equal((await post(eve,{gameId:'cs2'},{monoId:alice.id})).code,403);
    assert.equal((await post(alice,{gameId:'evil.exe',name:'Free Robux',details:'x'})).code,400);
    const ok=await post(alice,{gameId:'cs2',name:'Подмена названия',details:'Dust2 <b>',iconPng:png,startedAt:Date.now()-60000});
    assert.equal(ok.code,200);assert.equal(ok.body.activity.name,'Counter-Strike 2');assert.ok(!ok.body.activity.details.includes('<'));
    assert.equal((await post(alice,{gameId:'dota2'})).code,429);
    const g=(await invoke(profile,{method:'GET',query:{id:alice.id}})).body.gameActivity;
    assert.equal(g.gameId,'cs2');assert.ok(g.updatedAt>1e12);assert.ok(g.iconDataUrl.startsWith('data:image/png'));
    assert.ok((await proxy.run(['TTL','mono:activity:v1:'+alice.id]))<=720);
    assert.equal((await post(alice,{gameId:'cs2',iconPng:'data:image/png;base64,AAAA'})).code,429);
    assert.equal((await post(alice,null)).code,200);
    assert.equal((await invoke(profile,{method:'GET',query:{id:alice.id}})).body.gameActivity,null);
  });

  // ---------- Каналы ----------
  const owner=mkUser(),reader=mkUser(),third=mkUser();
  let ch;
  await t('каналы: создание, поиск по названию и по ID, подписка',async()=>{
    const r=await as(channels,owner,{action:'create',title:'  Новости Mono  ',bio:'О продукте',accent:'#ff00aa',settings:{comments:true}});
    assert.equal(r.code,200);ch=r.body.channel;assert.match(ch.id,/^C-[a-f0-9]{20}$/);assert.equal(ch.role,'owner');assert.equal(ch.title,'Новости Mono');
    const s=await as(channels,reader,{action:'search',q:'новости'});assert.equal(s.body.results[0].id,ch.id);
    assert.equal((await as(channels,reader,{action:'search',q:ch.id})).body.results[0].title,'Новости Mono');
    assert.equal((await as(channels,reader,{action:'search',q:'a'})).body.results.length,0);
    const sub=await as(channels,reader,{action:'subscribe',channelId:ch.id});assert.equal(sub.body.channel.role,'subscriber');assert.equal(sub.body.channel.subscriberCount,2);
    assert.equal((await as(channels,reader,{action:'mine'})).body.channels.length,1);
  });
  await t('каналы: публиковать может только владелец/админ; XSS-символы режутся',async()=>{
    assert.equal((await as(channels,reader,{action:'post',channelId:ch.id,text:'взлом'})).code,403);
    const p=await as(channels,owner,{action:'post',channelId:ch.id,text:'Привет, подписчики!\u0000',color:'#112233'});assert.equal(p.code,200);
    assert.equal(p.body.channel.posts.length,1);assert.equal(p.body.channel.posts[0].text,'Привет, подписчики!');
    assert.equal((await as(channels,owner,{action:'post',channelId:ch.id,text:'   '})).code,400);
  });
  await t('каналы: комментарии, лайк-переключатель, права на удаление',async()=>{
    const pid=(await as(channels,reader,{action:'get',channelId:ch.id})).body.channel.posts[0].id;
    const c1=await as(channels,reader,{action:'comment',channelId:ch.id,postId:pid,text:'Круто'});assert.equal(c1.code,200);
    assert.equal(c1.body.channel.posts[0].commentCount,1);
    await new Promise(r=>setTimeout(r,1600));
    const list=(await as(channels,owner,{action:'comments',channelId:ch.id,postId:pid})).body.comments;assert.equal(list.length,1);assert.equal(list[0].author,reader.id);
    assert.equal((await as(channels,third,{action:'delete-comment',channelId:ch.id,postId:pid,commentId:list[0].id})).code,403);
    const l1=await as(channels,reader,{action:'like',channelId:ch.id,postId:pid});assert.equal(l1.body.channel.posts[0].likes,1);assert.equal(l1.body.channel.posts[0].liked,true);
    await new Promise(r=>setTimeout(r,450));
    const l2=await as(channels,reader,{action:'like',channelId:ch.id,postId:pid});assert.equal(l2.body.channel.posts[0].likes,0);
    assert.equal((await as(channels,reader,{action:'delete-comment',channelId:ch.id,postId:pid,commentId:list[0].id})).code,200);
    assert.equal((await as(channels,owner,{action:'get',channelId:ch.id})).body.channel.posts[0].commentCount,0);
  });
  await t('каналы: настройки (только владелец), закрытые комментарии, скрытие из поиска, админы',async()=>{
    assert.equal((await as(channels,reader,{action:'update',channelId:ch.id,title:'Мой'})).code,403);
    const u=await as(channels,owner,{action:'update',channelId:ch.id,title:'Mono Daily',bio:'x',accent:'#00ff00',settings:{subscribersOnly:true,listed:false}});
    assert.equal(u.code,200);assert.equal(u.body.channel.title,'Mono Daily');
    assert.equal((await as(channels,third,{action:'search',q:'mono daily'})).body.results.length,0,'unlisted не в поиске');
    assert.equal((await as(channels,third,{action:'search',q:'новости'})).body.results.length,0,'старое имя удалено из индекса');
    const pid=(await as(channels,owner,{action:'get',channelId:ch.id})).body.channel.posts[0].id;
    await new Promise(r=>setTimeout(r,1300));
    assert.equal((await as(channels,third,{action:'comment',channelId:ch.id,postId:pid,text:'я не подписан'})).code,403);
    assert.equal((await as(channels,owner,{action:'add-admin',channelId:ch.id,adminId:third.id})).body.channel.admins[0],third.id);
    assert.equal((await as(channels,third,{action:'post',channelId:ch.id,text:'пост админа'})).code,200);
    assert.equal((await as(channels,third,{action:'add-admin',channelId:ch.id,adminId:reader.id})).code,403);
    assert.equal((await as(channels,owner,{action:'remove-admin',channelId:ch.id,adminId:third.id})).body.channel.admins.length,0);
    assert.equal((await as(channels,owner,{action:'unsubscribe',channelId:ch.id})).code,400);
  });
  await t('каналы: без токена/чужим токеном нельзя; удаление владельцем чистит данные',async()=>{
    assert.equal((await invoke(channels,{body:{id:owner.id,action:'mine'},headers:H(eve)})).code,403);
    assert.equal((await as(channels,reader,{action:'delete',channelId:ch.id})).code,403);
    const d=await as(channels,owner,{action:'delete',channelId:ch.id});assert.equal(d.code,200);
    assert.equal((await as(channels,owner,{action:'get',channelId:ch.id})).code,404);
    assert.equal((await as(channels,reader,{action:'mine'})).body.channels.length,0,'у подписчика висячая ссылка очищена');
    const keys=await proxy.run(['KEYS','mono:chan:v1:*'+ch.id+'*']);assert.deepEqual(keys,[]);
  });
  await t('каналы: лимит 10 владельческих каналов',async()=>{
    const u=mkUser();let last;
    for(let i=0;i<11;i++){await proxy.run(['DEL','mono:chan:v1:rl:create:'+u.id]);last=await as(channels,u,{action:'create',title:'Канал '+i})}
    assert.equal(last.code,400);
  });

  // ---------- Шахматы ----------
  const w=mkUser(),b=mkUser();
  const q=(u)=>as(chess,u,{action:'queue',nickname:u===w?'W':'B'});
  const pick=(white,black,res)=>res.body.match.white===white.id?[white,black]:[black,white];
  const toMove=(state)=>{const m=C.legal(state)[0];return m};
  async function startRanked(){
    const a=mkUser(),c=mkUser();
    const r1=await as(chess,a,{action:'queue'});assert.equal(r1.body.searching,true);
    const r2=await as(chess,c,{action:'queue'});assert.ok(r2.body.match,'второй игрок сразу получает матч');
    const r1b=await as(chess,a,{action:'queue'});assert.equal(r1b.body.match.id,r2.body.match.id);
    const white=r2.body.match.white===a.id?a:c,black=white===a?c:a;
    return {white,black,id:r2.body.match.id,match:r2.body.match};
  }
  await t('шахматы: подбор → ходы → мат/сдача начисляет ELO ровно один раз',async()=>{
    const g=await startRanked();
    let st=C.start();
    const ids=(mover)=>({action:'move',matchId:g.id});
    // Дублирующий и устаревший ход
    const m1=C.legal(st).find(m=>C.moveUci(m)==='e2e4');
    let r=await as(chess,g.white,{...ids(),uci:'e2e4',seq:0});assert.equal(r.code,200);
    const dup=await as(chess,g.white,{...ids(),uci:'e2e4',seq:0});assert.equal(dup.code,200);assert.equal(dup.body.duplicate,true);
    assert.equal((await as(chess,g.white,{...ids(),uci:'e7e5',seq:1})).code,400,'чужой ход');
    assert.equal((await as(chess,g.black,{...ids(),uci:'e7e5',seq:0})).code,400,'устаревшая позиция');
    assert.equal((await as(chess,g.black,{...ids(),uci:'e2e4',seq:1})).code,400,'нелегальный ход');
    assert.equal((await as(chess,g.black,{...ids(),uci:'zz',seq:1})).code,400);
    // Детский мат: e4 e5 Qh5 Nc6 Bc4 Nf6 Qxf7#
    const line=['e7e5','d1h5','b8c6','f1c4','g8f6','h5f7'];let seq=1;
    for(const uci of line){const who=seq%2===1?g.black:g.white;const rr=await as(chess,who,{...ids(),uci,seq});assert.equal(rr.code,200,uci+' '+JSON.stringify(rr.body));seq++}
    const fin=await as(chess,g.white,{action:'state',matchId:g.id});
    assert.equal(fin.body.match.finished,true,JSON.stringify(fin.body.match).slice(0,300));assert.equal(fin.body.match.winner,'w');
    const elo=async u=>Number(await proxy.run(['ZSCORE','mono:chess:v1:ratings',u.id]));
    assert.equal(await elo(g.white),250);assert.equal(await elo(g.black),190);
    // повторные запросы/сдача после конца не меняют ELO
    await as(chess,g.black,{action:'resign',matchId:g.id});await as(chess,g.white,{action:'state',matchId:g.id});
    assert.equal(await elo(g.white),250);assert.equal(await elo(g.black),190);
    assert.equal(await proxy.run(['GET','mono:chess:v1:active:'+g.white.id]),null,'активная партия очищена');
    // можно сразу искать новую
    assert.equal((await as(chess,g.white,{action:'queue'})).body.searching,true);await as(chess,g.white,{action:'cancel'});
  });
  await t('шахматы: сдача, ничья по предложению, таймаут, реакции',async()=>{
    const g=await startRanked();
    assert.equal((await as(chess,g.white,{action:'draw-offer',matchId:g.id})).code,200);
    assert.equal((await as(chess,g.white,{action:'draw-reply',matchId:g.id,accept:true})).code,400,'нельзя принять своё предложение');
    const dr=await as(chess,g.black,{action:'draw-reply',matchId:g.id,accept:true});assert.equal(dr.body.match.finished,true);assert.equal(dr.body.match.winner,null);
    const g2=await startRanked();
    const rs=await as(chess,g2.black,{action:'resign',matchId:g2.id});assert.equal(rs.body.match.winner,'w');
    const g3=await startRanked();
    const raw=JSON.parse(await proxy.run(['GET','mono:chess:v1:match:'+g3.id]));raw.clocks.w=500;raw.clockAt=Date.now()-5000;
    await proxy.run(['SET','mono:chess:v1:match:'+g3.id,JSON.stringify(raw)]);
    const to=await as(chess,g3.black,{action:'state',matchId:g3.id});assert.equal(to.body.match.finished,true);assert.equal(to.body.match.winner,'b');
    const g4=await startRanked();
    assert.equal((await as(chess,g4.white,{action:'react',matchId:g4.id,emotion:'fire'})).code,200);
    assert.equal((await as(chess,g4.white,{action:'react',matchId:g4.id,emotion:'fire'})).code,400,'антиспам эмоций');
    assert.equal((await as(chess,g4.white,{action:'react',matchId:g4.id,emotion:'<script>'})).code,400);
  });
  await t('шахматы: партия с другом — создать, принять, сыграть, реванш, отмена',async()=>{
    const a=mkUser(),f=mkUser();
    assert.equal((await as(chess,a,{action:'friend-create',friendId:a.id,seconds:300})).code,400);
    assert.equal((await as(chess,a,{action:'friend-create',friendId:f.id,seconds:7})).code,400);
    const cr=await as(chess,a,{action:'friend-create',friendId:f.id,seconds:300,side:'w'});assert.equal(cr.code,200);const gid=cr.body.match.id;
    assert.equal((await as(chess,a,{action:'friend-create',friendId:f.id,seconds:300})).code,400,'вторая активная партия');
    const j=await as(chess,f,{action:'friend-join',matchId:gid});assert.equal(j.code,200);assert.equal(j.body.match.started,true);
    assert.equal((await as(chess,mkUser(),{action:'friend-join',matchId:gid})).code,400,'посторонний не может войти');
    assert.equal((await as(chess,a,{action:'move',matchId:gid,uci:'e2e4',seq:0})).code,200);
    assert.equal((await as(chess,f,{action:'resign',matchId:gid})).code,200);
    const elo=await proxy.run(['ZSCORE','mono:chess:v1:ratings',a.id]);assert.equal(elo,null,'дружеская партия не меняет ELO');
    assert.equal((await as(chess,a,{action:'rematch',matchId:gid})).body.votes,1);
    const rm=await as(chess,f,{action:'rematch',matchId:gid});assert.equal(rm.body.match.finished,false);assert.equal(rm.body.match.white,f.id,'цвета меняются');
    assert.equal((await as(chess,a,{action:'friend-cancel',matchId:gid})).code,400,'начавшуюся нельзя отменить');
    const a2=mkUser(),f2=mkUser();const cr2=await as(chess,a2,{action:'friend-create',friendId:f2.id,seconds:0});
    assert.equal((await as(chess,a2,{action:'friend-cancel',matchId:cr2.body.match.id})).code,200);
    assert.equal((await as(chess,a2,{action:'friend-create',friendId:f2.id,seconds:180})).code,200,'после отмены можно создать снова');
  });
  await t('шахматы: таблица лидеров и страна',async()=>{
    const l=await as(chess,w,{action:'leaderboard'});assert.equal(l.code,200);assert.ok(Array.isArray(l.body.leaders));assert.equal(l.body.me.id,w.id);
    assert.equal((await as(chess,w,{action:'set-country',country:'XX'})).code,400);assert.equal((await as(chess,w,{action:'set-country',country:'KZ'})).body.country,'KZ');
    assert.equal((await as(chess,w,{action:'set-profile',nickname:'<b>'})).code,400);
  });
  await t('шахматы: два игрока в очереди одновременно не получают две партии',async()=>{
    const users=[mkUser(),mkUser(),mkUser(),mkUser()];
    const rs=await Promise.all(users.map(u=>as(chess,u,{action:'queue'})));
    for(let round=0;round<4;round++)for(let i=0;i<users.length;i++){const r=await as(chess,users[i],{action:'queue'});if(r.body.match)rs[i]=r}
    const matched=rs.filter(r=>r.body.match);const ids=new Set(matched.map(r=>r.body.match.id));
    assert.ok(matched.length>=2,'нашли минимум пару');
    for(const id of ids){const players=matched.filter(r=>r.body.match.id===id).length;assert.equal(players,2,'каждая партия ровно с двумя игроками')}
  });
  console.log('\nпройдено',passed);proxy.close();
})().catch(e=>{console.error(e);process.exit(1)});
