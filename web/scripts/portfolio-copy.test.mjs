import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PORTFOLIO_ENGLISH,portfolioText} from '../lib/portfolio-copy.mjs';
test('every portfolio caption has English text and unknown errors retain their original meaning',async()=>{
  const source=await readFile(new URL('../components/LivePortfolios.jsx',import.meta.url),'utf8');
  const labels=[...source.matchAll(/T\((["'])(.*?)\1\)/g)].map(match=>match[2]);
  for(const label of labels)if(/\p{Script=Han}/u.test(label)){assert(label in PORTFOLIO_ENGLISH,label);assert(!/\p{Script=Han}/u.test(portfolioText('en',label)));}
  for(const label of ['平台已驳回该提案，禁止折价挂牌。','该子矿机尚未满足创世版出售条件。',
    '订单分页来源已变化，请重新读取。','平台已驳回这项子矿机出售提案。',
    '低于 Firsto 市场参考价，尚待平台审核通过。'])
    assert(label in PORTFOLIO_ENGLISH,label);
  assert.match(portfolioText('en','这是未知服务端错误'),/这是未知服务端错误.*Translation unavailable/);
  assert.equal(portfolioText('zh','预算'),'预算');
});
