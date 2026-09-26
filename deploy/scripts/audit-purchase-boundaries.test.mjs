import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { proxyFirsto, createQuoteRateLimiter } from '../server/firsto-proxy.mjs';

// Regression coverage for the ee8c809 pagination finding and shutdown boundary.
// All responses are local mocks; no production key/RPC is used.
const { fetchMineQuote, OFFICIAL_COLLECTIONS } = await tsImport('../src/pricing.ts', import.meta.url);

async function paginatedQuoteFixture(changedSnapshot = false) {
  const now = Date.now(), visited = [], upstream = [];
  const viewId = `v91508-p163561:${'a'.repeat(64)}`;
  const collection = OFFICIAL_COLLECTIONS.TapeOut, owner = '0x1111111111111111111111111111111111111111';
  const market = '0x6feebbebc07bcb90bd1ac8b0cf9baa4f0ff2b46f';
  const target = { collection, tokenId: '1', owner, category: 'official_mining', classification: 'official_mining',
    mining: { status: 'verified', taskId: '42', verifiedWeight: '100', unverifiedWeight: '0', estimated24hAtomic: '100', tokenSymbol: 'BEM', tokenDecimals: 8 },
    bestAsk: { id: `official:${market}:42`, account: owner, venue: 'official', status: 'open', priceWei: '1000', buyerCostWei: '1010' } };
  const limiter = createQuoteRateLimiter();
  const fetcher = async (input, init) => {
    const url = String(input); visited.push(url);
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(body) { this.body = body; } };
    await proxyFirsto({ url, method: init.method, socket: { remoteAddress: '127.0.0.99' } }, res, {
      limiter,
      fetcher: async target => {
        upstream.push(String(target));
        return responseFor(target);
      },
    });
    return new Response(res.body, { status: res.statusCode, headers: res.headers });
  };
  function responseFor(url) {
    if (url.pathname.startsWith('/v1/circuit/')) return Response.json({ asset: target, orders: { signedAsks: [],
      asksAndOnchainBids: [{ venue: 'official', exchange: market, orderKey: '42', side: 'ask', status: 'open', maker: owner, priceWei: '1000', buyerCostWei: '1010' }] } });
    const page = Number(url.searchParams.get('page'));
    assert.equal(url.searchParams.get('viewId'), page === 1 ? null : viewId);
    const rows = page === 1 ? Array.from({ length: 50 }, (_, i) => ({ ...target, tokenId: String(100 + i), bestAsk: null })) : [target];
    return Response.json({ rows, page, totalPages: 2, total: 51, sourceBlock: '100', viewId: changedSnapshot && page === 2 ? 'different-view' : viewId,
      sourceFreshness: { 'circuit_collections:test': now, 'official_circuit_mining:test': now,
        'blockfeed:bsc-tapeout-markets-shadow-v1:circuit-orders': now } });
  }
  const result = fetchMineQuote(collection, '1', { baseUrl: '/firsto-api', fetcher });
  if (changedSnapshot) await assert.rejects(result, /来源快照已变化/);
  else { const quote = await result; assert.equal(quote.detailChecked, true); assert.equal(quote.tokenId, '1'); assert.equal(quote.source.viewId, viewId); }
  assert.equal(visited.length, changedSnapshot ? 2 : 3);
  assert.equal(new URL(visited[1], 'http://localhost').searchParams.get('viewId'), viewId);
  assert.equal(upstream.length, changedSnapshot ? 2 : 3);
}

test('exact NFT lookup reaches page two through the real proxy and verifies its detail', async () => {
  await paginatedQuoteFixture();
});

test('page-two snapshot changes fail before detail lookup even when the target matches', async () => {
  await paginatedQuoteFixture(true);
});

