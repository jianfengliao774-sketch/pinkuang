import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const frame = read('app/review/frame/page.jsx');
const page = read('components/PlatformReview.jsx');
const scenarios = read('lib/review-scenarios.js');
const checklist = read('public/review-files/bemine-review-checklist.md');

assert.match(frame, /import PlatformReview from ['"]\.\.\/\.\.\/\.\.\/components\/PlatformReview['"]/);
assert.match(frame, /<PlatformReview\s+scenario=/);

// The review route is public and renders a separate snapshot. Keep its business
// terms aligned with the deployed pool even when the review layout is archived.
for (const policy of [
  '99% 分配给出资人，1% 用于平台运营费用',
  '无领取间隔，权益永久保留，不销毁',
  '低于实际购机成本需至少 60 份赞成',
  '整机成交扣除 1% 平台费',
]) assert(page.includes(policy), `Review is missing current policy: ${policy}`);

const retired = [
  /(?:^|\D)95%\s*(?:分配|给)/,
  /(?:^|\D)4%\s*(?:销毁|用于销毁)/,
  /(?:^|\D)2%\s*(?:平台费|销毁预算)/,
  /BEM\s*销毁|销毁统计|收益批次到期不可领取/,
  /两次领取间隔\s*24\s*小时|每\s*24\s*小时(?:仅|才)可领取/,
];
for (const [name, source] of [['review page', page], ['scenarios', scenarios], ['exported checklist', checklist]]) {
  for (const pattern of retired) assert(!pattern.test(source), `${name} includes retired policy: ${pattern}`);
}

console.log('Review policy checks passed: reachable page and exported review copy use current terms.');
