import { freshRuntimeLayout } from '../shared/fresh-runtime-identity.mjs';
import { createFreshMachineReadiness } from './fresh-machine-readiness.mjs';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { Contract, FetchRequest, Interface, Wallet, getAddress, keccak256,
  parseEther, parseUnits } from 'ethers';
import { JournalStore } from './journal-store.mjs';
import { verifyCurrentAuthorityAdministrator } from './authority-role.mjs';
import { productGraphConfiguration, reviewedAuthorityRuntimeMatches, verifyProductGraph } from './product-graph.mjs';
import { createKeyedLimiter } from './request-limiter.mjs';
import { archiveFinalizedAuthorityFailure, authorityOperationId, prepareAuthorityCall,
  runAuthorityRelay } from '../scripts/authority-relay.mjs';
import { acquireKeeperLock, acquireWalletLock, readJournal,
  reconcilePending, writeJournal } from '../scripts/purchase-keeper.mjs';
import { readKeeperPrivateKey } from '../scripts/keeper-credential.mjs';
import { requireOriginalSenderDrained } from '../shared/original-gas-wallet.mjs';
import { requireMachineAvailable } from '../shared/machine-reservation.mjs';
import { saleReferencePublisherConfiguration, createSaleReferencePublisher } from './sale-reference-publisher.mjs';
import { firstoExpiryKeeperConfiguration, createFirstoListingExpiryKeeper } from './firsto-listing-expiry-keeper.mjs';
import { readOnlyRpcFallbackUrl } from '../shared/read-only-rpc-fallback.mjs';
import { createDeferredRuntimeRpcProvider } from '../shared/runtime-rpc-selection.mjs';

const SESSION_COOKIE = 'pinkuang_journal';
const HASH = /^0x[0-9a-f]{64}$/i;
const ADMIN_ABI = [
  'function coreFactory() view returns(address)',
  'function budgetFactory() view returns(address)',
  'function administratorOne() view returns(address)',
  'function administratorTwo() view returns(address)',
  'function gasWallet() view returns(address)',
  'function nonces(address) view returns(uint256)',
];
const GAS_LIMIT = Object.freeze({
  reviewSale: 650_000n, reviewChildSale: 650_000n, setSaleReference: 500_000n,
  claimFees: 2_500_000n, executeApprovedOperation: 6_000_000n,
  buyBudgetOfficial: 7_000_000n, buyBudgetFirsto: 8_000_000n,
});
const allowedCoreCreation = new Set([
  'createPool', 'createPoolWithExpiry', 'createBudgetChildPool',
  'createFlexiblePool', 'createFlexiblePoolChecked',
]);
const allowedBudgetCreation = new Set(['createPortfolio']);
const POOL_MINE = new Interface(['function mine(bytes data)']);
const MINER_RECLAIM = new Interface(['function reclaim(bytes32 key)']);
const ZERO_HASH = `0x${'0'.repeat(64)}`;
const FRESH_MINING = '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46';
const same = (a, b) => getAddress(a) === getAddress(b);
function relayStatus(status) {
  if (status === 'idle') return 'idle';
  if (status === 'confirmed') return 'confirmed';
  if (['reverted', 'cancelled', 'cancel-reverted', 'previous-operation-failed-review-required',
    'gas-price-over-limit', 'gas-budget-or-balance-exceeded', 'gas-exceeds-block-limit'].includes(status)) return 'failed';
  if (['broadcast', 'signed', 'pending-receipt', 'pending-confirmations', 'pending-finality',
    'pending-not-indexed'].includes(status)) return 'pending';
  return 'uncertain';
}
function operationId(tx) {
  return tx?.to && tx?.data ? authorityOperationId(tx.to, tx.data) : null;
}
function lastFailure(journal) {
  const row = journal.reviewedAuthorityFailures?.at(-1), tx = row?.transaction;
  return tx ? { status: 'failed', hash: tx.hash, kind: tx.kind, operationId: operationId(tx),
    blockNumber: tx.blockNumber, gasCostWei: tx.gasCostWei, archived: true, recoveryRequired: false,
    reason: 'transaction-reverted' } : null;
}
const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
};
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };

async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) fail(415, 'JSON content type is required.');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > 64 * 1024) fail(413, 'Request body is too large.');
  const chunks = []; let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 64 * 1024) fail(413, 'Request body is too large.');
    chunks.push(part);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'Invalid JSON request.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail(400, 'Invalid relay request.');
  return result;
}

