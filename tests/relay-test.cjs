'use strict';
const assert=require('node:assert/strict');
const api=require('../api/messages');
const health=require('../api/health');
const storage=new Map();
const sets=new Map();
const hashes=new Map();
const sorted=new Map();
let clock=Date.now();
function result(command){
  const [op,...a]=command;const k=String(a[0]);
  if(op==='PING')return 'PONG';
  if(op==='GET')return storage.get(k)||null;
  if(op==='SET'){
    if(a.includes('NX')&&storage.has(k))return null;
    storage.set(k,String(a[1]));return 'OK';
  }
  if(op==='EXPIRE')return 1;
  if(op==='HSET'){
    const table=hashes.get(k)||new Map();hashes.set(k,table);
    table.set(String(a[1]),String(a[2]));return 1;
  }
  if(op==='HDEL'){
    let n=0;for(const id of a.slice(1))if(hashes.get(k)?.delete(id))n++;return n;
  }
  if(op==='HMGET')return a.slice(1).map(id=>hashes.get(k)?.get(id)||null);
  if(op==='ZADD'){
    const m=sorted.get(k)||new Map();sorted.set(k,m);m.set(String(a[2]),Number(a[1]));return 1;
  }
  if(op==='ZCARD')return (sorted.get(k)||new Map()).size;
  if(op==='ZREM'){
    let n=0;for(const id of a.slice(1))if(sorted.get(k)?.delete(id))n++;return n;
  }
  if(op==='ZRANGE'){
    const data=[...(sorted.get(k)||new Map()).entries()].sort((x,y)=>x[1]-y[1]).map(([id])=>id);
    const end=Number(a[2]);return data.slice(Number(a[1]),end<0?undefined:end+1);
  }
  throw Error('Mock Redis unimplemented '+JSON.stringify(command));
}
global.fetch=async(url,opts)=>{
  const endpoint=new URL(url).pathname;
  const data=JSON.parse(opts.body);
  const body=endpoint==='/pipeline'?data.map(c=>({result:result(c)})):{result:result(data)};
  return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
};
process.env.UPSTASH_REDIS_REST_URL='https://mock-redis.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN='mock-secret';
const A='MONO-'+'A'.repeat(20),B='MONO-'+'B'.repeat(20);
function request(method,params,token){
  let resp={code:0,body:null,headers:{},setHeader(k,v){this.headers[k]=v},status(v){this.code=v;return this},json(v){this.body=v;return this},end(){return this}};
  const req={method,query:method==='GET'?params:{},body:method==='POST'?params:undefined,headers:{'x-mono-token':token||''}};
  return api(req,resp).then(()=>resp);
}
(async()=>{
  const tokenA='12345678901234567890123456789012';
  const tokenB='abcdefghijklmnopqrstuvwx12345678';
  const ping=await request('POST',{action:'ping',id:A},tokenA);assert.equal(ping.code,200);
  const pub={type:'hello',profile:{nick:'Пётр',avatar:'data:image/jpeg;base64,xyz',links:[{type:'telegram',url:'https://t.me/mono'}]},requestReply:true};
  const accepted=await request('POST',{action:'send',from:A,to:B,payload:pub,id:'msgprofile000001'},tokenA);
  assert.equal(accepted.code,202);
  const withoutToken=await request('GET',{id:B,action:'poll'},'');assert.equal(withoutToken.code,403);
  const poll1=await request('GET',{id:B,action:'poll'},tokenB);
  assert.equal(poll1.code,200);assert.equal(poll1.body.messages.length,1);
  assert.equal(poll1.body.messages[0].payload.profile.nick,'Пётр');
  const poll2=await request('GET',{id:B,action:'poll'},tokenB);
  assert.equal(poll2.body.messages.length,1,'remains until ACK');
  const ack=await request('POST',{action:'ack',id:B,ids:['msgprofile000001']},tokenB);
  assert.equal(ack.code,200);
  const afterAck=await request('GET',{id:B,action:'poll'},tokenB);
  assert.equal(afterAck.body.messages.length,0,'deleted after ACK');
  const wrongToken=await request('GET',{id:B,action:'poll'},tokenA);
  assert.equal(wrongToken.code,403);
  const message=await request('POST',{action:'send',from:A,to:B,id:'text-message0002',payload:{type:'text',text:'Привет!'}},tokenA);
  assert.equal(message.code,202);
  const received=await request('GET',{id:B,action:'poll'},tokenB);
  assert.equal(received.body.messages[0].payload.text,'Привет!');
  const bigData='A'.repeat(130000);
  const file=await request('POST',{action:'send',from:A,to:B,id:'filechunk0000001',payload:{type:'blob-chunk',key:'00112233445566778899aabbccddeeff',index:0,data:bigData}},tokenA);
  assert.equal(file.code,202);
  const filePoll=await request('GET',{id:B,action:'poll'},tokenB);
  assert(filePoll.body.messages.some(m=>m.payload.type==='blob-chunk'));
  // Friend requests and game invitations share the authenticated temporary relay.
  for(const [tag,to,token,from,fromToken,payload] of [
    ['friendRequest0001',B,tokenB,A,tokenA,{type:'friend-request',profile:{nick:'Alice'}}],
    ['friendAccept0001',A,tokenA,B,tokenB,{type:'friend-response',accepted:true,profile:{nick:'Bob'}}],
    ['chessGame0000001',B,tokenB,A,tokenA,{type:'game',game:'chess',payload:{action:'invite',room:'CH-'+'b'.repeat(20),round:1}}],
    ['ticGame00000001',A,tokenA,B,tokenB,{type:'game',game:'tic',payload:{action:'invite',room:'TT-'+'c'.repeat(20),round:1}}]
  ]){
    const sent=await request('POST',{action:'send',from,to,id:tag,payload},fromToken);
    assert.equal(sent.code,202,`relay accepted ${tag}`);
    const inbox=await request('GET',{id:to,action:'poll'},token);
    assert(inbox.body.messages.some(x=>x.id===tag && x.payload.type===payload.type),`delivery of ${tag}`);
    const acknowledged=await request('POST',{action:'ack',id:to,ids:[tag]},token);
    assert.equal(acknowledged.code,200);
  }
  const malformed=await request('POST',{action:'send',from:A,to:B,id:'invalidGame00001',payload:{type:'game',game:'bad-game',payload:{action:'move'}}},tokenA);
  assert.equal(malformed.code,400,'unknown game types rejected');
  const h={setHeader(){},status(code){this.code=code;return this},json(v){this.body=v;return this},end(){}};
  await health({method:'GET'},h);assert.equal(h.code,200);assert.equal(h.body.redis,'connected');
  console.log('PASS: authenticated send/poll/ACK, no premature deletion, profile, text, large chunk, friend requests, friend acceptance, chess and tic network, health');
})().catch(e=>{console.error(e);process.exitCode=1});
