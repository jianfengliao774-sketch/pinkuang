import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Contract, JsonRpcProvider, getAddress, keccak256, verifyMessage, ZeroAddress } from 'ethers';
import { abi, ARTIFACT_DIGEST } from '../lib/chain-client.mjs';

const CHAIN_ID = 56n;
const COOKIE = 'bemine_live';
const SESSION_MS = 12 * 60 * 60 * 1000;
const CHALLENGE_MS = 5 * 60 * 1000;
const MAX_CHALLENGES = 1000;
const MAX_SESSIONS = 1000;
const MAX_HASHES = 16;
const PREPARED_EXPIRES_MS = 10 * 60 * 1000;
const MAX_UINT256 = (1n << 256n) - 1n;
const HASH = /^0x[\da-fA-F]{64}$/;
const ZERO_VALUE_ACTIONS = new Set(['withdrawDeposit', 'withdrawBnb', 'harvest', 'claim']);
const ACTIONS = new Set(['deposit', ...ZERO_VALUE_ACTIONS]);
const MARKET_ACTIONS = new Set(['list', 'fill', 'cancel', 'expire', 'withdrawBnb']);
const GOVERNANCE_ACTIONS = new Set(['propose', 'vote', 'executeSale', 'cancelExpired', 'completeSale']);
const lower = value => getAddress(value).toLowerCase();
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

