'use strict';
// Local development: PORT=8787 node dev-server.cjs. Requires Upstash vars for real signaling.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {URL}=require('node:url');
const handlers={'/api/signal':require('./api/signal'),'/api/health':require('./api/health'),'/api/news':require('./api/news'),'/api/release':require('./api/release')};
const port=Number(process.env.PORT||8787);
http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/'&&req.method==='GET'){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    fs.createReadStream(path.join(__dirname,'index.html')).pipe(res);return;
  }
  const handler=handlers[url.pathname];if(!handler){res.writeHead(404);res.end('Not found');return}
  const chunks=[];let bytes=0;
  req.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536){req.destroy();return}chunks.push(chunk)});
  req.on('end',async()=>{
    req.query=Object.fromEntries(url.searchParams);
    const input=Buffer.concat(chunks).toString('utf8');
    try{req.body=input?JSON.parse(input):null}catch(_){req.body=input}
    res.status=n=>{res.statusCode=n;return res};
    res.json=data=>{res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(data))};
    try{await handler(req,res)}catch(e){console.error(e);res.writeHead(500);res.end(JSON.stringify({error:'Internal error'}))}
  });
}).listen(port,()=>console.log('Mono Messenger API: http://localhost:'+port));
