'use strict';
// Run 'npm start' in this folder for local signaling testing.
// Requires the same Upstash environment variables as Vercel.
const http=require('node:http');
const {URL}=require('node:url');
const handler=require('./api/signal');
const port=Number(process.env.PORT||8787);
http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const query=Object.fromEntries(url.searchParams);
  if(url.pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true}));return}
  if(url.pathname!=='/api/signal'){res.writeHead(404);res.end();return}
  const chunks=[];req.on('data',b=>{chunks.push(b);if(Buffer.concat(chunks).length>60000)req.destroy()});
  req.on('end',async()=>{
    req.query=query;req.body=Buffer.concat(chunks).toString('utf8');
    res.status=n=>{res.statusCode=n;return res};res.json=data=>res.end(JSON.stringify(data));
    try{await handler(req,res)}catch(e){res.writeHead(500);res.end(JSON.stringify({error:'Internal error'}))}
  });
}).listen(port,()=>console.log('Mono signaling on http://localhost:'+port));