function privatePath(path, directory = false) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Authority relay requires absolute private paths.');
  const parent = directory ? path : dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!lstatSync(parent).isDirectory() || (statSync(parent).mode & 0o077) !== 0)
    throw new Error('Authority relay state directory must be a real 0700 directory.');
  if (!directory && existsSync(path) && (!lstatSync(path).isFile() || (statSync(path).mode & 0o077) !== 0))
    throw new Error('Authority relay journal must be a private regular file.');
}

function machineSourceHead(value) {
  if (value !== undefined && (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)))
    throw new Error('Fresh machine source pin must be a lowercase forty-character commit.');
  return value;
}

export function authorityRelayConfiguration(env = process.env) {
  if (env.AUTHORITY_RELAY_ENABLED !== '1') return null;
  if (env.AUTHORITY_REQUIRE_FRESH_READINESS !== '1') throw new Error('Fresh relay requires machine readiness verification.');
  const workerSourceHead = machineSourceHead(env.BEMINE_FRESH_MACHINE_SOURCE_HEAD);
  const layout = freshRuntimeLayout(env);
  const origin = env.DEPLOYMENT_JOURNAL_ORIGIN, rpcUrl = env.DEPLOYMENT_JOURNAL_RPC_URL;
  if (!origin || new URL(origin).origin !== origin || !origin.startsWith('https://'))
    throw new Error('Authority relay requires the exact HTTPS journal origin.');
  if (!rpcUrl || !rpcUrl.startsWith('https://')) throw new Error('Authority relay requires an HTTPS BSC RPC.');
  if (!env.CREDENTIALS_DIRECTORY || env.KEEPER_PRIVATE_KEY)
    throw new Error('Authority relay requires a systemd Gas-wallet credential, never an environment private key.');
  if (!env.PINKUANG_KEEPER_STATE_ROOT || !isAbsolute(env.PINKUANG_KEEPER_STATE_ROOT)
    || env.PINKUANG_KEEPER_STATE_ROOT !== layout.keeperRoot)
    throw new Error('Authority relay requires its exclusive v4 wallet state root.');
  const journal = env.AUTHORITY_RELAY_JOURNAL;
  if (journal !== layout.authorityJournal)
    throw new Error('Authority relay requires its exclusive v4 transaction journal.');
  privatePath(journal);
  const maxGasWei = parseEther(env.AUTHORITY_RELAY_MAX_GAS_BNB ?? '0.5');
  const maxGasPrice = parseUnits(env.AUTHORITY_RELAY_MAX_GAS_PRICE_GWEI ?? '3', 'gwei');
  if (maxGasWei <= 0n || maxGasWei > parseEther('1') || maxGasPrice <= 0n || maxGasPrice > parseUnits('5','gwei'))
    throw new Error('Authority relay gas budget exceeds its hard bound.');
  const expectedGasWallet = getAddress(env.BEMINE_EXPECTED_GAS_WALLET);
  requireOriginalSenderDrained(expectedGasWallet, env);
  for (const key of ['DEPLOYMENT_JOURNAL_DB', 'BEMINE_DEPLOYMENT_RECORD_PATH',
    'BEMINE_PRODUCT_GENESIS_ARTIFACT_PATH', 'BEMINE_PRODUCT_ACTIVATION_PATH']) {
    if (!env[key] || !isAbsolute(env[key])) throw new Error(`Authority relay requires ${key}.`);
  }
  return { origin, rpcUrl, readFallbackRpcUrl: readOnlyRpcFallbackUrl(rpcUrl, env),
    journal, maxGasWei, maxGasPrice, expectedGasWallet, requireMachineReadiness:true,
    machineSourceHead: workerSourceHead,
    saleReferencePublisher:saleReferencePublisherConfiguration(env,{journal}),
    firstoExpiryKeeper:firstoExpiryKeeperConfiguration(env,{journal,expectedGasWallet}),
    salePolicyCatalogPath: env.BEMINE_SALE_POLICY_CATALOG_PATH,
    salePolicyArtifactPath: env.BEMINE_SALE_POLICY_ARTIFACT_PATH,
    nativeSaleCatalogPath: env.BEMINE_NATIVE_SALE_CATALOG_PATH,
    nativeSaleArtifactPath: env.BEMINE_NATIVE_SALE_ARTIFACT_PATH,
    genesisManifestPath: env.BEMINE_GENESIS_MANIFEST_PATH,
    targetOwnerCatalogPath: env.BEMINE_TARGET_OWNER_CATALOG_PATH,
    targetOwnerArtifactPath: env.BEMINE_TARGET_OWNER_ARTIFACT_PATH,
    trustedTargetOwnerCatalogDigest: env.BEMINE_TARGET_OWNER_CATALOG_DIGEST,
    trustedTargetOwnerArtifactDigest: env.BEMINE_TARGET_OWNER_ARTIFACT_DIGEST,
    dbPath: env.DEPLOYMENT_JOURNAL_DB, recordPath: env.BEMINE_DEPLOYMENT_RECORD_PATH,
    bundlePath: env.BEMINE_PRODUCT_GENESIS_ARTIFACT_PATH,
    activationPath: env.BEMINE_PRODUCT_ACTIVATION_PATH };
}

