/** Browser-test data only. Never import this file from app/components/lib or publish it as an asset. */
import { Interface, ZeroAddress, getAddress, keccak256, parseEther, toQuantity } from 'ethers';
import { abi, ARTIFACT_DIGEST } from '../lib/chain-client.mjs';

const address = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
export const FIXTURE_ACCOUNT = address(0xa11ce);
export const FIXTURE_OTHER_ACCOUNT = address(0xb0b);
export const FIXTURE_POOLS = Object.freeze({ funding: address(0x101), active: address(0x102), listed: address(0x103), voting: address(0x104) });
export const FIXTURE_CONTRACTS = Object.freeze({ factory: address(0x201), shareMarket: address(0x202), lens: address(0x203), beacon: address(0x204), timelock: address(0x205) });
const TAPEOUT = getAddress('0xb1024b89886b9a34aa4ff5f31c411d708b20a14c');
const BEHEMOTH = getAddress('0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c');
const CODE = '0x60006000', BLOCK = 100, DEPLOYMENT_BLOCK = 90;
const blockHash = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const bindings = new Interface(['function owner() view returns(address)', 'function factory() view returns(address)',
  'function timelock() view returns(address)', 'function lens() view returns(address)', 'function shareMarket() view returns(address)',
  'function beacon() view returns(address)', 'function VERSION() view returns(uint256)']);
const match = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);

