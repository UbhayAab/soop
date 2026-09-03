import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const ROOT=path.resolve(new URL('..',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
const M={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
const s=http.createServer((q,r)=>{let f=path.join(ROOT,decodeURIComponent(new URL(q.url,'http://x').pathname));
 if(fs.existsSync(f)&&fs.statSync(f).isDirectory())f=path.join(f,'index.html');
 fs.readFile(f,(e,b)=>{if(e){r.writeHead(404).end();return;}r.writeHead(200,{'content-type':M[path.extname(f)]||'application/octet-stream'});r.end(b);});});
await new Promise(r=>s.listen(0,'127.0.0.1',r));
const BASE=process.env.PROBE_BASE||`http://127.0.0.1:${s.address().port}`;
const OUT='C:/Users/abhay/AppData/Local/Temp/claude/C--Users-abhay-Desktop/98be7254-9e53-41bc-aeb1-db700f3e1159/scratchpad';
const b=await chromium.launch();
for(const [w,h,tag] of [[390,844,'phone'],[1280,900,'desktop']]){
  const p=await b.newPage({viewport:{width:w,height:h},deviceScaleFactor:2});
  await p.goto(BASE,{waitUntil:'networkidle'});
  await p.waitForSelector('#email',{state:'visible',timeout:60000});
  await p.waitForTimeout(1200);
  const fields=await p.evaluate(()=>[...document.querySelectorAll('#auth input,#auth button')]
    .filter(n=>n.offsetParent!==null)
    .map(n=>({tag:n.tagName,id:n.id,
      label:n.closest('label')?.querySelector('.field-label')?.textContent||n.textContent.trim().slice(0,44),
      ph:n.placeholder||''})));
  console.log(tag, JSON.stringify(fields,null,1));
  await p.screenshot({path:`${OUT}/auth-${tag}.png`, fullPage:true});
  await p.close();
}
await b.close(); s.close();
