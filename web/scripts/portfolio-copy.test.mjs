import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PORTFOLIO_ENGLISH,portfolioText} from '../lib/portfolio-copy.mjs';
test('every portfolio caption has English text and dynamic Chinese errors cannot leak into the English page',async()=>{
  const source=await readFile(new URL('../components/LivePortfolios.jsx',import.meta.url),'utf8');
  const labels=[...source.matchAll(/T\((["'])(.*?)\1\)/g)].map(match=>match[2]);
  for(const label of labels)if(/\p{Script=Han}/u.test(label)){assert(label in PORTFOLIO_ENGLISH,label);assert(!/\p{Script=Han}/u.test(portfolioText('en',label)));}
  assert(!/\p{Script=Han}/u.test(portfolioText('en','这是未知服务端错误')));
  assert.equal(portfolioText('zh','预算'),'预算');
});