/** Exported separately so a Node smoke check can run the same RPC/index through the real adapter. */
export function createLiveBrowserFixture({ account = FIXTURE_ACCOUNT, timestamp = Math.floor(Date.now() / 1000),
  incomplete = false, sourceOverrides = {}, manifestOverrides = {}, confirmDeposit = false, pendingDeposit = false,
  fundingShares = 20n, isOperator = false } = {}) {
  fundingShares = BigInt(fundingShares);
  if (fundingShares < 0n || fundingShares > 65n) throw new Error('Invalid fixture funding shares');
  account = getAddress(account);
  let head = BLOCK, nonce = 7, revision = 0, record = null, sent = null, readyToConfirm = !pendingDeposit, armed = false;
  const sentTransactions = [], trace = [], results = new Map(), historicRows = new Map();
  const currentTimestamp = () => timestamp + (head - BLOCK) * 3;
  const { factory, shareMarket, lens, beacon, timelock } = FIXTURE_CONTRACTS;
  const rows = Object.entries(FIXTURE_POOLS).map(([kind, pool], i) => {
    const funding = kind === 'funding', listed = kind === 'listed';
    const targetRaise = parseEther(['7.15', '8.8', '6.05', '11'][i]);
    const shares = [fundingShares, 35n, 12n, 30n][i], lockedShares = kind === 'active' ? 5n : 0n;
    return { pool, status: { validMask: (1n << 17n) - 1n, errorMask: 0n, trustError: 0n },
      params: { circuits: i % 2 ? BEHEMOTH : TAPEOUT, circuitId: [16210n, 8204n, 15832n, 9052n][i],
        targetRaise, priceCap: targetRaise * 10n / 11n, directSeller: ZeroAddress, directPrice: 0n,
        fundingDeadline: BigInt(timestamp + (funding ? 3 : -20) * 86400), purchaseDeadline: BigInt(timestamp + (funding ? 4 : -19) * 86400) },
      state: funding ? 0n : listed ? 3n : 2n, unitPriceWei: targetRaise / 100n,
      totalRaised: funding ? targetRaise * 65n / 100n : targetRaise, totalSupply: funding ? 65n : 100n,
      memberCount: 3n, depositPaused: false, purchaseCost: funding ? 0n : targetRaise * 10n / 11n,
      activatedAt: funding ? 0n : BigInt(timestamp - (i + 10) * 86400), shareTradingAllowed: kind === 'active',
      shares, lockedShares, availableShares: shares - lockedShares,
      claimableBEM: funding ? 0n : BigInt([0, 68420000, 31415000, 125000000][i]),
      bnbOwed: funding ? 0n : parseEther(['0', '0.12', '0.085', '0.2'][i]), initialContributedWei: shares * targetRaise / 100n };
  });
  const manifest = { schemaVersion: 1, chainId: 56, ...FIXTURE_CONTRACTS,
    deployment: { txHash: blockHash(900), blockNumber: DEPLOYMENT_BLOCK, blockHash: blockHash(DEPLOYMENT_BLOCK) },
    artifactDigest: ARTIFACT_DIGEST, sourceCommit: 'f'.repeat(40), verifiedAt: new Date(timestamp * 1000).toISOString(),
    verifiedBlockNumber: 95, codehash: Object.fromEntries(Object.keys(FIXTURE_CONTRACTS).map(key => [key, keccak256(CODE)])), ...manifestOverrides };
  const source = () => ({ chainId: 56, factory, market: shareMarket, startBlock: DEPLOYMENT_BLOCK, confirmations: 12,
    indexedThrough: head, indexedBlockHash: blockHash(head), indexedTimestamp: currentTimestamp(), observedSafeHead: head,
    complete: !incomplete, checkedAt: new Date().toISOString(), unknownReason: incomplete ? 'fixture_index_incomplete' : null, ...sourceOverrides });
  const orders = [{ orderId: '2', seller: account, pool: FIXTURE_POOLS.active, remaining: '5', pricePerUnitWei: parseEther('0.083').toString(),
    expiresAt: String(timestamp + 3 * 86400), listedBlock: 98, openAtSourceBlock: true, executable: false },
  { orderId: '1', seller: FIXTURE_OTHER_ACCOUNT, pool: FIXTURE_POOLS.active, remaining: '8', pricePerUnitWei: parseEther('0.081').toString(),
    expiresAt: String(timestamp + 5 * 86400), listedBlock: 97, openAtSourceBlock: true, executable: false }];
  const events = rows.flatMap((row, i) => [{ blockNumber: 100 - i, blockHash: blockHash(100 - i), timestamp: timestamp - i * 3,
    transactionHash: blockHash(1000 + i), transactionIndex: 1, logIndex: 1, contract: row.pool, pool: row.pool, source: 'pool',
    event: i ? 'BemClaimed' : 'Deposited', fields: i ? { user: account.toLowerCase(), amount: String(10000000 * (i + 1)) }
      : { user: account.toLowerCase(), shares: fundingShares.toString(), amount: row.initialContributedWei.toString(), totalRaised: row.totalRaised.toString() } }]);
  const rowsAt = block => historicRows.get(block) ?? rows;
  const rowFor = (pool, block = head) => { const row = rowsAt(block).find(r => match(r.pool, pool)); if (!row) throw new Error(`Unknown fixture pool ${pool}`); return row; };
  function position(row, owner) {
    if (match(owner, account)) return row;
    return { ...row, shares: 0n, lockedShares: 0n, availableShares: 0n, claimableBEM: 0n, bnbOwed: 0n, initialContributedWei: 0n };
  }
  function governance(pool, owner) {
    const row = rowFor(pool), voting = match(pool, FIXTURE_POOLS.voting), listed = row.state === 3n;
    const basicMask = [0, 1, 2, 4, 7, 8, 9, 12].reduce((mask, bit) => mask | 1n << BigInt(bit), 0n);
    const proposalMask = (1n << 14n) - 1n;
    const validMask = voting || listed ? owner === ZeroAddress ? proposalMask & ~(1n << 5n | 1n << 6n) : proposalMask : basicMask;
    return { status: { validMask, errorMask: 0n, trustError: 0n }, state: row.state,
      activeProposalId: voting || listed ? 1n : 0n,
      proposal: { proposer: account, snapshotTs: BigInt(timestamp - 3600), endsAt: BigInt(timestamp - 3600 + 86400),
        refAt: BigInt(timestamp - 3600), price: row.params.priceCap + parseEther('0.5'), refPrice: row.params.priceCap,
        snapshotMemberCount: 3n, snapshotTotalShares: 100n, yesCount: 2n, yesShares: 60n, executed: listed },
      purchaseCost: row.purchaseCost, hasVoted: false, snapshotShares: match(owner, account) ? row.shares : 0n,
      listedProposalId: listed ? 1n : 0n, expiresAt: listed ? BigInt(timestamp + 2 * 86400) : 0n,
      salePrice: listed ? parseEther('6') : 0n, requiredYesCount: 2n, requiredYesShares: 51n,
      discounted: false, passed: voting || listed, canVote: voting && match(owner, account), canExecute: voting, canCancelExpired: false };
  }
  async function request({ method, params = [] }) {
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_blockNumber') return toQuantity(head);
    if (confirmDeposit && method === 'eth_getBalance') return toQuantity(parseEther('100'));
    if (confirmDeposit && method === 'eth_gasPrice') return toQuantity(100000000n);
    if (confirmDeposit && method === 'eth_getTransactionCount') return toQuantity(nonce + (params[1] === 'pending' && sent ? 1 : 0));
    if (confirmDeposit && method === 'eth_estimateGas') { checkedDeposit(params[0]); return toQuantity(150000); }
    if (confirmDeposit && method === 'eth_sendTransaction') {
      const tx = params[0]; checkedDeposit(tx);
      if (!record || sent || !match(record.target, tx.to) || record.data.toLowerCase() !== tx.data.toLowerCase()
        || record.value !== BigInt(tx.value).toString() || record.nonce !== Number(BigInt(tx.nonce))) throw new Error('Fixture fake send requires the exact preceding journal ACK.');
      const hash = blockHash(0xd30000 + nonce); sent = { hash, transaction: structuredClone(tx) };
      sentTransactions.push(structuredClone(sent)); trace.push('wallet:fake-send'); return hash;
    }
    if (method === 'eth_getCode') return CODE;
    if (method === 'eth_getStorageAt') return `0x${'00'.repeat(32)}`;
    if (method === 'eth_getBlockByNumber') {
      const number = ['latest', 'safe', 'finalized'].includes(params[0]) ? head : Number(BigInt(params[0]));
      return { number: toQuantity(number), timestamp: toQuantity(timestamp - (BLOCK - number) * 3), hash: blockHash(number) };
    }
    if (method !== 'eth_call') throw new Error(`Fixture refuses unsupported or signing RPC method: ${method}`);
    const tx = params[0], to = getAddress(tx.to);
    if (confirmDeposit && match(to, FIXTURE_POOLS.funding) && tx.data?.slice(0, 10) === abi.PoolVault.getFunction('deposit').selector) {
      checkedDeposit(tx); return abi.PoolVault.encodeFunctionResult('deposit', []);
    }
    const readBlock = ['latest', 'safe', 'finalized', undefined].includes(params[1]) ? head : Number(BigInt(params[1]));
    let iface = match(to, factory) ? abi.PoolFactory : match(to, lens) ? abi.PoolLens : match(to, shareMarket) ? abi.ShareMarket
      : rows.some(row => match(row.pool, to)) ? abi.PoolVault : bindings;
    let parsed = iface.parseTransaction(tx); if (!parsed) { iface = bindings; parsed = iface.parseTransaction(tx); }
    if (!parsed) throw new Error('Unknown fixture calldata.');
    let result;
    switch (parsed.name) {
      case 'lens': result = lens; break;
      case 'operator': result = isOperator ? account : FIXTURE_OTHER_ACCOUNT; break;
      case 'creationPaused': result = false; break;
      case 'createPool': result = address(0x105); break;
      case 'factory': case 'OFFICIAL_FACTORY': result = factory; break;
      case 'timelock': case 'owner': result = timelock; break;
      case 'shareMarket': result = shareMarket; break;
      case 'beacon': result = beacon; break;
      case 'VERSION': result = 1n; break;
      case 'poolCount': result = BigInt(rows.length); break;
      case 'isPool': result = rows.some(row => match(row.pool, parsed.args[0])); break;
      case 'positions': case 'poolPage': {
        const selected = parsed.name === 'positions' ? Array.from(parsed.args[0], pool => rowFor(pool, readBlock))
          : rowsAt(readBlock).slice(Number(parsed.args[0]), Number(parsed.args[0] + parsed.args[1]));
        const owner = parsed.name === 'positions' ? parsed.args[1] : parsed.args[2];
        result = { blockNumber: BigInt(readBlock), timestamp: BigInt(timestamp + (readBlock - BLOCK) * 3), totalPools: BigInt(rows.length),
          nextCursor: BigInt(selected.length), registryCountValid: true, pools: selected.map(row => position(row, owner)) }; break;
      }
      case 'orders': { const order = orders.find(row => BigInt(row.orderId) === parsed.args[0]); if (!order) throw new Error('Unknown fixture order');
        result = { seller: order.seller, pool: order.pool, remaining: BigInt(order.remaining), pricePerUnit: BigInt(order.pricePerUnitWei), active: true }; break; }
      case 'orderExpiresAt': result = BigInt(orders.find(row => BigInt(row.orderId) === parsed.args[0])?.expiresAt ?? 0); break;
      case 'governance': result = governance(parsed.args[0], parsed.args[1]); break;
      case 'bnbOwed': result = match(to, shareMarket) ? match(parsed.args[0], account) ? parseEther('0.067') : 0n : position(rowFor(to), parsed.args[0]).bnbOwed; break;
      case 'activeMembers': result = [account, FIXTURE_OTHER_ACCOUNT, address(0xca11)]; break;
      case 'state': result = rowFor(to).state; break;
      case 'purchaseCost': result = rowFor(to).purchaseCost; break;
      case 'activatedAt': result = rowFor(to).activatedAt; break;
      case 'activeProposalId': result = governance(to, account).activeProposalId; break;
      case 'nextProposalId': result = governance(to, account).activeProposalId + 1n; break;
      case 'lastProposed': result = 0n; break;
      case 'balanceOf': result = position(rowFor(to), parsed.args[0]).shares; break;
      case 'getProposal': result = governance(to, account).proposal; break;
      case 'proposalPassed': result = true; break;
      case 'hasVoted': result = false; break;
      case 'getPastShares': result = position(rowFor(to), parsed.args[0]).shares; break;
      case 'listedProposalId': result = governance(to, account).listedProposalId; break;
      case 'expiresAt': result = governance(to, account).expiresAt; break;
      case 'unitPriceWei': result = rowFor(to).unitPriceWei; break;
      case 'salePrice': result = governance(to, account).salePrice; break;
      default: throw new Error(`Fixture refuses unsupported call ${parsed.name}.`);
    }
    return iface.encodeFunctionResult(parsed.name, [result]);
  }
  function index(input) {
    const url = new URL(input, 'http://fixture.test'), route = url.pathname.replace(/^.*\/api\/chain-index/, ''), q = url.searchParams;
    const limit = Number(q.get('limit') ?? 20); let data;
    const offsetPage = items => { const offset = Number(q.get('cursor') ?? 0), selected = items.slice(offset, offset + limit);
      return { items: selected, nextCursor: offset + selected.length < items.length ? offset + selected.length : null }; };
    if (route === '/health') return { source: source() };
    if (incomplete) return { source: source(), data: null, error: 'Fixture index incomplete.' };
    if (route === '/v1/pools') data = offsetPage(rows.map(row => ({ address: row.pool, createdBlock: 96,
      collection: row.params.circuits, circuitId: row.params.circuitId.toString() })));
    else if (/^\/v1\/accounts\/0x[\da-f]{40}\/pools$/i.test(route)) data = offsetPage(match(route.split('/')[3], account) ? rows.map(row => row.pool) : []);
    else if (route === '/v1/stats') data = { scope: 'confirmed_indexed_history', registeredPoolCount: String(rows.length), everParticipantAddressCount: '3',
      purchasedCostWei: rows.reduce((sum, row) => sum + row.purchaseCost, 0n).toString(), shareMarketFilledGrossWei: parseEther('1.85').toString(),
      harvestedToMembersBemAtomic: '3842900000', estimatedDailyBemAtomic: null, currentlyActivePoolCount: null };
    else if (route === '/v1/orders') {
      const selected = orders.filter(row => (!q.get('pool') || match(row.pool, q.get('pool'))) && (!q.get('seller') || match(row.seller, q.get('seller')))
        && q.get('active') !== 'false' && (!q.get('cursor') || BigInt(row.orderId) < BigInt(q.get('cursor'))));
      data = { items: selected.slice(0, limit), nextCursor: selected.length > limit ? selected[limit - 1].orderId : null };
    } else if (route === '/v1/activity') {
      const selected = events.filter(row => (!q.get('pool') || match(row.pool, q.get('pool'))) && (!q.get('account') || match(q.get('account'), account))
        && (!q.get('cursor') || row.blockNumber < Number(q.get('cursor').split(':')[0])));
      const items = selected.slice(0, limit), last = items.at(-1);
      data = { items, nextCursor: selected.length > limit ? `${last.blockNumber}:${last.transactionIndex}:${last.logIndex}` : null };
    } else if (route === '/v1/yield') {
      const days = Number(q.get('days') ?? 30), date = new Date((currentTimestamp() + 28800) * 1000).toISOString().slice(0, 10);
      data = { scope: 'pool', pool: rowFor(q.get('pool')).pool, account: q.get('account') || null, timezone: 'Asia/Shanghai', token: 'BEM', tokenDecimals: 8,
        buckets: Array.from({ length: days }, (_, i) => ({ date: new Date(Date.parse(`${date}T00:00:00Z`) - (days - 1 - i) * 86400000).toISOString().slice(0, 10),
          poolHarvestNetAtomic: String((i + 1) * 4200000), accountClaimedAtomic: q.get('account') ? String((i + 1) * 840000) : null })), accountUnclaimedDailyAccrual: null };
    } else throw new Error(`Unknown fixture index route ${route}`);
    return { source: source(), data };
  }
  function checkedDeposit(tx) {
    if (!match(tx?.from, account) || !match(tx?.to, FIXTURE_POOLS.funding)) throw new Error('Fixture only simulates deposits from its test wallet.');
    const parsed = abi.PoolVault.parseTransaction(tx), row = rowFor(FIXTURE_POOLS.funding);
    if (parsed?.name !== 'deposit' || parsed.args[0] < 1n || parsed.args[0] + row.totalSupply > 100n
      || BigInt(tx.value) !== parsed.args[0] * row.unitPriceWei) throw new Error('Invalid fixture deposit.');
    return parsed.args[0];
  }
  function finalizeDeposit() {
    if (!sent || !record || !readyToConfirm) return null;
    const shares = checkedDeposit(sent.transaction), amount = BigInt(record.value), row = rowFor(FIXTURE_POOLS.funding);
    const priorHead = head, receiptBlock = head + 1;
    historicRows.set(priorHead, structuredClone(rows)); head += 3;
    row.shares += shares; row.availableShares += shares; row.totalSupply += shares; row.totalRaised += amount; row.initialContributedWei += amount;
    if (row.totalSupply === 100n) row.state = 1n;
    const hash = sent.hash, result = { action: 'deposit', status: 'confirmed', finalized: true, transactionHash: hash,
      account, target: row.pool, nonce: record.nonce, factory, poolAddress: row.pool, shares: shares.toString(), amountWei: amount.toString(),
      receipt: { status: 1, transactionHash: hash, to: row.pool, blockNumber: receiptBlock, blockHash: blockHash(receiptBlock) } };
    const event = abi.PoolVault.encodeEventLog(abi.PoolVault.getEvent('Deposited'), [account, shares, amount, row.totalRaised]);
    result.receipt.logs = [{ address: row.pool, topics: event.topics, data: event.data, removed: false }];
    events.unshift({ blockNumber: receiptBlock, blockHash: blockHash(receiptBlock), timestamp: timestamp + (receiptBlock - BLOCK) * 3,
      transactionHash: hash, transactionIndex: 0, logIndex: 0, contract: row.pool, pool: row.pool, source: 'pool', event: 'Deposited',
      fields: { user: account.toLowerCase(), shares: shares.toString(), amount: amount.toString(), totalRaised: row.totalRaised.toString() } });
    results.set(hash, result); nonce++; record = null; sent = null; revision++; trace.push('journal:finalized'); return result;
  }
  function journal(input, method = 'GET', body) {
    const url = new URL(input, 'http://fixture.test'), route = url.pathname.replace(/^.*\/api\/journal\//, '');
    trace.push(`journal:${method}:${route}`);
    if (!confirmDeposit) return { status: 503, body: { error: 'Deposit confirmation fixture is disabled.' } };
    if (route === 'session' && method === 'GET') return { status: 200, body: { account } };
    if (route === 'market/result' && method === 'GET') return { status: 200, body: { result: results.get(url.searchParams.get('hash')) ?? null } };
    if (route === 'market/arm' && method === 'POST') {
      if (!record || armed || body?.expectedRevision !== revision) return { status: 409, body: { error: 'Signature permission already consumed or revision changed.' } };
      armed = true; revision++; const r = record;
      return { status: 200, body: { revision, record: structuredClone(r), transaction: { from: r.account, to: r.target, chainId: '0x38',
        nonce: toQuantity(r.nonce), data: r.data, value: toQuantity(BigInt(r.value)), gas: toQuantity(BigInt(r.gas)), gasPrice: toQuantity(BigInt(r.gasPrice)), type: '0x0' } } };
    }
    if (route === 'market/abandon' && method === 'POST') {
      if (!record || armed || record.hash || body?.expectedRevision !== revision) return { status: 409, body: { error: 'Intent is not safe to abandon.' } };
      record = null; revision++; return { status: 200, body: { revision, record } };
    }
    if (route !== 'market') return { status: 404, body: { error: 'Unknown fixture journal route.' } };
    if (method === 'GET') return { status: 200, body: { revision, record: structuredClone(record), canAbandon: !!record && !armed && !record.hash } };
    if (body?.expectedRevision !== revision) return { status: 409, body: { error: 'Fixture revision changed.' } };
    if (method === 'PUT') {
      const next = body.record;
      if (next?.version !== 2 || next.chainId !== 56 || next.action?.kind !== 'deposit' || !match(next.account, account)
        || !match(next.target, FIXTURE_POOLS.funding) || !match(next.factory, factory) || next.nonce !== nonce)
        return { status: 400, body: { error: 'Only the exact test deposit is accepted.' } };
      checkedDeposit({ from: next.account, to: next.target, data: next.data, value: next.value });
      record = structuredClone(next); revision++; trace.push('journal:ack');
      return { status: 200, body: { revision, record: structuredClone(record) } };
    }
    if (method === 'DELETE') {
      if (!sent || body.hash !== sent.hash || !readyToConfirm) return { status: 409, body: { error: 'Fixture transaction is pending finality.' } };
      return { status: 200, body: { result: finalizeDeposit(), revision, record: null } };
    }
    return { status: 405, body: { error: 'Unsupported fixture journal method.' } };
  }
  const controls = { sentTransactions, trace, confirm() { readyToConfirm = true; return { readyToConfirm, pendingHash: sent?.hash ?? null }; },
    pending() { readyToConfirm = false; }, journalState() { return { revision, record: structuredClone(record), pendingHash: sent?.hash ?? null }; } };
  return { manifest, source, request, index, journal, controls, account, pools: FIXTURE_POOLS, rows, orders };
}

/** Call before page.goto. All simulated chain traffic remains in this Playwright process. */
export async function installLiveFixture(page, options = {}) {
  const fixture = createLiveBrowserFixture(options), requests = [], walletRequests = [];
  await page.route(/\/data\/frontend-manifest\.json(?:\?.*)?$/, route => route.fulfill({ status: 200, contentType: 'application/json', body: json(fixture.manifest) }));
  await page.route(/\/api\/rpc(?:\?.*)?$/, async route => {
    try { const payload = route.request().postDataJSON(); requests.push(payload);
      await options.beforeRpc?.(payload);
      const result = await fixture.request(payload); await route.fulfill({ status: 200, contentType: 'application/json', body: json({ jsonrpc: '2.0', id: payload.id, result }) });
    } catch (error) { await route.fulfill({ status: 400, contentType: 'application/json', body: json({ error: error.message }) }); }
  });
  await page.route(/\/api\/chain-index\//, async route => {
    try { const result = fixture.index(route.request().url()); await route.fulfill({ status: result.source.complete || route.request().url().endsWith('/health') ? 200 : 503,
      contentType: 'application/json', body: json(result) }); }
    catch (error) { await route.fulfill({ status: 400, contentType: 'application/json', body: json({ error: error.message }) }); }
  });
  await page.route(/\/api\/journal\//, async route => {
    try { const request = route.request(), result = fixture.journal(request.url(), request.method(), request.postData() ? request.postDataJSON() : undefined);
      await route.fulfill({ status: result.status, contentType: 'application/json', body: json(result.body) }); }
    catch (error) { await route.fulfill({ status: 400, contentType: 'application/json', body: json({ error: error.message }) }); }
  });
  await page.exposeFunction('__bemineFixtureRead', async payload => { walletRequests.push(payload); return fixture.request(payload); });
  await page.addInitScript(({ account, confirmDeposit }) => {
    let connected = false; const events = new Map();
    const wallet = { isMetaMask: true, isConnected: () => true,
      async request(payload) {
        if (payload.method === 'eth_requestAccounts') { connected = true; return [account]; }
        if (payload.method === 'eth_accounts') return connected ? [account] : [];
        if (/sign|send|wallet_/i.test(payload.method) && !(confirmDeposit && payload.method === 'eth_sendTransaction')) {
          const error = new Error('Browser fixture refuses all signatures and wallet writes.'); error.code = 4001; throw error; }
        return window.__bemineFixtureRead(payload);
      }, on(event, listener) { if (!events.has(event)) events.set(event, new Set()); events.get(event).add(listener); return wallet; },
      removeListener(event, listener) { events.get(event)?.delete(listener); return wallet; },
      __emit(event, value) { for (const listener of events.get(event) ?? []) listener(value); } };
    Object.defineProperty(window, 'ethereum', { configurable: true, value: wallet });
  }, { account: fixture.account, confirmDeposit: options.confirmDeposit === true });
  return { ...fixture, requests, walletRequests };
}
