/** Local-only UI regression: persistent invites and status-based share transfer actions. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installLiveFixture, FIXTURE_POOLS } from './live-browser-fixture.mjs';

const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3108';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const phase = process.env.BEMINE_DETAIL_PHASE || 'demo';
assert(['demo', 'live'].includes(phase));
const output = process.env.BEMINE_BROWSER_OUTPUT || join(tmpdir(), 'bemine-detail-actions');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.BEMINE_TEST_BROWSER ? { channel: process.env.BEMINE_TEST_BROWSER } : {}) });
const checks = [], errors = [];
const attach = page => { page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message)); };
const invite = '邀请朋友一起拼矿';
const reserve = '为确保购机成功，用户会按矿机出售价格额外预付 10%；购机成功后余款按照份额等比退还';
async function checkCopyLayout(page, mode) {
  const lines = page.locator('.purchase-panel .purchase-explanation');
  assert.equal(await lines.count(), 2);
  assert.equal(await lines.last().innerText(), reserve);
  const styles = await lines.evaluateAll(nodes => nodes.map(node => {
    const s = getComputedStyle(node);
    return { align: s.textAlign, fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight, left: node.getBoundingClientRect().left };
  }));
  assert.deepEqual(styles[0], styles[1]);
  assert.equal(styles[0].align, 'left');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  checks.push(`${mode}: reserve and ownership lines have matching left-aligned typography`);
}
try {
  if (phase === 'demo') {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }); attach(page);
    await page.goto(`${base}/preview#detail/16928`);
    const panel = page.locator('.purchase-panel');
    await panel.getByRole('button', { name: '确认认购', exact: true }).waitFor();
    assert.equal(await page.locator('.miner-invite').count(), 0);
    await page.getByLabel('认购份数', { exact: true }).fill('1');
    await panel.getByRole('button', { name: '确认认购', exact: true }).click();
    await page.getByRole('button', { name: '确认演示认购', exact: true }).click();
    await page.getByRole('link', { name: 'Telegram', exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭分享', exact: true }).click();
    await page.locator('.miner-invite').getByRole('button', { name: invite, exact: true }).waitFor();
    assert.equal(await panel.locator('.funding-invite .order-total strong').innerText(), '1 份');
    assert.equal(await page.locator('.miner-information > div').filter({ hasText: '当前认购人数' }).locator('dd').innerText(), '13人');
    await page.evaluate(() => { location.hash = 'overview'; });
    await page.getByRole('heading', { name: '资产总览', exact: true }).waitFor();
    await page.getByRole('button', { name: /TapeOut #16928/ }).first().click();
    await panel.getByRole('button', { name: invite, exact: true }).click();
    await page.getByRole('link', { name: 'Telegram', exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭分享', exact: true }).click();
    checks.push('demo: one-share subscriber can reopen sharing after leaving and returning via assets');
    await checkCopyLayout(page, 'desktop');
    for (const [id, expected, enabled] of [['16928', 0], ['15832', 0], ['16210', 1, true], ['8204', 1, false]]) {
      await page.evaluate(id => { location.hash = `detail/${id}`; }, id);
      await page.locator('.detail-heading h1').filter({ hasText: `#${id}` }).waitFor();
      await page.locator('.detail-tabs').getByRole('button', { name: '参与者', exact: true }).click();
      const transfer = page.getByRole('button', { name: '转让份额', exact: true });
      assert.equal(await transfer.count(), expected, id);
      if (expected) assert.equal(await transfer.isEnabled(), enabled, id);
      checks.push(`demo ${id}: transfer visible=${!!expected}, enabled=${enabled ?? false}`);
    }
    await page.evaluate(() => { location.hash = 'detail/17006'; });
    await page.locator('.detail-heading h1').filter({ hasText: '#17006' }).waitFor();
    await page.getByLabel('认购份数', { exact: true }).fill('9');
    await panel.getByRole('button', { name: '确认认购', exact: true }).click();
    await page.getByRole('button', { name: '确认演示认购', exact: true }).click();
    await page.getByRole('button', { name: '关闭分享', exact: true }).click();
    assert.equal(await page.locator('.detail-heading .badge').innerText(), '待购机');
    assert.equal(await page.getByRole('button', { name: '转让份额', exact: true }).count(), 0);
    checks.push('demo fully funded awaiting purchase: no share-transfer action');
    await page.locator('.detail-tabs').getByRole('button', { name: '资产详情', exact: true }).click();
    await page.setViewportSize({ width: 375, height: 812 });
    await checkCopyLayout(page, 'mobile 375');
    await page.screenshot({ path: join(output, 'mobile-detail-copy.png'), animations: 'disabled' });
    await page.getByLabel('Language', { exact: true }).selectOption('en');
    assert.match(await panel.locator('.purchase-explanation').last().innerText(), /^To help complete the miner purchase/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    checks.push('English reserve copy fits 375px mobile');
  } else {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }); attach(page);
    const fixture = await installLiveFixture(page, { fundingShares: 1n });
    await page.goto(base); await page.getByText('数据区块 100', { exact: true }).waitFor();
    await page.getByRole('button', { name: '连接钱包', exact: true }).click();
    const open = async kind => {
      const route = `detail/${FIXTURE_POOLS[kind]}`;
      await page.evaluate(hash => { location.hash = hash; }, route);
      await page.waitForFunction(expected => document.querySelector('main')?.dataset.readyRoute === expected && document.querySelector('main')?.getAttribute('aria-busy') === 'false', route);
    };
    await open('funding');
    assert.equal(await page.locator('.live-details').getByRole('button', { name: invite, exact: true }).count(), 1);
    await page.locator('.live-details').getByRole('button', { name: invite, exact: true }).click();
    await page.getByRole('link', { name: 'Telegram', exact: true }).waitFor();
    assert.equal((await page.getByLabel('Telegram 分享文案', { exact: true }).inputValue()).includes('已确认'), false);
    await page.getByRole('button', { name: '收起分享', exact: true }).click();
    await checkCopyLayout(page, 'live desktop');
    for (const [kind, expected, enabled] of [['funding', 0], ['listed', 0], ['active', 1, true], ['voting', 1, false]]) {
      await open(kind);
      const transfer = page.locator('.purchase-panel').getByRole('button', { name: '出售我的份额', exact: true });
      assert.equal(await transfer.count(), expected, kind);
      if (expected) assert.equal(await transfer.isEnabled(), enabled, kind);
      checks.push(`live ${kind}: transfer visible=${!!expected}, enabled=${enabled ?? false}`);
    }
    await open('funding');
    assert.equal(await page.locator('.live-details').getByRole('button', { name: invite, exact: true }).count(), 1);
    await page.reload(); await page.getByRole('button', { name: '连接钱包', exact: true }).click();
    await page.locator('.live-details').getByRole('button', { name: invite, exact: true }).waitFor();
    checks.push('live: one-share eligibility returns from chain positions after reload, no receipt fabrication');
    assert.deepEqual(fixture.controls.sentTransactions, []);
    await page.close();
    const zero = await browser.newPage({ viewport: { width: 375, height: 812 } }); attach(zero);
    await installLiveFixture(zero, { fundingShares: 0n });
    await zero.goto(`${base}/#detail/${FIXTURE_POOLS.funding}`); await zero.getByText('数据区块 100', { exact: true }).waitFor();
    await zero.getByRole('button', { name: '连接钱包', exact: true }).click();
    await zero.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false');
    assert.equal(await zero.locator('.live-details').getByRole('button', { name: invite, exact: true }).count(), 0);
    assert.equal(await zero.locator('.purchase-panel').getByRole('button', { name: invite, exact: true }).count(), 1);
    await checkCopyLayout(zero, 'live mobile');
    checks.push('live: zero holding has no subscriber invite, neutral public share remains available');
  }
  assert.deepEqual(errors, []);
  await writeFile(join(output, `${phase}-results.json`), JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ phase, passed: checks.length, checks, output }));
} finally { await browser.close(); }
