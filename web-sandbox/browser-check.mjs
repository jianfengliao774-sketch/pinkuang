/** Local synthetic EIP-1193 wallet only. No chain RPC, signature or real transaction is allowed. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { Interface, toQuantity } from '../deploy/node_modules/ethers/lib.esm/index.js';
import { DEPLOY_ORDER, KIND, PREFIX, linkBytecode } from './src/sandbox-model.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const raw = await readFile(path.join(dist, 'sale-sandbox-artifacts.json'), 'utf8');
const artifact = JSON.parse(raw), digest = `0x${createHash('sha256').update(raw).digest('hex')}`;
const { chromium } = await import(process.env.BEMINE_PLAYWRIGHT_MODULE || 'playwright');
const out = process.env.BEMINE_BROWSER_OUTPUT || path.join(tmpdir(), 'bemine-sale-sandbox-browser');
await mkdir(out, { recursive: true });
const owner = '0x1111111111111111111111111111111111111111', other = '0x2222222222222222222222222222222222222222';
const addr = (n) => `0x${BigInt(n).toString(16).padStart(40, '0')}`;
const hash = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const addresses = Object.fromEntries(DEPLOY_ORDER.map((name, i) => [name, addr(100 + i)]));
const nft = addr(200), pool = addresses.SandboxSalePool;
const iface = new Interface(artifact.contracts.SandboxSalePool.abi);
const nftIface = new Interface(artifact.auxiliaryContracts.SandboxMockMiner.abi);
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const name = path.basename(url.pathname === '/bemine-sale-test/' ? 'index.html' : url.pathname);
    if (!['index.html', 'sale-sandbox-artifacts.json'].includes(name) && !/^(app-[a-f0-9]{12}\.mjs|style-[a-f0-9]{12}\.css)$/.test(name)) throw new Error('Unknown static test path');
    const body = await readFile(path.join(dist, name));
    res.writeHead(200, { 'Content-Type': name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.mjs') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'application/json' }); res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`, base = `${origin}/bemine-sale-test/`;
const browser = await chromium.launch({ headless: true, channel: process.env.BEMINE_TEST_BROWSER || 'chrome' });
const checks = [], errors = [], prohibited = [];
let context, page, f;

function runtime(name) {
  const record = artifact.contracts[name] ?? artifact.auxiliaryContracts[name];
  let code = linkBytecode(record.deployedBytecode, record.deployedLinkReferences, addresses);
  if (name !== 'SandboxSalePool' && name !== 'SandboxMockMiner' && code.startsWith(`0x73${'0'.repeat(40)}`)) code = `0x73${addresses[name].slice(2)}${code.slice(44)}`;
  for (const slots of Object.values(record.immutableReferences ?? {})) for (const slot of slots) {
    const pos = 2 + slot.start * 2, value = owner.slice(2).padStart(slot.length * 2, '0');
    code = code.slice(0, pos) + value + code.slice(pos + slot.length * 2);
  }
  return code;
}

function fixture(complete = false) {
  const timestamp = 1900000000;
  const state = { account: owner, chain: 56, requests: [], sends: [], sendAttempts: 0, rejectAt: 0, rejectNext: false, noHashNext: false, delegated: false, receiptMode: 'confirmed', transactions: new Map(), codes: new Map(), timestamp, state: 2n, activatedAt: BigInt(timestamp - 70), purchaseCost: 10000000000000n, balances: new Map([[owner, 100n], [other, 0n]]), proposal: null, voted: new Set(), review: [0, 0n], reference: [10000000000000n, BigInt(timestamp), hash(500)], nftOwner: pool, saleBuyer: addr(0), salePrice: 0n, saleProceeds: 0n, listedProposalId: 0n, expiresAt: 0n, withdrawn: new Set() };
  if (complete) { for (const name of DEPLOY_ORDER) state.codes.set(addresses[name].toLowerCase(), runtime(name)); state.codes.set(nft.toLowerCase(), runtime('SandboxMockMiner')); }
  return state;
}

function manifest() {
  return { schemaVersion: 1, kind: KIND, chainId: 56, artifactDigest: digest, owner, purchaseCost: '10000000000000', initialMembers: [owner], initialShares: [100], simulatedNft: nft, steps: Object.fromEntries(DEPLOY_ORDER.map((name, i) => [name, { step: name, account: owner, status: 'confirmed', hash: hash(10 + i), address: addresses[name] }])), transactions: [] };
}

function getter(name, args) {
  const account = String(args.length ? args[0] : f.account).toLowerCase();
  const balance = f.balances.get(account) ?? 0n;
  const net = f.saleProceeds - f.saleProceeds / 100n;
  const pending = f.state === 4n && !f.withdrawn.has(account) ? net * balance / 100n : 0n;
  switch (name) {
    case 'owner': case 'treasury': case 'operator': return [owner];
    case 'factory': case 'shareMarket': return [pool];
    case 'simulationOnly': return [true];
    case 'simulatedNft': return [nft];
    case 'tokenId': return [1n];
    case 'totalSupply': return [100n];
    case 'balanceOf': return [balance];
    case 'state': return [f.state];
    case 'activatedAt': return [f.activatedAt];
    case 'firstProposalAt': return [f.activatedAt + 60n];
    case 'proposalCooldown': return [60n];
    case 'voteDuration': return [300n];
    case 'listingDuration': return [900n];
    case 'purchaseCost': return [f.purchaseCost];
    case 'memberCount': return [BigInt([...f.balances.values()].filter((v) => v > 0n).length)];
    case 'activeProposalId': return [f.proposal ? 1n : 0n];
    case 'nextProposalId': return [f.proposal ? 2n : 1n];
    case 'listedProposalId': return [f.listedProposalId];
    case 'expiresAt': return [f.expiresAt];
    case 'salePrice': return [f.salePrice];
    case 'saleBuyer': return [f.saleBuyer];
    case 'saleProceeds': return [f.saleProceeds];
    case 'bnbOwed': return [f.state === 4n && same(account, owner) && !f.withdrawn.has(account) ? f.saleProceeds / 100n : 0n];
    case 'pendingSaleProceeds': return [pending];
    case 'saleReference': return f.reference;
    case 'lastProposed': return [f.proposal && same(account, f.proposal.proposer) ? BigInt(f.timestamp) : 0n];
    case 'getProposal': return [f.proposal];
    case 'hasVoted': return [f.voted.has(String(args[1]).toLowerCase())];
    case 'saleReview': return f.review;
    default: throw new Error(`Unexpected read ${name}`);
  }
}

function apply(call, tx) {
  if (!call) return;
  const { name, args } = call;
  switch (name) {
    case 'propose':
      f.proposal = { proposer: tx.from, snapshotTs: BigInt(f.timestamp), endsAt: BigInt(f.timestamp + 300), refAt: args[2], price: args[0], refPrice: args[1], snapshotMemberCount: BigInt([...f.balances.values()].filter((v) => v > 0n).length), snapshotTotalShares: 100n, yesCount: 0n, yesShares: 0n, executed: false }; break;
    case 'vote':
      f.voted.add(tx.from.toLowerCase()); if (args[1]) { f.proposal.yesCount++; f.proposal.yesShares += f.balances.get(tx.from.toLowerCase()) ?? 0n; } break;
    case 'reviewSale': assert(same(tx.from, owner)); assert(same(args[0], pool)); f.review = [args[3] ? 1 : 2, args[2]]; break;
    case 'setSaleReference': assert(same(tx.from, owner)); assert(same(args[0], pool)); f.reference = [args[1], args[2], args[3]]; break;
    case 'executeSale': f.proposal.executed = true; f.state = 3n; f.listedProposalId = args[0]; f.salePrice = f.proposal.price; f.expiresAt = BigInt(f.timestamp + 900); break;
    case 'completeSimulatedSale': assert.equal(BigInt(tx.value), args[1]); assert.equal(args[1], f.salePrice); f.state = 4n; f.saleBuyer = tx.from; f.nftOwner = tx.from; f.saleProceeds = args[1]; break;
    case 'withdrawBnb': assert.equal(BigInt(tx.value), 0n); f.withdrawn.add(tx.from.toLowerCase()); break;
    case 'transfer': { const from = tx.from.toLowerCase(), to = String(args[0]).toLowerCase(); f.balances.set(from, (f.balances.get(from) ?? 0n) - args[1]); f.balances.set(to, (f.balances.get(to) ?? 0n) + args[1]); break; }
    default: throw new Error(`Unexpected synthetic write ${name}`);
  }
}

async function request(p) {
  f.requests.push(p.method);
  switch (p.method) {
    case 'eth_accounts': case 'eth_requestAccounts': return [f.account];
    case 'eth_chainId': return toQuantity(f.chain);
    case 'eth_getCode': return f.codes.get(String(p.params[0]).toLowerCase()) ?? (f.delegated && same(p.params[0], f.account) ? '0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b' : '0x');
    case 'eth_getBlockByNumber': return { number: '0x64', timestamp: toQuantity(f.timestamp), hash: hash(100) };
    case 'eth_call': {
      const tx = p.params[0];
      if (same(tx.to, nft)) { const call = nftIface.parseTransaction(tx); assert.equal(call.name, 'ownerOf'); return nftIface.encodeFunctionResult('ownerOf', [f.nftOwner]); }
      assert(same(tx.to, pool), 'Only the synthetic sandbox may be read');
      const call = iface.parseTransaction(tx); return iface.encodeFunctionResult(call.name, getter(call.name, call.args));
    }
    case 'eth_sendTransaction': {
      assert.equal(f.chain, 56, 'Cannot send on another chain'); const tx = p.params[0]; assert(same(tx.from, f.account));
      f.sendAttempts++;
      if (f.rejectNext || f.rejectAt === f.sendAttempts) { f.rejectNext = false; throw Object.assign(Error('Synthetic user rejection'), { code: 4001 }); }
      assert.equal(BigInt(tx.value), tx.to ? BigInt(tx.value) : 0n);
      let name, call;
      if (!tx.to) {
        name = DEPLOY_ORDER.find((name) => !f.codes.has(addresses[name].toLowerCase())); assert(name, 'No extra synthetic deployment');
        const deployment = artifact.contracts[name];
        const code = linkBytecode(deployment.bytecode, deployment.linkReferences, addresses);
        const params = name === 'SandboxSalePool' ? [owner, [owner], [100], 10000000000000n] : [];
        const expected = code + new Interface(deployment.abi).encodeDeploy(params).slice(2);
        assert.equal(tx.data.toLowerCase(), expected.toLowerCase(), 'Exact local compiler initcode and explicit owner only');
      } else { assert(same(tx.to, pool), 'Only synthetic sandbox writes'); call = iface.parseTransaction(tx); assert(BigInt(tx.value) <= 1000000000000000n); }
      const txHash = hash(1000 + f.sends.length), entry = { tx: { ...tx, hash: txHash, input: tx.data }, call, name, applied: false };
      f.sends.push(entry); f.transactions.set(txHash, entry);
      if (f.noHashNext) { f.noHashNext = false; throw Object.assign(Error('Synthetic send RPC response lost after broadcast'), { code: -32005 }); }
      return txHash;
    }
    case 'eth_getTransactionReceipt': {
      const entry = f.transactions.get(p.params[0]); if (!entry || f.receiptMode === 'pending') return null;
      if (f.receiptMode === 'network-error') throw Object.assign(Error('Synthetic RPC read temporarily unavailable'), { code: -32005 });
      const failed = f.receiptMode === 'failed';
      if (!failed && !entry.applied) {
        if (entry.name) { f.codes.set(addresses[entry.name].toLowerCase(), runtime(entry.name)); if (entry.name === 'SandboxSalePool') f.codes.set(nft.toLowerCase(), runtime('SandboxMockMiner')); }
        else apply(entry.call, entry.tx);
        entry.applied = true;
      }
      return { transactionHash: p.params[0], from: entry.tx.from, to: entry.tx.to ?? null, status: failed ? '0x0' : '0x1', blockNumber: '0x64', blockHash: hash(100), contractAddress: entry.name && !failed ? addresses[entry.name] : null };
    }
    case 'eth_getTransactionByHash': return f.transactions.get(p.params[0])?.tx ?? null;
    default: throw new Error(`Forbidden / unsupported wallet method ${p.method}`);
  }
}

async function setup(complete = false, viewport = { width: 1400, height: 1000 }) {
  await context?.close(); f = fixture(complete);
  context = await browser.newContext({ viewport }); page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || /\/api\//.test(url.pathname) || /bemine-v4/.test(url.pathname)) { prohibited.push(url.href); return route.abort(); }
    return route.continue();
  });
  await page.exposeFunction('__sandboxWallet', async (p) => {
    try { return { result: await request(p) }; } catch (error) { if (error.code !== 4001 && error.code !== -32005) console.error('FIXTURE', p.method, error.message); return { error: { code: error.code ?? -32000, message: error.message } }; }
  });
  await page.addInitScript(({ seed, origin, digest }) => {
    if (seed) localStorage.setItem(`bemine-sale-sandbox:v1:${origin}:${digest}:active`, JSON.stringify(seed));
    const listeners = new Map();
    window.__sandboxEmit = (event, value) => { for (const callback of listeners.get(event) ?? []) callback(value); };
    window.ethereum = { isMetaMask: true, async request(p) { const answer = await window.__sandboxWallet(p); if (answer.error) throw Object.assign(new Error(answer.error.message), { code: answer.error.code }); return answer.result; }, on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); }, removeListener(event, fn) { listeners.get(event)?.delete(fn); } };
    const originalTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, ms, ...args) => originalTimeout(callback, ms === 2000 ? 3 : ms, ...args);
  }, { seed: complete ? manifest() : null, origin, digest });
  await page.goto(base); await page.locator('[data-action="export"]').waitFor();
}

async function connect() {
  await page.locator('#connect').click();
  if (f.codes.has(pool.toLowerCase())) {
    await page.getByText('2. 出售提案', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[data-action="refresh"]')?.disabled === false);
  }
}
async function submit(action) { await page.locator(`[data-action="${action}"]`).click(); await page.locator('#confirm-dialog[open]').waitFor(); await page.locator('#confirm-submit').click(); await page.locator('#result-dialog[open]').waitFor(); }
async function acknowledge() { await page.locator('#result-dialog .dialog-footer button').click(); }
async function switchAccount(account) { f.account = account; await page.evaluate((account) => window.__sandboxEmit('accountsChanged', [account]), account); await page.waitForFunction((account) => document.querySelector('#connect').textContent.includes(account.slice(-4)), account); await page.locator('[data-action="refresh"]').click(); }
function checked(message) { checks.push(message); console.log('PASS ' + message); }

try {
  await setup();
  assert.equal(f.requests.length, 0, 'No automatic connection or chain query before click');
  await connect(); f.rejectAt = 2;
  await submit('deploy'); assert.match(await page.locator('#result-title').textContent(), /暂停/);
  assert.equal(f.sends.length, 1, 'Only first library deployed before rejected second request');
  const saved = await page.evaluate(({ origin, digest }) => JSON.parse(localStorage.getItem(`bemine-sale-sandbox:v1:${origin}:${digest}:active`)), { origin, digest });
  assert.equal(saved.steps.ShareCheckpoints.status, 'confirmed'); assert.equal(saved.steps.SaleSettlement.status, 'idle');
  await acknowledge(); f.rejectAt = 0; await submit('deploy');
  assert.equal(f.sends.length, 3, 'Resume deploys only second library and pool');
  assert.match(await page.locator('#result-title').textContent(), /部署完成/, await page.locator('#result-body').textContent()); await acknowledge();
  await page.getByText('2. 出售提案', { exact: true }).waitFor();
  const before = f.sends.length; await page.reload(); await page.locator('[data-action="export"]').waitFor(); assert.equal(f.sends.length, before); assert.equal(await page.locator('#result-dialog').isVisible(), false); await connect(); assert.equal(f.sends.length, before);
  for (let repeat = 0; repeat < 2; repeat++) {
    await page.locator('[data-action="refresh"]').click();
    await page.waitForFunction(() => document.querySelector('[data-action="refresh"]')?.disabled === false && document.querySelector('[data-action="refresh"]').textContent === '刷新项目');
  }
  assert.equal(f.sends.length, before, 'Repeated refresh remains available without sending any transaction');
  checked('No auto connection/send; exact two linked libraries + owner-bound pool; rejected deployment resumes without replay; reload no duplicate popup');
  checked('Refresh completion restores the button; two consecutive manual refreshes remain enabled and send no transaction');

  await page.locator('#field-price').fill('0.000005'); await submit('propose'); assert.match(await page.locator('#result-title').textContent(), /成功/); await acknowledge();
  await submit('yes'); await acknowledge();
  await page.locator('[data-action="execute"]').waitFor(); assert.equal(await page.locator('[data-action="execute"]').isEnabled(), false, 'Low-price execution requires admin review');
  await submit('approve'); await acknowledge(); await page.waitForFunction(() => !document.querySelector('[data-action="execute"]').disabled);
  await submit('execute'); await acknowledge(); assert.equal(f.state, 3n); assert(f.timestamp < Number(f.proposal.endsAt), 'Immediate execution before voting expiry');
  checked('Low price requires exact admin review; integer dual majority enables immediate execution before 300-second expiry');

  await switchAccount(other); await page.waitForFunction(() => document.querySelector('[data-action="buy"]')?.disabled === false); await submit('buy');
  assert.equal(f.nftOwner.toLowerCase(), other); assert.equal(f.saleProceeds, 5000000000000n); assert.equal(f.sends.at(-1).call.name, 'completeSimulatedSale'); assert.equal(BigInt(f.sends.at(-1).tx.value), 5000000000000n); await acknowledge();
  await switchAccount(owner); await page.waitForFunction(() => document.querySelector('[data-action="withdraw"]')?.disabled === false); await submit('withdraw'); await acknowledge();
  assert.equal(f.sends.at(-1).call.name, 'withdrawBnb'); assert.equal(BigInt(f.sends.at(-1).tx.value), 0n); assert(f.withdrawn.has(owner));
  assert.equal(f.sends.filter((entry) => entry.call?.name === 'withdrawBnb').length, 1); await page.screenshot({ path: path.join(out, 'completed-desktop.png'), fullPage: true });
  checked('Buyer sends exact sub-five-decimal wei and receives only mock NFT; owner settles and withdraws own member proceeds plus fee in one transaction');

  await setup(true); await connect(); f.rejectNext = true;
  await submit('propose'); assert.match(await page.locator('#result-title').textContent(), /取消/); assert.equal(await page.locator('#result-body a').count(), 0); assert.equal(f.sends.length, 0); await acknowledge();
  f.receiptMode = 'pending'; await submit('propose'); assert.match(await page.locator('#result-title').textContent(), /等待/); assert.equal(await page.locator('[data-action="propose"]').isEnabled(), false); assert.equal(f.sends.length, 1); await acknowledge();
  f.receiptMode = 'network-error'; await page.locator('[data-action="check"]').click(); await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('RPC')); assert.equal(await page.locator('#result-dialog').isVisible(), false); assert.equal(f.sends.length, 1);
  f.receiptMode = 'failed'; await page.locator('[data-action="check"]').click(); await page.locator('#result-dialog[open]').waitFor(); assert.match(await page.locator('#result-title').textContent(), /失败/); const link = await page.locator('#result-body a').getAttribute('href'); assert.equal(link, `https://bscscan.com/tx/${hash(1000)}`); await acknowledge();
  checked('Wallet rejection has no hash link; pending persists and prevents duplicate send; RPC errors do not report failure; receipt zero reports exact-hash failure');

  await setup(); await connect(); f.noHashNext = true;
  await submit('deploy'); assert.match(await page.locator('#result-title').textContent(), /尚未完成/); assert.equal(f.sends.length, 1);
  const interrupted = await page.evaluate(({ origin, digest }) => JSON.parse(localStorage.getItem(`bemine-sale-sandbox:v1:${origin}:${digest}:active`)), { origin, digest });
  assert.equal(interrupted.steps.ShareCheckpoints.status, 'uncertain'); assert.equal(interrupted.steps.ShareCheckpoints.hash, undefined);
  await acknowledge(); await page.reload(); await page.locator('[data-action="export"]').waitFor(); await connect();
  assert.equal(await page.locator('[data-action="deploy"]').isEnabled(), false, 'No-hash recovery cannot deploy again after reload'); assert.equal(f.sendAttempts, 1);
  await page.locator('#field-recoveryHash').fill(hash(9000)); await page.locator('[data-action="recover"]').click();
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('不匹配')); assert.equal(f.sendAttempts, 1); assert.equal(await page.locator('[data-action="deploy"]').isEnabled(), false);
  await page.locator('#field-recoveryHash').fill(hash(1000)); await page.locator('[data-action="recover"]').click(); await page.locator('#result-dialog[open]').waitFor(); assert.match(await page.locator('#result-title').textContent(), /恢复成功/); await acknowledge();
  await submit('deploy'); assert.match(await page.locator('#result-title').textContent(), /部署完成/); assert.equal(f.sends.length, 3); assert.equal(f.sendAttempts, 3); await acknowledge();
  checked('Lost send response persists uncertain state; reload blocks duplicate CREATE; unrelated hash refused; exact hash recovery resumes only remaining two deployments');

  await setup(); f.chain = 97; await connect(); await page.locator('[data-action="deploy"]').click(); await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('主网')); assert.equal(f.sends.length, 0); assert.equal(await page.locator('#confirm-dialog').isVisible(), false);
  checked('Wrong-chain wallet cannot request any deployment transaction');

  await setup(); f.delegated = true; await connect(); await page.getByText('当前钱包启用了智能账户委托。', { exact: true }).waitFor(); assert.equal(await page.locator('[data-action="deploy"]').isEnabled(), false); assert.equal(f.sends.length, 0);
  await page.locator('#direct-confirm').check(); assert.equal(await page.locator('[data-action="deploy"]').isEnabled(), true);
  await page.locator('[data-action="deploy"]').click(); await page.locator('#confirm-dialog[open]').waitFor();
  await page.setViewportSize({ width: 375, height: 560 });
  const bounds = await page.locator('#confirm-submit').boundingBox(); assert(bounds.y >= 0 && bounds.y + bounds.height <= 560, 'Confirmation remains visible on short mobile screen');
  await page.screenshot({ path: path.join(out, 'short-screen-deploy.png'), fullPage: false });
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#confirm-dialog').isVisible(), false); assert.equal(f.sends.length, 0);
  checked('EIP-7702 account explicitly sets ordinary transaction mode; 375×560 fixed confirmation footer visible; Escape never sends');

  assert.deepEqual(prohibited, [], 'No production API, RPC, CDN or external network request');
  assert.deepEqual(errors, [], 'No browser runtime error');
  await writeFile(path.join(out, 'results.json'), JSON.stringify({ passed: checks.length, checks, errors, prohibited }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, output: out }));
} finally { await context?.close(); await browser.close(); await new Promise((resolve) => server.close(resolve)); }
