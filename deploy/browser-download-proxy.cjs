const http=require('node:http');
http.createServer((req,res)=>{
 const path=req.url;
 if(!/^\/builds\/[a-z0-9._/-]+$/.test(path)){res.writeHead(404).end();return;}
 const target=path.startsWith('/builds/cft/')
  ? 'https://cdn.npmmirror.com/binaries/chrome-for-testing/'+path.slice('/builds/cft/'.length)
  : 'https://cdn.npmmirror.com/binaries/playwright'+path;
 res.writeHead(307,{Location:target}).end();
}).listen(8080,'0.0.0.0');