function authenticatedAccount(req, store) {
  const cookies = String(req.headers.cookie ?? '').split(';').map(item => item.trim());
  const token = cookies.find(item => item.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  const account = token && /^[A-Za-z0-9_-]{43}$/.test(token)
    ? store.session(createHash('sha256').update(token).digest('hex')) : null;
  if (!account) fail(401, 'Wallet session is required.');
  const selected = req.headers['x-pinkuang-account'];
  if (!selected || !same(selected, account)) fail(409, 'The selected wallet does not match the session.');
  return getAddress(account);
}

async function checkExactOperation(command, trusted, graph, readReclaimState) {
  if (command.kind !== 'executeApprovedOperation') return;
  const target = getAddress(command.args.target), data = command.args.data;
  const addresses = trusted.record.addresses;
  let iface, allowed;
  if (same(target, addresses.factory)) {
    iface = new Interface(trusted.bundle.artifacts.FreshPoolFactory.abi);
    allowed = allowedCoreCreation;
  } else if (same(target, addresses.portfolioFactory)) {
    iface = new Interface(trusted.bundle.artifacts.BudgetPortfolioFactory.abi);
    allowed = allowedBudgetCreation;
  } else {
    // The only signed pool operation exposed by this HTTP route is exact
    // reclaim for a pool registered by the active fresh Factory. In
    // particular, arm/start remain on the separate unsigned keeper route.
    let outer, inner;
    try {
      outer = POOL_MINE.parseTransaction({ data });
      if (outer?.name !== 'mine' || POOL_MINE.encodeFunctionData('mine', outer.args).toLowerCase() !== data.toLowerCase())
        fail(400, 'Only canonical mine calldata is accepted.');
      inner = MINER_RECLAIM.parseTransaction({ data: outer.args[0] });
      if (inner?.name !== 'reclaim'
        || MINER_RECLAIM.encodeFunctionData('reclaim', inner.args).toLowerCase() !== outer.args[0].toLowerCase())
        fail(400, 'Only canonical reclaim calldata is accepted.');
    } catch (error) {
      if (error.status) throw error;
      fail(400, 'Only exact signed reclaim may use the pool operation route.');
    }
    const pool = await readReclaimState(target, graph.blockNumber);
    if (!pool.registered || !same(pool.factory, graph.addresses.factory)
      || !same(pool.mining, FRESH_MINING) || !HASH.test(pool.minerKey)
      || pool.minerKey.toLowerCase() === ZERO_HASH
      || pool.minerKey.toLowerCase() !== inner.args[0].toLowerCase())
      fail(409, 'Reclaim pool registration or miner identity is not current.');
    return;
  }
  let decoded;
  try { decoded = iface.parseTransaction({ data }); }
  catch { fail(400, 'Creation calldata is not in the reviewed Factory ABI.'); }
  if (!decoded || !allowed.has(decoded.name)) fail(400, 'Unsupported creation operation.');
  if (allowed === allowedCoreCreation) {
    if (iface.encodeFunctionData(decoded.fragment, decoded.args).toLowerCase() !== data.toLowerCase())
      fail(400, 'Creation calldata is not canonical.');
    const params = decoded.args[0];
    return { factory: target, collection: params.circuits, tokenId: params.circuitId };
  }
}

async function checkAction(command, prepared, graph, trusted, readReclaimState) {
  const authority = trusted.freshAuthority.authority;
  // Only installed target/ABI checks run before the one current-state read.
  // Runtime identity is checked below from that read's vetted bytecode; older
  // activation records do not necessarily contain a saved codehash.
  if (!same(command.authority, authority.address) || !HASH.test(command.expectedCodehash ?? ''))
    fail(409, 'Authority identity differs from the reviewed deployment.');
  if (!prepared.signer || !Object.hasOwn(GAS_LIMIT, command.kind)) fail(400, 'An administrator signature is required.');
  if (command.kind === 'reviewSale' || command.kind === 'setSaleReference') {
    if (!same(command.args.market, graph.addresses.shareMarket)) fail(400, 'Sale market differs from the reviewed graph.');
  }
  if (command.kind === 'claimFees') {
    if (command.args.markets.length + command.args.pools.length > 24)
      fail(400, 'Too many fee sources in one transaction.');
  }
  return checkExactOperation(command, trusted, graph, readReclaimState);
}

/** Gas-wallet transactions are never enabled by merely serving the deployment page. */
export function createAuthorityRelayService(config, dependencies = {}) {
  if (!config) return null;
  const workerSourceHead = machineSourceHead(config.machineSourceHead);
  privatePath(config.journal);
  const trusted = dependencies.trusted ?? productGraphConfiguration({
    recordPath: config.recordPath, bundlePath: config.bundlePath,
    productActivationPath: config.activationPath, expectedGasWallet: config.expectedGasWallet,
    salePolicyCatalogPath: config.salePolicyCatalogPath, salePolicyArtifactPath: config.salePolicyArtifactPath,
    nativeSaleCatalogPath: config.nativeSaleCatalogPath, nativeSaleArtifactPath: config.nativeSaleArtifactPath,
    genesisManifestPath: config.genesisManifestPath,
    targetOwnerCatalogPath: config.targetOwnerCatalogPath, targetOwnerArtifactPath: config.targetOwnerArtifactPath,
    trustedTargetOwnerCatalogDigest: config.trustedTargetOwnerCatalogDigest,
    trustedTargetOwnerArtifactDigest: config.trustedTargetOwnerArtifactDigest,
  });
  if (!trusted?.freshAuthority || !trusted.bundle?.artifacts?.FreshPoolFactory)
    throw new Error('Authority relay requires a complete reviewed fresh activation.');
  const loadCredential = dependencies.loadCredential ?? readKeeperPrivateKey;
  // Fail startup before exposing a route if the systemd credential belongs to
  // any wallet other than the separately reviewed public Gas address.
  let credentialAddress;
  try { credentialAddress = new Wallet(loadCredential()).address; }
  catch { throw new Error('Gas credential is unavailable or invalid.'); }
  if (!same(credentialAddress, config.expectedGasWallet)
    || !same(credentialAddress, trusted.freshAuthority.authority.gasWallet))
    throw new Error('Gas credential public address differs from the reviewed Authority wallet.');
  const store = dependencies.store ?? new JournalStore(config.dbPath);
  const authenticate = dependencies.authenticateAccount ?? (req => authenticatedAccount(req, store));
  const request = new FetchRequest(config.rpcUrl);
  request.timeout = 12_000;
  request.setThrottleParams({ maxAttempts: 1 });
  // Select a healthy BSC transport once at service initialization. Every nonce,
  // receipt and broadcast stays on it; a failed send never changes the node.
  const provider = dependencies.provider ?? createDeferredRuntimeRpcProvider(request, {
    env: { BEMINE_READ_FALLBACK_RPC_URL: config.readFallbackRpcUrl }, network: 56,
    providerOptions: { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 },
    serializeReads: false,
  });
  // Background deployment/worker proofs have an independent read lane. A
  // reference scan or quota backoff must never queue ahead of a signed action.
  const backgroundProvider = dependencies.backgroundProvider ?? dependencies.provider
    ?? provider.forkReadLane({
      providerOptions: { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 },
    });
  // Machine readiness is a full historical graph proof. Keep its bounded
  // read-only calls off both the signing provider and the serial scan lane.
  const needsMachineProofProvider = config.requireMachineReadiness && !dependencies.machineReadiness;
  const ownMachineProofProvider = needsMachineProofProvider && !dependencies.machineProofProvider
    && !dependencies.backgroundProvider && !dependencies.provider;
  const machineProofProvider = needsMachineProofProvider
    ? dependencies.machineProofProvider ?? (ownMachineProofProvider
      ? provider.forkReadLane({ providerOptions: { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 },
        serializeReads: false, readOnly: true, maxConcurrentReads: 4 }) : backgroundProvider)
    : null;
  const verifyGraph = dependencies.verifyGraph ?? verifyProductGraph;
  const readReclaimState = dependencies.readReclaimState ?? (async (poolAddress, blockNumber) => {
    const overrides = blockNumber ? { blockTag: blockNumber } : {};
    const factory = new Contract(trusted.record.addresses.factory,
      ['function isPool(address pool) view returns(bool)'], provider);
    const pool = new Contract(poolAddress, [
      'function factory() view returns(address)',
      'function MINING() view returns(address)',
      'function params() view returns(tuple(address circuits,uint256 circuitId,uint256 targetRaise,uint256 priceCap,address directSeller,uint256 directPrice,uint64 fundingDeadline,uint64 purchaseDeadline))',
    ], provider);
    const [registered, owner, mining, params] = await Promise.all([
      factory.isPool(poolAddress, overrides), pool.factory(overrides),
      pool.MINING(overrides), pool.params(overrides),
    ]);
    if (!registered || !same(owner, trusted.record.addresses.factory) || !same(mining, FRESH_MINING))
      return { registered, factory: owner, mining, minerKey: ZERO_HASH };
    const key = await new Contract(mining,
      ['function minerKey(address circuits,uint256 circuitId) view returns(bytes32)'], provider)
      .minerKey(params.circuits, params.circuitId, overrides);
    return { registered, factory: owner, mining, minerKey: key };
  });
  const relay = dependencies.relay ?? runAuthorityRelay;
  const lockJournal = dependencies.lockJournal ?? acquireKeeperLock;
  const lockWallet = dependencies.lockWallet ?? acquireWalletLock;
  const readAuthorityState = dependencies.readAuthorityState ?? (async (authority, account, blockNumber) => {
    const auth = new Contract(authority, ADMIN_ABI, provider);
    const overrides = blockNumber === undefined ? {} : { blockTag: blockNumber };
    const [core, budget, first, second, gasWallet, nonce, code] = await Promise.all([
      auth.coreFactory(overrides), auth.budgetFactory(overrides), auth.administratorOne(overrides),
      auth.administratorTwo(overrides), auth.gasWallet(overrides), auth.nonces(account, overrides),
      provider.getCode(authority, blockNumber),
    ]);
    return { core, budget, first, second, gasWallet, nonce, code };
  });
  const rates = new Map(), inFlight = new Set(); let closed = false;
  // Status reconciliation can write the journal. Serialize it with submit in
  // this process so simultaneous polls do not turn the O_EXCL lock into a 503.
  // The filesystem lock still protects against a second process.
  let journalQueue = Promise.resolve(), statusTask = null, failedProofRetry = null;
  function withJournalTurn(work) {
    const turn = journalQueue.then(work);
    journalQueue = turn.catch(() => {});
    return turn;
  }
  const allowAccountRequest = createKeyedLimiter({ windowMs: 60_000, perKey: 30, maxKeys: 32 });

  async function freshGraph(readProvider = backgroundProvider) {
    if (BigInt(await readProvider.send('eth_chainId', [])) !== 56n) fail(503, 'RPC is not BSC mainnet.');
    const block = await readProvider.getBlock('latest');
    if (!block || !Number.isSafeInteger(block.number) || !HASH.test(block.hash ?? '')
      || !Number.isSafeInteger(block.timestamp)
      || Math.abs(Math.floor(Date.now() / 1000) - block.timestamp) > 90)
      fail(503, 'Current BSC block is unavailable.');
    const graph = await verifyGraph(readProvider, trusted.record.addresses.factory, trusted, block);
    if (!graph.freshAuthority || !graph.freshFactoryVerified
      || !same(graph.freshAuthority.address, trusted.freshAuthority.authority.address)
      || graph.freshAuthority.codehash.toLowerCase()
        !== (trusted.freshAuthority.authority.codehash ?? graph.freshAuthority.codehash).toLowerCase())
      fail(409, 'Fresh Authority graph is not verified and active.');
    return {...graph,blockHash:block.hash};
  }

  // A signer-only release can keep the independently reviewed worker release.
  // Without an explicit pin, readiness still requires this signer's own release.
  const machineReadiness = config.requireMachineReadiness
    ? (dependencies.machineReadiness ?? (dependencies.createMachineReadiness ?? createFreshMachineReadiness)({
      provider: machineProofProvider,verifyGraph:()=>freshGraph(machineProofProvider),sourceHead:workerSourceHead,
    })) : null;

  function rate(account) {
    const stamp = Date.now(), key = account.toLowerCase();
    const row = rates.get(key) ?? { since: stamp, count: 0 };
    if (stamp - row.since >= 60_000) { row.since = stamp; row.count = 0; }
    row.count += 1; rates.set(key, row);
    if (rates.size > 32) for (const [entry, value] of rates) if (stamp - value.since > 60_000) rates.delete(entry);
    if (row.count > 8) fail(429, 'Too many administrator relay requests.');
  }

  function status() {
    if (statusTask) return statusTask;
    const task = withJournalTurn(async () => {
      const authority = trusted.freshAuthority.authority.address;
      const release = lockJournal(config.journal);
      let releaseWallet;
      try {
        const options = { factory: authority, pool: authority, transactionTarget: authority, journal: config.journal };
        const journal = readJournal(config.journal, options);
        const result = await reconcilePending(provider, options, journal);
        const tx = journal.transaction;
        if (tx?.phase === 'reverted') {
          try {
            if (failedProofRetry?.hash === tx.hash && Date.now() < failedProofRetry.after)
              return { status: 'uncertain', hash: tx.hash, kind: tx.kind, operationId: operationId(tx),
                archived: false, recoveryRequired: true, reason: 'failure-verification-unavailable' };
            releaseWallet = lockWallet(config.expectedGasWallet, config.journal, undefined,
              { existingJournalOnly: true });
            const archived = await archiveFinalizedAuthorityFailure(provider, {
              journal: config.journal, authority,
              expectedCodehash: trusted.freshAuthority.authority.codehash,
              reviewedRuntimeMatches: code => reviewedAuthorityRuntimeMatches(trusted, code),
              expectedCoreFactory: trusted.record.addresses.factory,
              expectedBudgetFactory: trusted.record.addresses.portfolioFactory,
              expectedGasWallet: config.expectedGasWallet,
            }, journal);
            failedProofRetry = null;
            return { ...archived, status: 'failed', reason: 'transaction-reverted' };
          } catch (error) {
            failedProofRetry = { hash: tx.hash, after: Date.now() + 60_000 };
            dependencies.onError?.(error);
            return { status: 'uncertain', hash: tx.hash, kind: tx.kind, operationId: operationId(tx),
              archived: false, recoveryRequired: true, reason: 'failure-verification-unavailable' };
          }
        }
        if (!tx) return lastFailure(journal) ?? { status: 'idle', hash: null, kind: null,
          operationId: null, blockNumber: null, gasCostWei: null };
        const rawStatus = tx?.phase === 'signed' && result?.status === 'pending-not-indexed'
          ? 'broadcast-result-unknown' : result?.status ?? tx?.phase ?? 'idle';
        return { status: relayStatus(rawStatus), hash: result?.hash ?? tx?.hash ?? null,
          operationId: operationId(tx), archived: false,
          kind: tx?.kind ?? null, blockNumber: tx?.blockNumber ?? null,
          gasCostWei: tx?.gasCostWei ?? null };
      } finally { releaseWallet?.(); release(); }
    });
    statusTask = task;
    task.finally(() => { if (statusTask === task) statusTask = null; }).catch(() => {});
    return task;
  }

  async function submit(command, account) {
    if (!command || typeof command !== 'object' || Array.isArray(command)) fail(400, 'Invalid administrator command.');
    let prepared;
    try { prepared = prepareAuthorityCall(command); }
    catch { fail(400, 'Invalid or unsupported administrator action.'); }
    if (!prepared.signer || !same(prepared.signer, account)) fail(403, 'Session wallet did not sign this action.');
    // The exact ABI/target allowlist comes from the installed deployment. The
    // full historical graph and worker proofs stay off the submission path.
    const graph = { addresses: trusted.record.addresses, freshFactoryVerified: true };
    const reservation = await checkAction(command, prepared, graph, trusted, readReclaimState);
    const authority = trusted.freshAuthority.authority.address;
    return withJournalTurn(async () => {
      const releaseJournal = lockJournal(config.journal);
      let releaseWallet;
      try {
        // Check the latest state inside the serialized submit lane: the graph's
        // pinned block may predate a project that was published moments ago.
        const [verifiedAuthorityState] = await Promise.all([
          verifyCurrentAuthorityAdministrator(provider, trusted, account,
            { readState: readAuthorityState, fast: true }),
          reservation ? requireMachineAvailable(provider, { ...reservation, blockTag: 'latest' }).catch(error => {
            if (error?.code === 'MachineAlreadyReserved') fail(409, error.message);
            fail(503, 'Current machine reservation could not be verified.');
          }) : null,
        ]);
        // verifyCurrentAuthorityAdministrator has already matched the actual
        // runtime to the reviewed artifact and checked Factory bindings. Never
        // derive this proof from the browser's expectedCodehash or an optional
        // field in an activation record.
        graph.freshAuthority = { address: authority, codehash: keccak256(verifiedAuthorityState.code) };
        if (command.expectedCodehash.toLowerCase() !== graph.freshAuthority.codehash.toLowerCase())
          fail(409, 'Authority identity differs from the reviewed deployment.');
        const { gasWallet, nonce } = verifiedAuthorityState;
        if (!same(gasWallet, config.expectedGasWallet)
          || nonce !== prepared.nonce || BigInt(Math.floor(Date.now() / 1000)) > prepared.deadline)
          fail(409, 'Administrator nonce, Gas wallet or reviewed Authority graph changed.');
        const signer = new Wallet(loadCredential(), provider);
        if (!same(signer.address, gasWallet)) fail(409, 'Configured Gas credential does not match the reviewed wallet.');
        if (!existsSync(config.journal)) writeJournal(config.journal, readJournal(config.journal,
          { factory: authority, pool: authority, transactionTarget: authority }));
        const journalOptions = { factory: authority, pool: authority, transactionTarget: authority };
        const journal = readJournal(config.journal, journalOptions);
        releaseWallet = journal.transaction?.phase === 'reverted'
          ? lockWallet(signer.address, config.journal, undefined, { existingJournalOnly: true })
          : lockWallet(signer.address, config.journal);
        let previousFailure;
        if (journal.transaction?.phase === 'reverted') {
          const tx = journal.transaction;
          try {
            previousFailure = await archiveFinalizedAuthorityFailure(provider, {
              journal: config.journal, authority,
              expectedCodehash: trusted.freshAuthority.authority.codehash,
              reviewedRuntimeMatches: code => reviewedAuthorityRuntimeMatches(trusted, code),
              expectedCoreFactory: trusted.record.addresses.factory,
              expectedBudgetFactory: trusted.record.addresses.portfolioFactory,
              expectedGasWallet: config.expectedGasWallet,
            }, journal);
            failedProofRetry = null;
          } catch (error) {
            dependencies.onError?.(error);
            return { status: 'previous-operation-failed-review-required', hash: tx.hash, kind: tx.kind,
              operationId: operationId(tx), requestId: authorityOperationId(authority, prepared.data),
              accepted: false, archived: false, recoveryRequired: true,
              reason: 'failure-verification-unavailable' };
          }
        }
        const result = await relay(provider, { commandObject: command, journal: config.journal, send: true,
          maxGasWei: config.maxGasWei, maxGasPrice: config.maxGasPrice,
          gasLimit: GAS_LIMIT[command.kind], verifiedAuthorityState, fastSubmission: true }, signer);
        const current = readJournal(config.journal, journalOptions).transaction;
        const requestId = authorityOperationId(authority, prepared.data);
        const currentId = operationId(current);
        return { ...result, requestId, operationId: currentId,
          accepted: !!(result.hash && current?.hash?.toLowerCase() === result.hash.toLowerCase()
            && currentId === requestId && relayStatus(result.status) !== 'failed'),
          ...(previousFailure ? { previousFailure } : {}) };
      } finally { releaseWallet?.(); releaseJournal(); }
    });
  }

  const referencePublisher=config.saleReferencePublisher ? createSaleReferencePublisher({
    config:config.saleReferencePublisher,provider:backgroundProvider,signer:new Wallet(loadCredential(),backgroundProvider),
    factory:trusted.record.addresses.factory,portfolioFactory:trusted.record.addresses.portfolioFactory,
    market:trusted.record.addresses.shareMarket,
    verifyDeployment:freshGraph,dependencies:dependencies.referencePublisherDependencies,
  }) : null;
  const expiryKeeper = config.firstoExpiryKeeper ? createFirstoListingExpiryKeeper({
    config: config.firstoExpiryKeeper, provider:backgroundProvider, signer: new Wallet(loadCredential(), backgroundProvider),
    factory: trusted.record.addresses.factory, verifyDeployment: freshGraph,
    dependencies: dependencies.firstoExpiryKeeperDependencies,
  }) : null;

  return {
    // Private signer timer only. The public HTTP/IPC surface has no route to trigger this task.
    publishSaleReferences:()=>closed || !referencePublisher ? Promise.resolve(null) : referencePublisher.tick(),
    expireNativeFirstoListings:()=>closed || !expiryKeeper ? Promise.resolve(null) : expiryKeeper.tick(),
    // Private signer background work uses the same queue and receipt-only
    // reconciliation as status polling. It never submits an operation.
    reconcile:()=>closed ? Promise.resolve(null) : status(),
    readiness: async () => {
      if (closed || !machineReadiness) fail(503, "Fresh machine readiness is unavailable.");
      return machineReadiness();
    },
    handle(req, res) {
      const task = (async () => {
        try {
          if (closed) fail(503, 'Authority relay is unavailable.');
          if (!req.url || req.url.length > 256 || new URL(req.url, config.origin).pathname
            !== '/api/journal/authority-relay' && new URL(req.url, config.origin).pathname
            !== '/api/journal/authority-relay/status') fail(404, 'Unknown authority relay route.');
          if (req.headers.origin && req.headers.origin !== config.origin) fail(403, 'Request origin is not allowed.');
          const account = getAddress(authenticate(req));
          // Status authorizes no new action. Installed role evidence admits
          // only administrators without spending seven RPC reads every poll.
          // Every POST still reads current roles and nonce once before send.
          if (req.method === 'GET' && ![trusted.freshAuthority.authority.administratorOne,
            trusted.freshAuthority.authority.administratorTwo].some(value => same(account, value)))
            fail(403, 'Administrator wallet is required.');
          if (!allowAccountRequest(account.toLowerCase())) fail(429, 'Too many authority relay requests.');
          if (req.method === 'GET' && req.url === '/api/journal/authority-relay/status')
            return json(res, 200, await status());
          if (req.method !== 'POST' || req.url !== '/api/journal/authority-relay') fail(405, 'Method is not allowed.');
          if (req.headers.origin !== config.origin) fail(403, 'Exact request origin is required.');
          rate(account);
          const body = await readBody(req);
          const result = await submit(body.command, account);
          return json(res, 200, { status: relayStatus(result.status), hash: result.hash ?? null,
            kind: result.kind ?? body.command?.kind ?? null, message: result.message ?? null,
            requestId: result.requestId, operationId: result.operationId, accepted: result.accepted === true,
            ...(result.previousFailure ? { previousFailure: result.previousFailure } : {}),
            ...(result.reason ? { reason: result.reason } : {}),
            ...(result.recoveryRequired !== undefined ? { recoveryRequired: result.recoveryRequired } : {}),
            ...(result.archived !== undefined ? { archived: result.archived } : {}) });
        } catch (error) {
          dependencies.onError?.(error);
          // Never reflect RPC errors, calldata, signatures or private-key material.
          const statusCode = Number.isInteger(error.status) ? error.status : 503;
          json(res, statusCode, { error: Number.isInteger(error.status)
            ? error.message : 'Authority relay could not verify or submit the action. Check its status before retrying.' });
        }
      })();
      inFlight.add(task);
      task.finally(() => inFlight.delete(task)).catch(() => {});
    },
    async close() {
      closed = true;
      await expiryKeeper?.close();
      await referencePublisher?.close();
      await Promise.allSettled([...inFlight]);
      await journalQueue;
      if (ownMachineProofProvider) await machineProofProvider.settleAndDestroy();
      store.close();
      if (!dependencies.provider) provider.destroy();
      if (!dependencies.backgroundProvider && !dependencies.provider) backgroundProvider.destroy();
    },
  };
}
