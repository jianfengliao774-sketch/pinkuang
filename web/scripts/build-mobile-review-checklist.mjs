import fs from 'node:fs';
const source=new URL('../lib/mobile-review-v8-scenarios.js',import.meta.url);
let code=fs.readFileSync(source,'utf8');
for(const name of ['demo-data','catalog'])code=code.replace(`'./${name}'`,JSON.stringify(new URL(`../lib/${name}.js`,import.meta.url).href));
const {reviewScenarios,reviewGaps}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
if(reviewScenarios.length!==90||new Set(reviewScenarios.map(x=>x.id)).size!==90)throw Error('Scenario count/identity mismatch');
const md=['# 拼矿 BEMine · 手机端审查清单 v8','', '基准：2026-09-26 · 20260926-rewards-v8','', '共 90 项。尺寸可选 360 / 390 / 430 px；支持中文、English、日常、深色。','',...reviewScenarios.flatMap(x=>[`## ${x.id} · ${x.title}`,'',`入口：${x.entry}`,x.note?`说明：${x.note}`:'','- [ ] 已审查','','修改意见：','','']), '## 尚未开放的功能与演示边界','',...reviewGaps.flatMap(x=>[`### ${x.title}`,'',x.detail,''])].join('\n');
fs.writeFileSync(new URL('../public/review-files/bemine-mobile-review-v8.md',import.meta.url),md.trimEnd()+'\n');
console.log('90 unique mobile scenarios; static checklist generated.');
