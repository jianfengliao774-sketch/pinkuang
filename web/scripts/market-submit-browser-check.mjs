/** Real UI/action pipeline, strictly in-memory market journal and fake wallet transport. */
import assert from 'node:assert/strict';
import { parseEther, toQuantity } from 'ethers';
import { installLiveFixture, FIXTURE_POOLS, FIXTURE_CONTRACTS } from './live-browser-fixture.mjs';
import { abi } from '../lib/chain-client.mjs';
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const base = (process.env.BEMINE_TEST_URL || 'http://127.0.0.1:3108').replace(/\/+$/, '');
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const browser = await chromium.launch({ headless: true, ...(process.env.BEMINE_TEST_BROWSER ? { channel: process.env.BEMINE_TEST_BROWSER } : {}) });
const checks = [], errors = [], same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
try {
  for (const kind of ['list', 'fill']) {
    const page = await browser.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    const fixture = await installLiveFixture(page, { confirmDeposit: true });
    const market = FIXTURE_CONTRACTS.shareMarket, quantity = 3n;
    const expectedData = abi.ShareMarket.encodeFunctionData(kind, kind === 'list' ? [FIXTURE_POOLS.active, quantity, parseEther('0.075500000000000001')] : [1n, quantity]);
    const expectedValue = kind === 'list' ? 0n : parseEther('0.24543');
    const hash = `0x${'7b'.repeat(32)}`, trace = [], sends = [];
    let revision = 0, record = null, armed = false;
    const checked = transaction => {
      assert(same(transaction.from, fixture.account)); assert(same(transaction.to, market));
      assert.equal(transaction.data.toLowerCase(), expectedData.toLowerCase()); assert.equal(BigInt(transaction.value ?? 0), expectedValue);
    };
    await page.exposeFunction('__testMarketTransport', async payload => {
      const transaction = payload.params?.[0]; checked(transaction);
      if (payload.method === 'eth_call') return abi.ShareMarket.encodeFunctionResult(kind, kind === 'list' ? [3n] : []);
      if (payload.method === 'eth_estimateGas') return toQuantity(150000);
      assert.equal(payload.method, 'eth_sendTransaction'); assert(record && armed, 'both journal ACKs must precede the fake send');
      assert.equal(transaction.nonce, toQuantity(record.nonce)); assert.equal(record.action.kind, kind);
      sends.push(transaction); trace.push('send'); return hash;
    });
    await page.route(/\/api\/journal\//, async route => {
      const request = route.request(), path = new URL(request.url()).pathname.replace(/^.*\/api\/journal\//, ''), method = request.method();
      const input = request.postData() ? request.postDataJSON() : null; let status = 200, body;
      if (path === 'session' && method === 'GET') body = { account: fixture.account };
      else if (path === 'notifications/capabilities' && method === 'GET') body = {enabled:false};
      else if (path === 'market/result' && method === 'GET') body = { result: null };
      else if (path === 'market' && method === 'GET') body = { revision, record, canAbandon: false };
      else if (path === 'market/prepare-and-arm' && method === 'POST') {
        assert.equal(input.expectedRevision, revision); assert.equal(record, null);
        checked({ from: input.record.account, to: input.record.target, data: input.record.data, value: input.record.value });
        assert.equal(input.record.action.kind, kind); record = input.record; revision += 2; armed = true; trace.push('atomic-ack');
        body = { revision, record, transaction: { from: record.account, to: record.target, data: record.data,
          value: toQuantity(record.value), nonce: toQuantity(record.nonce), gas: toQuantity(record.gas),
          gasPrice: toQuantity(record.gasPrice), chainId: '0x38', type: '0x0' } };
      } else if (path === 'market' && method === 'PUT') {
        assert.equal(input.expectedRevision, revision); checked({ from: input.record.account, to: input.record.target, data: input.record.data, value: input.record.value });
        assert.equal(input.record.action.kind, kind); record = input.record; revision++; trace.push(record.hash ? 'hash-ack' : 'intent-ack'); body = { revision, record };
      } else if (path === 'market/arm' && method === 'POST') {
        assert.equal(input.expectedRevision, revision); assert(record && !armed); armed = true; revision++; trace.push('permit-ack');
        body = { revision, record, transaction: { from: record.account, to: record.target, data: record.data,
          value: toQuantity(record.value), nonce: toQuantity(record.nonce), gas: toQuantity(record.gas), gasPrice: toQuantity(record.gasPrice), chainId: '0x38', type: '0x0' } };
      } else if (path === 'market' && method === 'DELETE') { status = 409; body = { error: 'Fixture awaits finality' }; }
      else throw new Error(`Unexpected market fixture ${method} ${path}`);
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(`${base}/#${kind === 'list' ? 'overview' : 'market'}`);
    await page.evaluate(({ market, selector }) => {
      const request = window.ethereum.request.bind(window.ethereum);
      window.ethereum.request = payload => {
        const tx = payload.params?.[0];
        if (['eth_call', 'eth_estimateGas', 'eth_sendTransaction'].includes(payload.method)
          && tx?.to?.toLowerCase() === market.toLowerCase() && tx?.data?.startsWith(selector)) return window.__testMarketTransport(payload);
        return request(payload);
      };
    }, { market, selector: abi.ShareMarket.getFunction(kind).selector });
    await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
    await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click();
    await page.locator('header .live-wallet-label').filter({hasText:/0x[0-9a-f]/i}).waitFor();
    await page.getByText('数据区块 100', { exact: true }).waitFor();
    assert.equal(await page.locator('nav').getByRole('button', {name:'运营工作台',exact:true}).count(),0);
    await page.getByRole('button', { name: kind === 'list' ? '挂单 Behemoth #8204' : '买入份额', exact: true }).click();
    if (kind === 'list') {
      assert.equal(await page.getByLabel('份额数量', {exact:true}).inputValue(),'30');
      assert.match(await page.locator('[role=dialog]').innerText(),/已自动选择你的持仓项目/);
      assert.equal(await page.locator('[role=dialog] input[placeholder="0x…"]').count(),0);
    }
    await page.getByLabel('份额数量', { exact: true }).fill('3');
    if (kind === 'list') await page.getByLabel('每份价格 · BNB', { exact: true }).fill('0.075500000000000001');
    await page.getByRole('button', { name: '核对交易金额', exact: true }).click();
    await page.getByRole('button', { name: '确认并前往钱包', exact: true }).waitFor();
    const confirmation = await page.locator('.confirm-lines').filter({hasText:kind === 'fill' ? '支付金额' : '全部成交基价'}).innerText();
    assert.match(confirmation, kind === 'fill' ? /0\.24543 BNB/ : /0\.22650 BNB/);
    if (kind === 'list') assert.match(confirmation, /本次钱包支付（另付 Gas）\s*0\.00000 BNB/);
    assert.equal(sends.length, 0, 'preview cannot send');
    await page.getByRole('button', { name: '确认并前往钱包', exact: true }).click();
    await page.getByText('有一笔交易等待核对', { exact: true }).waitFor();
    assert.equal(sends.length, 1); assert(trace.indexOf('atomic-ack') < trace.indexOf('send'));
    assert(!trace.includes('intent-ack') && !trace.includes('permit-ack'));
    assert.equal(await page.getByText('认购已确认', { exact: true }).count(), 0);
    checks.push({ kind, directFromHoldings:kind==='list', exactRawPricePreserved:true, calldata: expectedData, valueWei: expectedValue.toString(), trace }); await page.close();
  }
  assert.deepEqual(errors, []); console.log(JSON.stringify({ passed: checks.length, checks }));
} finally { await browser.close(); }
