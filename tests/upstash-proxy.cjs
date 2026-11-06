'use strict';
/* Тестовый заменитель Upstash REST: принимает те же HTTP-запросы ([команда...] и /pipeline) и выполняет их
   в настоящем redis-server (с Lua). Используется только тестами: node tests/upstash-proxy.cjs */
const net=require('node:net'),http=require('node:http');
function encode(args){let s='*'+args.length+'\r\n';for(const a of args){const b=Buffer.from(String(a));s+='$'+b.length+'\r\n'+b.toString('binary')+'\r\n'}return Buffer.from(s,'binary')}
function parse(buf,pos=0){
  const nl=buf.indexOf('\r\n',pos);if(nl<0)return null;
  const t=String.fromCharCode(buf[pos]),line=buf.toString('utf8',pos+1,nl);let next=nl+2;
  if(t==='+')return [line,next];
  if(t==='-')return [{error:line},next];
  if(t===':')return [Number(line),next];
  if(t==='$'){const n=Number(line);if(n<0)return [null,next];if(buf.length<next+n+2)return null;return [buf.toString('utf8',next,next+n),next+n+2]}
  if(t==='*'){const n=Number(line);if(n<0)return [null,next];const out=[];for(let i=0;i<n;i++){const r=parse(buf,next);if(!r)return null;out.push(r[0]);next=r[1]}return [out,next]}
  throw Error('bad RESP '+t);
}
function createProxy(redisPort,listenPort=0){
  const sock=net.connect(redisPort,'127.0.0.1');let buf=Buffer.alloc(0);const waiters=[];
  sock.on('data',d=>{buf=Buffer.concat([buf,d]);for(;;){const r=waiters.length?parse(buf):null;if(!r)break;buf=buf.subarray(r[1]);waiters.shift()(r[0])}});
  let chain=Promise.resolve();
  const run=args=>chain=chain.then(()=>new Promise(res=>{waiters.push(res);sock.write(encode(args))}));
  const conv=r=>r&&typeof r==='object'&&!Array.isArray(r)&&r.error?{error:r.error}:{result:r};
  const server=http.createServer((req,res)=>{
    const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',async()=>{
      try{
        if(req.headers.authorization!=='Bearer test-token'){res.writeHead(401);return res.end('{"error":"unauthorized"}')}
        const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const out=req.url==='/pipeline'?await Promise.all(body.map(a=>run(a.map(String)).then(conv))):conv(await run(body.map(String)));
        res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(out));
      }catch(e){res.writeHead(500);res.end(JSON.stringify({error:String(e.message)}))}
    });
  });
  return new Promise(resolve=>server.listen(listenPort,'127.0.0.1',()=>resolve({server,port:server.address().port,run,close:()=>{server.close();sock.destroy()}})));
}
module.exports={createProxy};
if(require.main===module){createProxy(Number(process.env.REDIS_PORT||6390),Number(process.env.PORT||8788)).then(p=>console.log('Upstash proxy on',p.port))}
