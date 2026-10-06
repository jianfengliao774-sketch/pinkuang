/** Offline visual fixture. Never import from shipped app/components/lib code. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Interface, ZeroAddress, getAddress, id, toQuantity } from 'ethers';
import { freshAuthorityBrowserFixture } from './fresh-authority-browser-fixture.mjs';
import { PORTFOLIOS } from './portfolio-fixture.mjs';
import { abi } from '../lib/chain-client.mjs';
import { readPortfolio, readPortfolioDisplayContext } from '../lib/live-portfolios.mjs';
import { MARKET, MINING } from './operator-quotes-fixture.mjs';

export const PREVIEW_BASE_PATH = '/bemine-v5';
export const PREVIEW_RPC_METHODS = Object.freeze(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber',
  'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getTransactionCount', 'eth_gasPrice', 'eth_call']);
export const previewJson = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint'
  ? { $bemineBigInt: item.toString() } : item);
const plainJson = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const nft = new Interface(['function ownerOf(uint256) view returns(address)']);
const marketSource = readFileSync(new URL('../../contracts/src/interfaces/ICircuitMarket.sol', import.meta.url), 'utf8');
const listing = new Interface([/function listingFor\([\s\S]*?returns\s*\([^;]+\)/.exec(marketSource)[0].replace(/\bexternal\b/, '')]);
const miningSource = readFileSync(new URL('../../contracts/src/interfaces/ITapeoutMining.sol', import.meta.url), 'utf8');
const minerFields = [.../struct Miner\s*\{([^}]+)\}/.exec(miningSource)[1].matchAll(/(address|uint\d+|bool)\s+(\w+)\s*;/g)]
  .map(([, type, name]) => ({ type, name }));
const mining = new Interface(['function minerKey(address,uint256) view returns(bytes32)',
  `function getMiner(bytes32) view returns(tuple(${minerFields.map(({ type, name }) => `${type} ${name}`).join(',')}))`]);

export function createMobileLayoutPreviewFixture({ orderEpochMs } = {}) {
  if (orderEpochMs != null && (!Number.isSafeInteger(orderEpochMs) || orderEpochMs < 0)) throw Error('Invalid synthetic order clock.');
  const fixture = freshAuthorityBrowserFixture();
  fixture.state.account = fixture.ordinary;
  fixture.f.state.poolState = undefined;
  fixture.f.state.saleReviewThresholdBps = 10_000n;
  fixture.f.state.childReviewThresholdBps = 10_000n;
  const account = fixture.ordinary, manifest = fixture.manifest, rows = fixture.f.base.rows;
  const trace = { rpcReads: [], journalReads: [], indexReads: [], firstoReads: [], refused: [] };
  const orderTimestamp = BigInt(fixture.f.source().indexedTimestamp);
  const orderEpoch = orderEpochMs == null ? orderTimestamp : BigInt(Math.floor(orderEpochMs / 1000));
  const orders = [...fixture.f.base.orders.map(row => ({ ...row,
    expiresAt: String(orderEpoch + (row.orderId === '1' ? 5n : 3n) * 86400n) })), {
    orderId: '3', seller: account, pool: rows[1].pool, remaining: '4', pricePerUnitWei: '87000000000000000',
    expiresAt: String(orderEpoch + 2n * 86400n), listedBlock: 99, openAtSourceBlock: true,
  }, {
    orderId: '4', seller: account, pool: rows[1].pool, remaining: '2', pricePerUnitWei: '79000000000000000',
    expiresAt: String(orderEpoch - 60n), listedBlock: 96, openAtSourceBlock: false,
  }].map(row => ({ ...row, orderId: BigInt(row.orderId), remaining: BigInt(row.remaining),
    pricePerUnitWei: BigInt(row.pricePerUnitWei), expiresAt: BigInt(row.expiresAt), active: row.active ?? true,
    executable: false, shareTradingAllowed: true })).sort((a, b) => a.orderId > b.orderId ? -1 : 1);
  const assetKey = (collection, token) => `${collection.toLowerCase()}:${String(token)}`;
  const assets = new Map(rows.map((row, i) => {
    const asset = structuredClone(fixture.data.row);
    Object.assign(asset, { collection: row.params.circuits, tokenId: String(row.params.circuitId),
      processorName: i % 2 ? 'Behemoth' : 'TapeOut', owner: row.pool });
    asset.mining = { ...asset.mining, taskId: String(220 + i), verifiedWeight: String(61 + i),
      unverifiedWeight: '0', weight: String(61 + i), estimated24hAtomic: String((i + 1) * 432_000) };
    asset.bestAsk = { ...asset.bestAsk, id: id(`mobile-preview-${i}`), account: asset.owner,
      priceWei: row.params.priceCap.toString(), buyerCostWei: (row.params.priceCap * 101n / 100n).toString(),
      execution: { ...asset.bestAsk.execution, maker: asset.owner, collection: asset.collection,
        tokenId: asset.tokenId, priceWei: row.params.priceCap.toString() } };
    const quote = { asset, orders: { asksAndOnchainBids: [], signedAsks: [{ askHash: asset.bestAsk.id,
      maker: asset.owner, collection: asset.collection, tokenId: asset.tokenId, status: 'open', side: 'ask',
      priceWei: asset.bestAsk.priceWei, buyerCostWei: asset.bestAsk.buyerCostWei,
      chainId: 56, expiry: String(Math.floor(Date.now() / 1000) + 86400) }] } };
    return [assetKey(asset.collection, asset.tokenId), { row, asset, quote, key: id(assetKey(asset.collection, asset.tokenId)) }];
  }));
  const source = (cached = false) => ({ ...fixture.f.source(), checkedAt: new Date().toISOString(),
    ...(cached ? { cacheOrigin: 'server', displayOnly: true, transactionReady: false,
      readMode: 'verified_snapshot', stale: true, refreshing: false, snapshotAgeMs: 0 } : {}) });
  const rpc = async input => {
    if (!input || !PREVIEW_RPC_METHODS.includes(input.method) || /send|sign|wallet_/i.test(input.method)) {
      trace.refused.push(`rpc:${input?.method}`); throw Error('效果预览禁止签名、交易及钱包管理。');
    }
    trace.rpcReads.push(input.method);
    if (input.method === 'eth_getBalance') return toQuantity(10n ** 19n);
    if (input.method === 'eth_getTransactionCount') return '0x7';
    if (input.method === 'eth_gasPrice') return toQuantity(100_000_000n);
    if (input.method !== 'eth_call') return fixture.f.request(input);
    const [tx, block = '0x64'] = input.params ?? [];
    if (!tx || tx.from || BigInt(tx.value ?? '0x0') !== 0n) throw Error('效果预览只允许合约查询。');
    const target = getAddress(tx.to);
    const contract = same(target, MINING) ? mining : same(target, MARKET) ? listing
      : rows.some(row => same(target, row.params.circuits)) ? nft
      : same(target, manifest.lens) ? abi.PoolLens
      : same(target, manifest.factory) ? abi.PoolFactory
      : same(target, manifest.authority) ? abi.PlatformAuthority
      : same(target, manifest.portfolioFactory) ? abi.BudgetPortfolioFactory
      : [manifest.shareMarket, manifest.portfolioMarket].some(a => same(a, target)) ? abi.ShareMarket
      : PORTFOLIOS.some(pool => same(pool, target)) ? abi.BudgetPortfolioVault
      : rows.some(row => same(row.pool, target)) ? abi.PoolVault : null;
    const parsed = contract?.parseTransaction(tx);
    if (!parsed || !['view', 'pure'].includes(parsed.fragment.stateMutability)) throw Error('效果预览不执行交易 calldata。');
    if (same(target, manifest.authority)) {
      const values = { administratorOne: manifest.freshAuthority.administratorOne,
        administratorTwo: manifest.freshAuthority.administratorTwo, gasWallet: manifest.gasWallet,
        coreFactory: manifest.factory, budgetFactory: manifest.portfolioFactory, nonces: 0n };
      if (!(parsed.name in values)) throw Error('不支持的预览管理员查询。');
      return contract.encodeFunctionResult(parsed.fragment, [values[parsed.name]]);
    }
    if (contract === nft) {
      const asset = assets.get(assetKey(target, parsed.args[0]));
      if (!asset) throw Error('未知预览矿机。');
      return nft.encodeFunctionResult(parsed.fragment, [asset.row.pool]);
    }
    if (contract === listing) {
      const asset = assets.get(assetKey(parsed.args[0], parsed.args[1]));
      if (!asset) throw Error('未知预览挂牌。');
      return listing.encodeFunctionResult(parsed.fragment, [45n, asset.row.pool, asset.row.params.priceCap, true]);
    }
    if (contract === mining) {
      if (parsed.name === 'minerKey') return mining.encodeFunctionResult(parsed.fragment,
        [assets.get(assetKey(parsed.args[0], parsed.args[1]))?.key ?? id('unknown-preview')]);
      const asset = [...assets.values()].find(item => item.key === parsed.args[0]);
      if (!asset) throw Error('未知预览算力。');
      const miner = Object.fromEntries(minerFields.map(({ type, name }) => [name,
        type === 'address' ? ZeroAddress : type === 'bool' ? false : 0n]));
      Object.assign(miner, { circuits: asset.asset.collection, circuitId: BigInt(asset.asset.tokenId),
        taskId: BigInt(asset.asset.mining.taskId), status: 1n, verifWeight: BigInt(asset.asset.mining.verifiedWeight) });
      return mining.encodeFunctionResult(parsed.fragment, [miner]);
    }
    if (contract === abi.PoolVault && parsed.name === 'params') {
      const row = rows.find(item => same(item.pool, target));
      if (!row) throw Error('未知预览矿池。');
      return contract.encodeFunctionResult(parsed.fragment, [row.params]);
    }
    const args = [...parsed.args];
    // Make the ordinary synthetic member own the existing fixture positions. No test signer is exposed.
    const memberReads = ['balanceOf', 'claimableBem', 'bnbOwed', 'saleDebt', 'lockedShares', 'getPastShares'];
    if (memberReads.includes(parsed.name) && same(args[0], account)) args[0] = fixture.f.base.account;
    if (['positions', 'governance'].includes(parsed.name) && same(args[1], account)) args[1] = fixture.f.base.account;
    if (parsed.name === 'poolPage' && same(args[2], account)) args[2] = fixture.f.base.account;
    return fixture.f.request({ method: 'eth_call', params: [{ ...tx, data: contract.encodeFunctionData(parsed.fragment, args) },
      ['latest', 'safe', 'finalized'].includes(block) ? '0x64' : block] });
  };
  const portfolioRow = async (pool, owner, children = false) => {
    const config = { ...fixture.config, productFamily: 'fresh-v4', displayOnly: true };
    const context = readPortfolioDisplayContext(config, { request: rpc }, 100n, source(true));
    return readPortfolio(context, pool, owner, { includeChildren: children });
  };
  const pageOf = (items, query) => {
    const cursor = Number(query.get('cursor') ?? 0), limit = Math.min(20, Number(query.get('limit') ?? 20));
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1) throw Error('无效的预览分页。');
    return { items: items.slice(cursor, cursor + limit), nextCursor: cursor + limit < items.length ? cursor + limit : null };
  };
  const poolRow = (row, owner) => ({ ...structuredClone(row), trusted: true,
    shares: same(owner, account) ? row.shares : 0n, availableShares: same(owner, account) ? row.availableShares : 0n,
    lockedShares: same(owner, account) ? row.lockedShares : 0n,
    claimableBEM: same(owner, account) ? row.claimableBEM : 0n, bnbOwed: same(owner, account) ? row.bnbOwed : 0n,
    initialContributedWei: same(owner, account) ? row.initialContributedWei : 0n,
    salePrice: row.state === 3n ? 6n * 10n ** 18n : 0n });
  const index = async input => {
    const url = new URL(input, 'http://127.0.0.1:3218'), path = url.pathname.replace(/^.*\/api\/chain-index/, ''), q = url.searchParams;
    trace.indexReads.push(path);
    if (path === '/health') return { source: source() };
    const owner = q.get('account') ?? ZeroAddress;
    if (path === '/v1/display/portfolios' || /^\/v1\/display\/portfolios\/0x[\da-f]{40}$/i.test(path)) {
      const selected = path.split('/')[4];
      if (selected) return { source: source(true), data: { item: await portfolioRow(selected, owner, q.get('children') !== 'false') } };
      const parents = await Promise.all(PORTFOLIOS.map(pool => portfolioRow(pool, owner)));
      return { source: source(true), data: pageOf(q.get('mine') === 'true' ? parents.filter(row => row.shares > 0n) : parents, q) };
    }
    if (path === '/v1/display/pools' || /^\/v1\/display\/pools\/0x[\da-f]{40}$/i.test(path)) {
      const selected = path.split('/')[4];
      if (selected) {
        const row = rows.find(item => same(item.pool, selected)); if (!row) throw Error('未知预览矿机。');
        return { source: source(true), data: { item: poolRow(row, owner) } };
      }
      return { source: source(true), data: pageOf(rows.map(row => poolRow(row, owner)), q) };
    }
    if (/^\/v1\/display\/positions\/0x[\da-f]{40}$/i.test(path)) return { source: source(true),
      data: { ...pageOf(same(path.split('/')[4], account) ? rows.map(row => poolRow(row, account)) : [], q), marketBnbOwed: 67n * 10n ** 15n } };
    if (path === '/v1/display/orders') {
      const filtered = orders.filter(row => (!q.get('pool') || same(row.pool, q.get('pool')))
        && (!q.get('seller') || same(row.seller, q.get('seller')))
        && (q.get('active') == null || (row.active && row.remaining > 0n && row.expiresAt > orderTimestamp) === (q.get('active') === 'true')));
      return { source: source(true), data: pageOf(filtered, q) };
    }
    if (path === '/v1/display/stats') return { ...fixture.index(url.href.replace('/display/stats', '/stats')), source: source(true) };
    if (path === '/v1/display/sale-reference/' + (q.get('pool') ?? '')) return { source: source(true), data: null };
    if (path.startsWith('/v1/display/sale-reference/') || path.startsWith('/v1/display/firsto-ask/')) return {
      schemaVersion: 1, chainId: 56, factory: manifest.factory, market: manifest.shareMarket,
      enabled: false, stale: false, updatedAt: null, item: { pool: path.split('/').at(-1), status: 'disabled' } };
    const rewritten = new URL(url);
    if (q.get('account') && same(q.get('account'), account)) rewritten.searchParams.set('account', fixture.f.base.account);
    const reply = fixture.index(rewritten.href);
    if (path === '/v1/activity') {
      reply.data.items = reply.data.items.map(row => ({ ...row, fields: { ...row.fields,
        ...(row.fields.user ? { user: account.toLowerCase() } : {}) } }));
      reply.data.totalCount = rows.length; reply.data.overviewTotalCount = rows.length;
    }
    if (path === '/v1/yield' && q.get('account')) reply.data.account = q.get('account');
    return { ...reply, source: source() };
  };
  const firsto = input => {
    const url = new URL(input, 'http://127.0.0.1:3218'), path = url.pathname;
    trace.firstoReads.push(path);
    if (path.endsWith('/circuits')) return { ...fixture.data.page,
      rows: [...assets.values()].map(item => item.asset), total: assets.size,
      sourceFreshness: Object.fromEntries(Object.keys(fixture.data.page.sourceFreshness).map(key => [key, Date.now() - 500])) };
    if (path.endsWith('/circuit-holders')) return { ...fixture.data.referenceRaw,
      asOf: new Date().toISOString(), coverage: { holders: 'complete', market24h: 'complete' } };
    const match = /\/circuits?\/(0x[\da-f]{40})\/(\d+)$/i.exec(path);
    if (match) { const item = assets.get(assetKey(match[1], match[2])); if (item) return item.quote; }
    throw Error('未知的本地 Firsto 查询。');
  };
  const journal = input => {
    const path = new URL(input, 'http://127.0.0.1:3218').pathname.split('/journal/')[1]; trace.journalReads.push(path);
    if (path === 'product-graph') return fixture.graph();
    if (path === 'notifications/capabilities') return { enabled: false };
    if (path === 'session') return { account };
    if (['market', 'budget-queue', 'governance', 'portfolio'].includes(path)) return { revision: 0, record: null };
    if (path === 'authority-relay/status') return { status: 'idle' };
    throw Error('未知的预览 journal GET。');
  };
  return { account, manifest, manifestSha: fixture.manifestSha, source, rpc, index, firsto, journal, trace, orderEpochMs,
    orders: orders.map(row => structuredClone(row)),
    pools: { funding: rows[0].pool, active: rows[1].pool, listed: rows[2].pool },
    portfolios: PORTFOLIOS, kinds: { Funding: 2, Active: 3, Listed: 1 },
    label: '效果预览 · 示例数据 · 正式钱包不要连接', broadcastCount: 0 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fixture = createMobileLayoutPreviewFixture();
  if (process.argv.includes('--manifest')) console.log(plainJson(fixture.manifest));
  else if (process.argv.includes('--sha')) console.log(fixture.manifestSha);
  else console.log(plainJson({ account: fixture.account, manifestSha: fixture.manifestSha,
    basePath: PREVIEW_BASE_PATH, kinds: fixture.kinds, label: fixture.label, broadcastCount: 0 }));
}