test('SIGTERM during simulation prevents a fresh signature and broadcast afterward', { timeout: 15_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pinkuang-audit-stop-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const keeperUrl = new URL('./purchase-keeper.mjs', import.meta.url).href;
  const source = `
    import os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    import { Interface, JsonRpcProvider, Wallet, ZeroAddress, Transaction } from 'ethers';
    const directory = ${JSON.stringify(directory)};
    // Redirect only this disposable child's homedir() API; do not change HOME or touch real wallet journals.
    os.homedir = () => directory; syncBuiltinESMExports();
    globalThis.fetch = () => { throw new Error('No network is permitted in this audit fixture'); };
    const m = await import(${JSON.stringify(keeperUrl)});
    const factory = '0x1111111111111111111111111111111111111111';
    const pool = '0x2222222222222222222222222222222222222222';
    const seller = '0x3333333333333333333333333333333333333333';
    const poolAbi = new Interface(m.KEEPER_POOL_ABI), listingAbi = new Interface(m.LISTING_ABI);
    const registryAbi = new Interface(['function isPool(address) view returns(bool)']);
    const wallet = Wallet.createRandom();
    process.env.KEEPER_PRIVATE_KEY = wallet.privateKey; // Ephemeral local test key only; never printed.
    let stopRequested = false, signsAfterStop = 0, broadcastsAfterStop = 0;
    const originalSign = Wallet.prototype.signTransaction;
    Wallet.prototype.signTransaction = function(tx) { if (stopRequested) signsAfterStop++; return originalSign.call(this, tx); };
    const p = JsonRpcProvider.prototype;
    p.send = async () => { throw new Error('Unexpected real RPC path blocked'); };
    p.getNetwork = async () => ({ chainId: 56n });
    p.getBlock = async () => ({ number: 100, timestamp: 1000, gasLimit: 30000000n });
    p.getCode = async () => '0x6000';
    p.getFeeData = async () => ({ gasPrice: 1n });
    p.getBalance = async () => 1000000n;
    p.getTransactionCount = async () => 0;
    p.call = async tx => {
      const iface = tx.to.toLowerCase() === pool ? poolAbi : tx.to.toLowerCase() === factory ? registryAbi : listingAbi;
      const decoded = iface.parseTransaction(tx); let values;
      switch (decoded.name) {
        case 'isPool': values = [true]; break;
        case 'factory': case 'OFFICIAL_FACTORY': values = [factory]; break;
        case 'state': values = [1n]; break;
        case 'params': values = [[m.OFFICIAL_COLLECTIONS[0], 1n, 1100n, 1000n, ZeroAddress, 0n, 1500n, 2000n]]; break;
        case 'flexiblePurchase': values = [true, 1n, [100n, 1000n, 100n, 1000n, 900n, 40n, '0x'+'ab'.repeat(32)]]; break;
        case 'purchaseModel': values = [true, 42n]; break;
        case 'purchaseReferenceWeight': values = [100n]; break;
        case 'listingFor': values = [1n, seller, 1000n, true]; break;
        case 'listingView': values = [seller, m.OFFICIAL_COLLECTIONS[0], 1n, 1000n, 100n, true]; break;
        default: throw new Error('Unexpected view '+decoded.name);
      }
      return iface.encodeFunctionResult(decoded.name, values);
    };
    p.estimateGas = async () => { stopRequested = true; process.emit('SIGTERM'); return 100n; };
    p.broadcastTransaction = async raw => { if (stopRequested) broadcastsAfterStop++; return { hash: Transaction.from(raw).hash }; };
    await m.main(['--factory', factory, '--pool', pool, '--send', '--journal', directory+'/pool.json', '--rpc', 'http://127.0.0.1:1']);
    console.log('AUDIT_RESULT '+JSON.stringify({ stopRequested, signsAfterStop, broadcastsAfterStop }));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { PATH: process.env.PATH, TMPDIR: tmpdir() }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  assert.equal(exitCode, 0, stderr);
  const line = stdout.split('\n').find(value => value.startsWith('AUDIT_RESULT '));
  assert(line, 'missing result');
  assert.deepEqual(JSON.parse(line.slice('AUDIT_RESULT '.length)), { stopRequested: true, signsAfterStop: 0, broadcastsAfterStop: 0 });
});
