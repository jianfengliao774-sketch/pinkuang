import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {ledger,rewards} from '../lib/demo-data.js';
import {platformTotals} from '../lib/platform-stats.js';
import {pools} from '../lib/demo-data.js';
const root=new URL('../',import.meta.url);
assert.equal(ledger.length,4);
assert(ledger.every(row=>!/(销毁|burn)/i.test(row.join(' '))));
assert(rewards.every(row=>!('expiry' in row)&&!('soon' in row)));
assert(Math.abs(rewards.reduce((sum,r)=>sum+r.amount,0)-.6842)<1e-10);
assert(!('burned' in platformTotals(pools)));
const retired=/销毁|\bburn(?:s|ed|ing)?\b|到期|\bexpir(?:y|ed|es|ing)\b|领取间隔|24 hours between successful claims/i;
function scan(dir){for(const item of readdirSync(new URL(dir,root),{withFileTypes:true})){const path=dir+'/'+item.name;if(item.isDirectory())scan(path);else if(/\.(jsx?|json|md)$/.test(item.name))assert(!retired.test(readFileSync(new URL(path,root),'utf8')),`Retired copy in ${path}`)}}
for(const dir of ['components','lib','app','public/review-files'])scan(dir);
const index=JSON.parse(readFileSync(new URL('public/review-files/bemine-review-index.json',root)));
assert.equal(index.scenarios.length,90);assert.equal(new Set(index.scenarios.map(x=>x.id)).size,90);assert(!index.scenarios.some(x=>x.id==='A12'));assert(index.scenarios.some(x=>x.id==='B01'));assert(index.scenarios.some(x=>x.id==='F04'));
const hash=(await import('node:crypto')).createHash('sha256').update(readFileSync(new URL('components/Platform.jsx',root))).digest('hex');assert.equal(index.baseline.platformSha256,hash,'Regenerate current review snapshots and index');
console.log('Reward policy checks passed: no retired public copy/data, totals preserved, stable review IDs and current snapshot.');
