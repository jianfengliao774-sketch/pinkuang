import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const source=readFileSync(root+'lib/review-scenarios.js','utf8');
const data=Function(readFileSync(root+'lib/demo-data.js','utf8').replaceAll('export const ','const ')+';return {pools,orders,ledger}')();
const sortSource=readFileSync(root+'lib/catalog.js','utf8').match(/export const SORT_OPTIONS = (\[[\s\S]*?\n\]);/)[1];
const sort=Function('return '+sortSource)();
const {reviewScenarios,reviewGaps}=Function('pools','orders','ledger','SORT_OPTIONS',source.replace(/^import .*;\n/gm,'').replaceAll('export const ','const ')+';return {reviewScenarios,reviewGaps}')(data.pools,data.orders,data.ledger,sort);
const ids=new Set(reviewScenarios.map(x=>x.id));
if(ids.size!==reviewScenarios.length)throw Error('Duplicate review IDs');
for(const s of reviewScenarios){if(s.state.poolId&&!data.pools.some(p=>p.id===s.state.poolId))throw Error('Unknown pool '+s.id)}
const out=root+'public/review-files/';mkdirSync(out,{recursive:true});
const baseline=JSON.parse(readFileSync(root+'lib/review-baseline.json'));
writeFileSync(out+'bemine-review-index.json',JSON.stringify({baseline,scenarios:reviewScenarios,gaps:reviewGaps},null,2)+'\n');
let md=`# 贝矿 BEMine 全页面审查清单\n\n基准：${baseline.release}。整理日期：${baseline.date}。共 ${reviewScenarios.length} 项。\n\n每项可记录“保留 / 修改 / 待讨论”，并引用编号沟通修改。画面来自现有演示组件的预置状态，不代表真实交易。\n`;
for(const group of [...new Set(reviewScenarios.map(s=>s.group))]){
 md+=`\n## ${group}\n\n`;
 for(const s of reviewScenarios.filter(x=>x.group===group))md+=`- [ ] **${s.id} · ${s.title}**\n  - 入口：${s.entry}\n${s.note?`  - 说明：${s.note}\n`:''}  - 修改意见：\n`;
}
md+='\n## 尚未实现或需要核对的流程\n\n'+reviewGaps.map(g=>`- **${g.title}**：${g.detail}`).join('\n')+'\n';
writeFileSync(out+'bemine-review-checklist.md',md);
console.log(JSON.stringify({count:reviewScenarios.length,groups:[...new Set(reviewScenarios.map(x=>x.group))].map(group=>({group,count:reviewScenarios.filter(x=>x.group===group).length}))},null,2));
