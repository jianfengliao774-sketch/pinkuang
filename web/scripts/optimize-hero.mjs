// Re-encode authored assets at bounded display sizes. Content hashes make long-lived caching safe.
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
const sharp=require(require.resolve('sharp',{paths:[dirname(require.resolve('next/package.json'))]}));
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const imageDir=resolve(root,'public/images');
const sources={background:'bemine-background-v2.png',chip:'bemine-chip-t-v4.png',coin:'bemine-coin-v2.png'};
const widths={background:{mobile:960,desktop:1440},chip:{mobile:640,desktop:960},coin:{mobile:240,desktop:400}};
const manifest={};
for(const [kind,name] of Object.entries(sources)){
 manifest[kind]={};
 for(const [variant,width] of Object.entries(widths[kind])){
  const result=await sharp(resolve(imageDir,name)).resize({width,withoutEnlargement:true}).webp({quality:kind==='background'?76:83,alphaQuality:100,effort:5}).toBuffer({resolveWithObject:true});
  const hash=createHash('sha256').update(result.data).digest('hex').slice(0,12);
  const filename=`bemine-${kind}-${variant}.${hash}.webp`;
  await writeFile(resolve(imageDir,filename),result.data);
  manifest[kind][variant]={file:filename,bytes:result.data.length,width:result.info.width,height:result.info.height};
 }
}
await writeFile(resolve(root,'lib/hero-assets.json'),JSON.stringify(manifest,null,2)+'\n');
const before=(await Promise.all(['bemine-background-v2.png','bemine-chip-v2.png','bemine-coin-v2.png'].map(n=>stat(resolve(imageDir,n))))).reduce((s,v)=>s+v.size,0);
const totals=Object.fromEntries(['mobile','desktop'].map(v=>[v,Object.values(manifest).reduce((s,a)=>s+a[v].bytes,0)]));
console.log(JSON.stringify({previousBytes:before,...totals,assets:manifest},null,2));