function readJsonFile(path) {
  if (lstatSync(path).isSymbolicLink()) throw new Error('Deployment evidence cannot be a symlink.');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function expectedDeployment(manifest, record) {
  if (manifest?.schemaVersion !== 1 || manifest.chainId !== 56 || record?.schemaVersion !== 1 ||
      record.chainId !== 56 || record.status !== 'complete' ||
      manifest.artifactDigest !== ARTIFACT_DIGEST || record.artifactDigest !== ARTIFACT_DIGEST ||
      manifest.sourceCommit !== record.sourceCommit || !Array.isArray(record.verification?.checks) ||
      !record.verification.checks.length || record.verification.checks.some(item => !item.passed) ||
      !Array.isArray(record.steps) || !record.steps.length || record.steps.some(item => item.status !== 'confirmed') ||
      !record.steps.some(item => item.id === 'initialize' && item.receipt?.status === 1 && HASH.test(item.txHash ?? ''))) {
    throw new Error('Deployment evidence does not match the current compiled source or completed verification.');
  }
  const top = ['factory', 'shareMarket', 'lens', 'beacon', 'timelock'];
  const implementations = ['PoolFactory', 'ShareMarket', 'PoolVault'];
  const requiredChecks = ['Factory.lens', 'Lens.factory', 'Market.factory', 'Market.timelock', 'Beacon.owner',
    ...[...top, ...implementations].map(name => `${name} 运行代码匹配`)];
  if (requiredChecks.some(label => !record.verification.checks.some(item => item.label === label && item.passed))) {
    throw new Error('Deployment graph or runtime checks are incomplete.');
  }
  const code = {};
  for (const name of [...top, ...implementations]) {
    const address = getAddress(record.addresses?.[name]);
    const proof = record.verification.code?.[name];
    const hash = proof?.codehash;
    if (!HASH.test(hash ?? '') || lower(proof.address) !== lower(address) ||
        top.includes(name) && (lower(manifest[name]) !== lower(address) || manifest.codehash?.[name]?.toLowerCase() !== hash.toLowerCase())) {
      throw new Error(`Missing or conflicting deployment code proof for ${name}.`);
    }
    code[name] = { address, hash: hash.toLowerCase() };
  }
  return { code, artifactDigest: ARTIFACT_DIGEST };
}

function privateDatabase(path) {
  const file = resolve(path);
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = lstatSync(directory);
  if (parent.isSymbolicLink() || !parent.isDirectory() || (parent.mode & 0o077)) throw new Error('Live journal directory must be private (0700) and not a symlink.');
  try { if (lstatSync(file).isSymbolicLink()) throw new Error('Live journal database cannot be a symlink.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS intents (
      id TEXT PRIMARY KEY, account TEXT NOT NULL, nonce INTEGER NOT NULL,
      pool TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL, value TEXT NOT NULL,
      created_at INTEGER NOT NULL, status TEXT NOT NULL, active INTEGER NOT NULL,
      completed_hash TEXT, gas_estimate TEXT NOT NULL, target TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_intent ON intents(account) WHERE active=1;
    CREATE TABLE IF NOT EXISTS intent_hashes (
      intent_id TEXT NOT NULL, hash TEXT NOT NULL, observed_at INTEGER NOT NULL,
      PRIMARY KEY(intent_id, hash), FOREIGN KEY(intent_id) REFERENCES intents(id)
    );`);
  // Existing pool-only journals remain valid: their target was the pool itself.
  if (!db.prepare('PRAGMA table_info(intents)').all().some(column => column.name === 'target')) {
    db.exec('ALTER TABLE intents ADD COLUMN target TEXT');
  }
  return db;
}

function noCache(res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}
function json(res, code, body) { noCache(res); res.statusCode = code; res.end(JSON.stringify(body)); }
function fail(code, message) { const error = new Error(message); error.status = code; throw error; }
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16384) fail(413, 'Request too large.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'Invalid JSON.'); }
}
function cookieToken(req) {
  const text = req.headers.cookie ?? '';
  return text.split(';').map(item => item.trim()).find(item => item.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
}
function storedIntent(db, id) {
  const row = db.prepare('SELECT * FROM intents WHERE id=?').get(id);
  if (!row) return null;
  const hashes = db.prepare('SELECT hash FROM intent_hashes WHERE intent_id=? ORDER BY observed_at,hash').all(id).map(item => item.hash);
  return { id: row.id, account: row.account, nonce: row.nonce, target: row.target ?? row.pool,
    pool: row.pool, action: row.action,
    data: row.data, value: row.value, createdAt: row.created_at, status: row.status,
    active: !!row.active, completedHash: row.completed_hash, gasEstimate: row.gas_estimate, hashes };
}

export function liveConfiguration(env = process.env) {
  if (!env.LIVE_MANIFEST_PATH || !env.LIVE_DEPLOYMENT_RECORD_PATH) throw new Error('Verified deployment manifest and complete record are required.');
  const expected = expectedDeployment(readJsonFile(env.LIVE_MANIFEST_PATH), readJsonFile(env.LIVE_DEPLOYMENT_RECORD_PATH));
  const factory = expected.code.factory.address;
  if (env.LIVE_FACTORY && lower(env.LIVE_FACTORY) !== lower(factory)) throw new Error('LIVE_FACTORY differs from verified deployment.');
  const origin = new URL(env.LIVE_ORIGIN ?? '');
  if (origin.origin !== env.LIVE_ORIGIN || origin.username || origin.password ||
      !['https:', 'http:'].includes(origin.protocol) ||
      (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) {
    throw new Error('LIVE_ORIGIN must be an exact HTTPS origin (localhost may use HTTP).');
  }
  const rpc = new URL(env.LIVE_RPC_URL ?? '');
  if (rpc.protocol !== 'https:' || rpc.username || rpc.password) throw new Error('LIVE_RPC_URL must be HTTPS without URL credentials.');
  const index = new URL(env.LIVE_INDEX_URL ?? '');
  if (!['https:', 'http:'].includes(index.protocol) || index.username || index.password ||
      index.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(index.hostname)) {
    throw new Error('LIVE_INDEX_URL must be HTTPS or local HTTP.');
  }
  if (!env.LIVE_JOURNAL_DB) throw new Error('LIVE_JOURNAL_DB is required.');
  const publicBasePath = env.LIVE_PUBLIC_BASE_PATH || '';
  if (publicBasePath && !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(publicBasePath)) throw new Error('LIVE_PUBLIC_BASE_PATH is invalid.');
  const port = Number(env.LIVE_PORT || 4190);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('LIVE_PORT is invalid.');
  return { factory, expected, origin: origin.origin, rpc: rpc.href, index: index.origin,
    dbPath: env.LIVE_JOURNAL_DB, host: '127.0.0.1', port, cookiePath: `${publicBasePath}/api/live` };
}

/** The live API persists every intent before asking for a wallet signature. It never signs or sends. */
export function createLiveApi(config, { provider = new JsonRpcProvider(config.rpc, 56), fetchImpl = fetch, now = Date.now, onError = () => {} } = {}) {
  const factory = getAddress(config.factory);
  const db = privateDatabase(config.dbPath);
  const challenges = new Map(), sessions = new Map();
  const registry = new Contract(factory, abi.PoolFactory, provider);
  const marketAddress = getAddress(config.expected.code.shareMarket.address);
  const marketContract = new Contract(marketAddress, abi.ShareMarket, provider);
  let cachedIdentity = null, cacheUntil = 0;
  const knownPool = async pool => {
    if (await registry.isPool(pool) !== true) fail(400, 'Pool is not registered by the configured Factory.');
    const vault = new Contract(pool, abi.PoolVault, provider);
    const [poolFactory, officialFactory] = await Promise.all([vault.factory(), vault.OFFICIAL_FACTORY()]);
    if (lower(poolFactory) !== lower(factory) || lower(officialFactory) !== lower(factory)) fail(400, 'Pool Factory identity mismatch.');
    return vault;
  };
  async function marketIntent({ parsed, account, pool, value, expected, allowFree, requireExpected = true }) {
    if (!parsed || !MARKET_ACTIONS.has(parsed.name)) fail(400, 'Unsupported ShareMarket action.');
    if (await marketContract.feeBps() !== 100n) fail(503, 'Reviewed ShareMarket fee changed.');
    const method = parsed.name;
    if (method === 'withdrawBnb') {
      if (lower(pool) !== lower(marketAddress) || value !== 0n || await marketContract.bnbOwed(account) === 0n) {
        fail(400, 'Market BNB withdrawal is not currently available.');
      }
      return `market:${method}`;
    }
    let vault;
    if (method === 'list') {
      const [listedPool, amount, price] = parsed.args;
      if (lower(listedPool) !== lower(pool) || amount < 1n || amount > 100n ||
          price > MAX_UINT256 / amount || value !== 0n ||
          price === 0n && requireExpected && allowFree !== true) fail(400, 'Invalid Market listing amount, price or pool.');
      vault = await knownPool(pool);
      const [state, tradable, available] = await Promise.all([
        vault.state(), vault.shareTradingAllowed(), vault.availableShares(account),
      ]);
      if (state !== 2n || !tradable || available < amount) fail(409, 'Shares are not available for a Market listing.');
      return 'market:list';
    }
    const id = parsed.args[0];
    if (id < 1n || id >= await marketContract.nextOrderId()) fail(400, 'Market order ID is not registered.');
    const [order, expiresAt] = await Promise.all([marketContract.orders(id), marketContract.orderExpiresAt(id)]);
    if (!order.active || lower(order.pool) !== lower(pool) || order.seller === ZeroAddress ||
        order.remaining < 1n) fail(409, 'Market order changed or is closed.');
    vault = await knownPool(pool);
    if (requireExpected && method === 'fill') {
      if (!expected || lower(expected.seller) !== lower(order.seller) ||
          !/^(0|[1-9]\d*)$/.test(expected.pricePerUnitWei ?? '') ||
          BigInt(expected.pricePerUnitWei) !== order.pricePerUnit) fail(409, 'Market seller or unit price changed.');
    }
    if (method === 'fill') {
      const amount = parsed.args[1];
      if (amount < 1n || amount > 100n || amount > order.remaining ||
          order.pricePerUnit > MAX_UINT256 / amount ||
          value !== amount * order.pricePerUnit || lower(order.seller) === account) {
        fail(400, 'Market fill amount, seller or exact BNB payment is invalid.');
      }
      const [block, state, tradable, locked] = await Promise.all([
        provider.getBlock('latest'), vault.state(), vault.shareTradingAllowed(), vault.lockedShares(order.seller),
      ]);
      if (!block || expiresAt === 0n || expiresAt <= BigInt(block.timestamp) || state !== 2n ||
          !tradable || locked < amount) fail(409, 'Market order expired or trading is unavailable.');
      return 'market:fill';
    }
    if (value !== 0n) fail(400, 'Market cancellation and expiry cannot carry BNB.');
    if (method === 'cancel') {
      if (lower(order.seller) !== account) fail(403, 'Only the order seller can cancel it.');
      return 'market:cancel';
    }
    const block = await provider.getBlock('latest');
    if (!block || expiresAt !== 0n && expiresAt > BigInt(block.timestamp)) fail(409, 'Market order has not expired.');
    return 'market:expire';
  }
  async function governanceIntent({ parsed, account, pool, value, vault }) {
    if (!parsed || !GOVERNANCE_ACTIONS.has(parsed.name)) fail(400, 'Unsupported sale governance action.');
    const block = await provider.getBlock('latest');
    if (!block) fail(503, 'BSC block is unavailable for governance validation.');
    const timestamp = BigInt(block.timestamp), state = await vault.state();
    const method = parsed.name;
    if (method === 'propose') {
      const [price, reference, refAt] = parsed.args;
      const [shares, activatedAt] = await Promise.all([vault.balanceOf(account), vault.activatedAt()]);
      if (value !== 0n || state !== 2n || shares < 1n || price < 1n || reference < 1n ||
          refAt > timestamp || timestamp < activatedAt + 7n * 86400n) fail(409, 'Sale proposal is not valid for this member or pool state.');
      return 'governance:propose';
    }
    if (method === 'vote' || method === 'executeSale') {
      if (value !== 0n || state !== 2n) fail(409, 'This governance action requires an active pool and zero BNB.');
      const id = parsed.args[0];
      const [activeId, nextId] = await Promise.all([vault.activeProposalId(), vault.nextProposalId()]);
      if (id < 1n || activeId < 1n || id < activeId || id >= nextId) fail(409, 'Proposal is not a current sale-round candidate.');
      const [opener, candidate] = await Promise.all([vault.getProposal(activeId), vault.getProposal(id)]);
      if (candidate.snapshotTs !== opener.snapshotTs || candidate.endsAt !== opener.endsAt ||
          candidate.snapshotTs + 86400n !== candidate.endsAt || candidate.executed ||
          timestamp >= candidate.endsAt || candidate.price < 1n) fail(409, 'Sale-round candidate changed or expired.');
      if (method === 'vote') {
        if (await vault.hasVoted(id, account)) fail(409, 'This wallet already voted for the candidate.');
      } else if (!await vault.proposalPassed(id)) fail(409, 'Sale candidate has not met both voting thresholds.');
      return `governance:${method}`;
    }
    if (method === 'cancelExpired') {
      const [listedId, expiresAt] = await Promise.all([vault.listedProposalId(), vault.expiresAt()]);
      if (value !== 0n || state !== 3n || listedId < 1n || timestamp < expiresAt) {
        fail(409, 'Whole-miner listing has not expired.');
      }
      return 'governance:cancelExpired';
    }
    const [listedId, expiresAt, salePrice] = await Promise.all([
      vault.listedProposalId(), vault.expiresAt(), vault.salePrice(),
    ]);
    if (state !== 3n || listedId < 1n || timestamp >= expiresAt || salePrice < 1n || value !== salePrice) {
      fail(409, 'Whole-miner sale amount or listing state changed.');
    }
    const listed = await vault.getProposal(listedId);
    if (!listed.executed || listed.price !== salePrice || listed.snapshotTs + 86400n !== listed.endsAt) {
      fail(409, 'Whole-miner listing proposal is not the reviewed atomic-sale candidate.');
    }
    return 'governance:completeSale';
  }
  async function identity({ fresh = false } = {}) {
    if (!fresh && cachedIdentity && now() < cacheUntil) return cachedIdentity;
    if (BigInt(await provider.send('eth_chainId', [])) !== CHAIN_ID) fail(503, 'RPC is not BSC mainnet.');
    if (!config.expected?.code || config.expected.artifactDigest !== ARTIFACT_DIGEST) fail(503, 'Reviewed deployment evidence is absent.');
    const expected = config.expected.code;
    const names = ['factory', 'shareMarket', 'lens', 'beacon', 'timelock', 'PoolFactory', 'ShareMarket', 'PoolVault'];
    const codes = await Promise.all(names.map(async name => keccak256(await provider.getCode(expected[name].address))));
    if (names.some((name, index) => codes[index].toLowerCase() !== expected[name].hash.toLowerCase())) fail(503, 'A deployed contract code hash differs from the reviewed record.');
    const [lens, market, beacon, timelock, factorySlot, marketSlot] = await Promise.all([
      registry.lens(), registry.shareMarket(), registry.beacon(), registry.timelock(),
      provider.getStorage(factory, IMPLEMENTATION_SLOT), provider.getStorage(expected.shareMarket.address, IMPLEMENTATION_SLOT),
    ]);
    if (lower(lens) !== lower(expected.lens.address) || lower(market) !== lower(expected.shareMarket.address) ||
        lower(beacon) !== lower(expected.beacon.address) || lower(timelock) !== lower(expected.timelock.address) ||
        lower(`0x${factorySlot.slice(-40)}`) !== lower(expected.PoolFactory.address) ||
        lower(`0x${marketSlot.slice(-40)}`) !== lower(expected.ShareMarket.address)) fail(503, 'Upgrade slot or Factory dependency changed from reviewed deployment.');
    const lensContract = new Contract(lens, abi.PoolLens, provider);
    const marketContract = new Contract(market, abi.ShareMarket, provider);
    const beaconContract = new Contract(beacon, ['function implementation() view returns(address)', 'function owner() view returns(address)'], provider);
    const [lensFactory, version, marketFactory, marketTimelock, vaultImpl, beaconOwner] = await Promise.all([
      lensContract.factory(), lensContract.VERSION(), marketContract.factory(), marketContract.timelock(),
      beaconContract.implementation(), beaconContract.owner(),
    ]);
    if (lower(lensFactory) !== lower(factory) || version !== 1n || lower(marketFactory) !== lower(factory) ||
        lower(marketTimelock) !== lower(timelock) || lower(vaultImpl) !== lower(expected.PoolVault.address) ||
        lower(beaconOwner) !== lower(timelock)) fail(503, 'Reviewed contract graph changed.');
    cachedIdentity = { chainId: 56, factory, lens: getAddress(lens), market: getAddress(market), artifactDigest: ARTIFACT_DIGEST };
    cacheUntil = now() + 10000;
    return cachedIdentity;
  }
  function accountOf(req) {
    const token = cookieToken(req);
    const session = sessions.get(token);
    if (!session || session.expires <= now()) fail(401, 'Wallet session required.');
    let selected;
    try { selected = lower(req.headers['x-bemine-account'] ?? ''); }
    catch { fail(403, 'Selected wallet differs from server session.'); }
    if (selected !== session.account) fail(403, 'Selected wallet differs from server session.');
    return session.account;
  }
  async function reconcile(row) {
    if (!row) return null;
    if (!row.active) return storedIntent(db, row.id);
    if (row.status === 'prepared' && row.created_at + PREPARED_EXPIRES_MS <= now()) {
      db.prepare("UPDATE intents SET active=0,status='abandoned' WHERE id=? AND status='prepared' AND active=1").run(row.id);
      return storedIntent(db, row.id);
    }
    if (BigInt(await provider.send('eth_chainId', [])) !== CHAIN_ID) fail(503, 'RPC is not BSC mainnet; transaction journal remains pending.');
    const hashes = db.prepare('SELECT hash FROM intent_hashes WHERE intent_id=? ORDER BY observed_at').all(row.id);
    let finalized;
    try { finalized = await provider.getBlock('finalized'); } catch { return storedIntent(db, row.id); }
    if (!finalized) return storedIntent(db, row.id);
    for (const item of hashes) {
      const tx = await provider.getTransaction(item.hash);
      if (!tx) continue;
      if (lower(tx.from) !== row.account || tx.nonce !== row.nonce || tx.chainId !== CHAIN_ID) continue;
      const original = tx.to && lower(tx.to) === (row.target ?? row.pool) &&
        tx.data.toLowerCase() === row.data && tx.value.toString() === row.value;
      const cancel = tx.to && lower(tx.to) === row.account && tx.data === '0x' && tx.value === 0n;
      const receipt = await provider.getTransactionReceipt(item.hash);
      if (!receipt) continue;
      const block = await provider.getBlock(receipt.blockNumber);
      if (receipt.blockHash !== block?.hash || receipt.blockNumber > finalized.number ||
          lower(receipt.from) !== row.account || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber) continue;
      const status = original ? receipt.status === 1 ? 'complete' : 'reverted' : cancel ? 'cancelled' : 'replaced';
      db.prepare('UPDATE intents SET active=0,status=?,completed_hash=? WHERE id=? AND active=1').run(status, item.hash, row.id);
      return storedIntent(db, row.id);
    }
    return storedIntent(db, row.id);
  }
  const server = createServer(async (req, res) => {
    try {
      if (!req.url || req.url.length > 2048) fail(400, 'Invalid URL.');
      const url = new URL(req.url, 'http://localhost');
      const method = req.method;
      if (method === 'OPTIONS') fail(405, 'CORS is not enabled.');
      if (!['GET', 'POST'].includes(method)) fail(405, 'Method not allowed.');
      if (method === 'POST' && req.headers.origin !== config.origin) fail(403, 'Exact Origin required.');
      if (method === 'GET' && url.pathname === '/api/live/config') {
        return json(res, 200, { ...await identity(), journal: true });
      }
      if (method === 'GET' && url.pathname.startsWith('/api/live/index/')) {
        const suffix = url.pathname.slice('/api/live/index'.length);
        if (!/^\/v1\/(pools|orders|activity|stats|accounts\/0x[0-9a-fA-F]{40}\/pools)$/.test(suffix)) fail(404, 'Unknown index route.');
        const upstream = await fetchImpl(`${config.index}${suffix}${url.search}`, { signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' } });
        const result = await upstream.json();
        if (!upstream.ok || !result.source?.complete || result.source.chainId !== 56 ||
            lower(result.source.factory) !== lower(factory) || lower(result.source.market) !== lower((await identity()).market)) {
          fail(503, 'Verified server index unavailable.');
        }
        return json(res, 200, result);
      }
      if (method === 'POST' && url.pathname === '/api/live/challenge') {
        const input = await body(req), account = lower(input.account);
        for (const [key, item] of challenges) if (item.expires <= now()) challenges.delete(key);
        if (challenges.size >= MAX_CHALLENGES) fail(429, 'Too many pending wallet challenges.');
        const nonce = randomBytes(24).toString('hex'), expires = now() + CHALLENGE_MS;
        const message = `BEMine live journal login\nOrigin: ${config.origin}\nChain ID: 56\nAccount: ${getAddress(account)}\nNonce: ${nonce}\nExpires At: ${new Date(expires).toISOString()}`;
        challenges.set(nonce, { account, message, expires });
        return json(res, 200, { nonce, message });
      }
      if (method === 'POST' && url.pathname === '/api/live/session') {
        const input = await body(req), account = lower(input.account), challenge = challenges.get(input.nonce);
        challenges.delete(input.nonce);
        let recovered = null;
        try { recovered = verifyMessage(challenge?.message ?? '', input.signature); } catch {}
        if (!challenge || challenge.account !== account || challenge.expires <= now() ||
            !recovered || lower(recovered) !== account) fail(401, 'Invalid or expired wallet challenge.');
        for (const [key, item] of sessions) if (item.expires <= now()) sessions.delete(key);
        if (sessions.size >= MAX_SESSIONS) fail(429, 'Too many wallet sessions.');
        const token = randomBytes(32).toString('hex');
        sessions.set(token, { account, expires: now() + SESSION_MS });
        res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=${config.cookiePath ?? '/api/live'}; Max-Age=${SESSION_MS / 1000}${config.origin.startsWith('https:') ? '; Secure' : ''}`);
        return json(res, 200, { account: getAddress(account) });
      }
      if (method === 'GET' && url.pathname === '/api/live/session') return json(res, 200, { account: getAddress(accountOf(req)) });
      const account = accountOf(req);
      if (method === 'GET' && url.pathname === '/api/live/intent') {
        const row = db.prepare('SELECT * FROM intents WHERE account=? AND active=1').get(account);
        return json(res, 200, { intent: await reconcile(row), history: db.prepare('SELECT id FROM intents WHERE account=? AND active=0 ORDER BY created_at DESC LIMIT 10').all(account).map(({ id }) => storedIntent(db, id)) });
      }
      if (method === 'POST' && url.pathname === '/api/live/intent') {
        const input = await body(req), pool = getAddress(input.pool);
        const existing = db.prepare('SELECT * FROM intents WHERE account=? AND active=1').get(account);
        if (existing && (await reconcile(existing))?.active) fail(409, 'An earlier transaction still needs finality or hash recovery.');
        if (input.chainId !== 56 || input.artifactDigest?.toLowerCase() !== ARTIFACT_DIGEST.toLowerCase() ||
            lower(input.account) !== account || !Number.isSafeInteger(input.nonce) || input.nonce < 0 ||
            typeof input.data !== 'string' || !/^0x[\da-fA-F]+$/.test(input.data) ||
            !/^(0|[1-9]\d*)$/.test(input.value) || BigInt(input.value) > MAX_UINT256) fail(400, 'Invalid transaction intent.');
        await identity({ fresh: true });
        const target = input.target ? getAddress(input.target) : pool;
        let action;
        if (lower(target) === lower(marketAddress)) {
          const parsed = abi.ShareMarket.parseTransaction({ data: input.data });
          if (!parsed || abi.ShareMarket.encodeFunctionData(parsed.name, parsed.args).toLowerCase() !== input.data.toLowerCase()) {
            fail(400, 'Invalid ShareMarket calldata.');
          }
          action = await marketIntent({ parsed, account, pool, value: BigInt(input.value),
            expected: input.expected, allowFree: input.allowFree });
        } else {
          if (lower(target) !== lower(pool)) fail(400, 'A pool transaction must target its registered pool.');
          const vault = await knownPool(pool);
          const parsed = abi.PoolVault.parseTransaction({ data: input.data });
          if (!parsed || !ACTIONS.has(parsed.name) && !GOVERNANCE_ACTIONS.has(parsed.name) ||
              abi.PoolVault.encodeFunctionData(parsed.name, parsed.args).toLowerCase() !== input.data.toLowerCase()) {
            fail(400, 'Action is not available in live journal.');
          }
          if (GOVERNANCE_ACTIONS.has(parsed.name)) {
            action = await governanceIntent({ parsed, account, pool, value: BigInt(input.value), vault });
          } else if (ZERO_VALUE_ACTIONS.has(parsed.name) && input.value !== '0') fail(400, 'Action must send zero BNB.');
          else if (parsed.name === 'deposit') {
            const quantity = parsed.args[0];
            if (quantity < 1n || quantity > 100n || BigInt(input.value) !== quantity * await vault.unitPriceWei()) fail(400, 'Deposit value does not match exact share price.');
          }
          if (!action) action = parsed.name;
        }
        if (await provider.getTransactionCount(account, 'pending') !== input.nonce) fail(409, 'Wallet nonce changed; refresh and retry.');
        const tx = { from: account, to: target, data: input.data, value: BigInt(input.value), nonce: input.nonce };
        await provider.call(tx);
        const gasEstimate = await provider.estimateGas(tx);
        const id = randomUUID();
        try {
          db.prepare('INSERT INTO intents(id,account,nonce,pool,action,data,value,created_at,status,active,completed_hash,gas_estimate,target) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(id, account, input.nonce, lower(pool), action, input.data.toLowerCase(), input.value,
              now(), 'prepared', 1, null, gasEstimate.toString(), lower(target));
        } catch { fail(409, 'Another page has already saved a transaction intent.'); }
        return json(res, 201, { intent: storedIntent(db, id) });
      }
      if (method === 'POST' && url.pathname === '/api/live/arm') {
        const input = await body(req);
        const row = db.prepare('SELECT * FROM intents WHERE id=? AND account=? AND active=1').get(input.id, account);
        if (!row || row.status !== 'prepared' || row.created_at + PREPARED_EXPIRES_MS <= now()) fail(409, 'Prepared intent expired or changed; refresh before signing.');
        await identity({ fresh: true });
        const target = row.target ?? row.pool;
        if (target === lower(marketAddress)) {
          const parsed = abi.ShareMarket.parseTransaction({ data: row.data });
          await marketIntent({ parsed, account, pool: row.pool, value: BigInt(row.value), requireExpected: false });
        } else {
          const vault = await knownPool(row.pool);
          if (row.action.startsWith('governance:')) {
            const parsed = abi.PoolVault.parseTransaction({ data: row.data });
            await governanceIntent({ parsed, account, pool: row.pool, value: BigInt(row.value), vault });
          }
        }
        if (await provider.getTransactionCount(account, 'pending') !== row.nonce) fail(409, 'Wallet nonce changed before signing.');
        await provider.call({ from: account, to: target, data: row.data, value: BigInt(row.value), nonce: row.nonce });
        db.prepare("UPDATE intents SET status='armed' WHERE id=? AND status='prepared' AND active=1").run(row.id);
        return json(res, 200, { intent: storedIntent(db, row.id) });
      }
      if (method === 'POST' && url.pathname === '/api/live/abandon') {
        const input = await body(req);
        const row = db.prepare('SELECT * FROM intents WHERE id=? AND account=? AND active=1').get(input.id, account);
        if (!row || row.status !== 'prepared' || db.prepare('SELECT 1 FROM intent_hashes WHERE intent_id=? LIMIT 1').get(row.id)) {
          fail(409, 'Only a never-armed intent without a hash can be abandoned.');
        }
        db.prepare("UPDATE intents SET active=0,status='abandoned' WHERE id=? AND status='prepared' AND active=1").run(row.id);
        return json(res, 200, { intent: storedIntent(db, row.id) });
      }
      if (method === 'POST' && url.pathname === '/api/live/hash') {
        const input = await body(req), hash = String(input.hash ?? '').toLowerCase();
        if (!HASH.test(hash)) fail(400, 'Invalid transaction hash.');
        const row = db.prepare('SELECT * FROM intents WHERE id=? AND account=? AND active=1').get(input.id, account);
        if (!row) fail(404, 'Active transaction intent not found.');
        if (row.status === 'prepared') fail(409, 'Intent was never armed for wallet signing.');
        if (BigInt(await provider.send('eth_chainId', [])) !== CHAIN_ID) fail(503, 'RPC is not BSC mainnet; journal unchanged.');
        const count = db.prepare('SELECT COUNT(*) AS total FROM intent_hashes WHERE intent_id=?').get(row.id).total;
        if (count >= MAX_HASHES && !db.prepare('SELECT 1 FROM intent_hashes WHERE intent_id=? AND hash=?').get(row.id, hash)) {
          fail(429, 'Too many recovery hashes for this intent.');
        }
        const observed = await provider.getTransaction(hash);
        if (observed && (lower(observed.from) !== account || observed.nonce !== row.nonce || observed.chainId !== CHAIN_ID)) {
          fail(409, 'Hash belongs to another wallet, nonce or chain.');
        }
        db.prepare('INSERT OR IGNORE INTO intent_hashes VALUES (?,?,?)').run(row.id, hash, now());
        db.prepare("UPDATE intents SET status='submitted' WHERE id=? AND active=1").run(row.id);
        return json(res, 200, { intent: await reconcile(row) });
      }
      fail(404, 'Unknown live API route.');
    } catch (error) {
      const code = error.status ?? 500;
      if (code === 500) onError(error);
      json(res, code, { error: code === 500 ? 'Live service error; transaction state is unchanged.' : error.message });
    }
  });
  return { server, close: () => { db.close(); provider.destroy?.(); }, db };
}
