import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Wallet, getCreateAddress, keccak256 } from 'ethers';
import { createJournalService, journalConfiguration } from './journal-api.mjs';
import { FRESH_ADMIN_ONE, FRESH_ADMIN_TWO } from './fresh-activation-journal.mjs';
import { createDeploymentServer } from './index.mjs';
import { gasSignerAttestationMessage } from '../shared/gas-signer-attestation.mjs';

const origin = 'http://127.0.0.1:4173';
const hex = n => `0x${n.toString(16).padStart(64, '0')}`;
const wallet = Wallet.createRandom(), other = Wallet.createRandom();
const account = wallet.address.toLowerCase(), market = Wallet.createRandom().address.toLowerCase();
const factory = Wallet.createRandom().address.toLowerCase();
const deploymentAccount = '0x042B23288E2316DFb6503488292FD0Ad2F811Ae7'.toLowerCase();

function deployment(owner = account, id = 'first') {
  return { schemaVersion: 1, id, chainId: 56, account: owner, sourceCommit: 'a'.repeat(40),
    artifactDigest: hex(5), input: { ownerMultisig: owner, operator: owner, treasury: owner,
      governanceMode: 'single', maxGasBudgetBnb: '0.05', gasPriceCapGwei: '1', governanceReviewed: true, protocolReviewed: true },
    status: 'ready', steps: [{ id: 'PoolVault', status: 'waiting' }], addresses: {}, spentWei: '0', preflight: {} };
}

test('only the server nonce witness can release the exact unbroadcast initialization envelope', async () => {
  let pending = 8;
  const provider = {
    send: async () => '0x38',
    getTransactionCount: async (_owner, tag) => tag === 'latest' ? 7 : pending,
  };
  const f = await fixture(provider);
  try {
    const { cookie } = await f.login(wallet);
    const initial = deployment();
    initial.steps = [{ id: 'initialize', status: 'waiting' }];
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: initial, expectedRevision: 0 }, cookie)).status, 200);
    const signing = structuredClone(initial);
    signing.status = 'paused';
    signing.steps[0] = { id: 'initialize', status: 'signing', nonce: 7, dataHash: hex(77) };
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: signing, expectedRevision: 1 }, cookie)).status, 200);
    const uncertain = structuredClone(signing);
    uncertain.steps[0].status = 'uncertain';
    uncertain.steps[0].error = 'Invalid transaction envelope type: specified type "0x4" but included a gasPrice instead of maxFeePerGas and maxPriorityFeePerGas';
    uncertain.error = uncertain.steps[0].error;
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: uncertain, expectedRevision: 2 }, cookie)).status, 200);
    const forged = structuredClone(uncertain);
    forged.steps[0].status = 'rejected';
    forged.steps[0].rejectionKind = 'pre-send';
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: forged, expectedRevision: 3 }, cookie)).status, 409);
    const request = () => f.request('/api/journal/deployment/release-invalid-envelope', 'POST',
      { expectedRevision: 3, nonce: 7 }, cookie);
    assert.equal((await request()).status, 409, 'a pending nonce cannot be released');
    pending = 7;
    const released = await request();
    assert.equal(released.status, 200);
    assert.equal(released.body.record.steps[0].status, 'rejected');
    assert.equal(released.body.record.steps[0].rejectionKind, 'pre-send');
    assert.equal(released.body.record.steps[0].nonce, 7);
    assert.equal((await request()).status, 409, 'the same recovery cannot be replayed');
  } finally { await f.close(); }
});
function intent(owner = account) {
  return { version: 1, chainId: 56, account: owner, factory, market, nonce: 7, action: { kind: 'withdraw' },
    data: '0x12345678', value: '0', submittedAt: '2026-09-26T00:00:00.000Z' };
}
function chainProof(owner = account, original = intent(owner), hash = hex(77)) {
  const blockHash = hex(100), finalHash = hex(101);
  const tx = { hash, chainId: 56n, from: owner, nonce: 7, blockNumber: 100, blockHash,
    to: market, data: original.data, value: 0n };
  const receipt = { hash, from: owner, to: market, blockNumber: 100, blockHash, status: 1 };
  return { send: async () => '0x38', getTransaction: async () => tx,
    getTransactionReceipt: async () => receipt,
    getBlock: async id => id === 'latest' ? { number: 102, hash: hex(102) }
      : id === 'finalized' || id === 101 ? { number: 101, hash: finalHash }
        : id === 100 ? { number: 100, hash: blockHash } : null,
    getTransactionCount: async () => 8 };
}

function completedProof(owner = account, id = 'completed') {
  const ids = ['FlexiblePurchase','MiningOperations','PoolFunds','PurchaseValidation',
    'RewardAccounting','SaleGovernance','SaleSettlement','ShareCheckpoints',
    'AtomicDeployment','PoolVault','PoolFactory','ShareMarket','initialize'];
  const record = deployment(owner, id);
  const transactions = new Map(), receipts = new Map(), blockHashes = new Map();
  const fee = 21_000n * 1_000_000_000n;
  const code = {};
  record.status = 'complete'; record.steps = []; record.addresses = {};
  for (const [index, stepId] of ids.entries()) {
    const nonce = 10 + index, blockNumber = 100 + index;
    const hash = hex(1000 + index), blockHash = hex(2000 + index);
    const data = `0x60${(index + 1).toString(16).padStart(2, '0')}`;
    const contractAddress = stepId === 'initialize' ? null : getCreateAddress({ from: owner, nonce });
    const to = stepId === 'initialize' ? record.addresses.AtomicDeployment : null;
    const receipt = { hash, from: owner, to, blockNumber, blockHash, index: 0, status: 1,
      contractAddress, gasUsed: 21_000n, gasPrice: 1_000_000_000n, fee };
    transactions.set(hash, { hash, chainId: 56n, from: owner, nonce, blockNumber, blockHash, index: 0,
      to, data, value: 0n });
    receipts.set(hash, receipt);
    blockHashes.set(blockNumber, blockHash);
    record.steps.push({ id: stepId, status: 'confirmed', nonce, txHash: hash,
      dataHash: keccak256(data), receipt: { blockNumber, blockHash, status: 1,
        gasUsed: receipt.gasUsed.toString(), gasPrice: receipt.gasPrice.toString(), feeWei: fee.toString() },
      ...(contractAddress ? { address: contractAddress, codehash: hex(3000 + index) } : {}) });
    if (contractAddress) {
      record.addresses[stepId] = contractAddress;
      code[stepId] = { address: contractAddress, codehash: hex(3000 + index) };
    }
  }
  record.spentWei = (fee * BigInt(ids.length)).toString();
  record.verification = { checks: [{ label: 'graph', passed: true }], code };
  const provider = {
    send: async () => '0x38',
    getTransaction: async hash => transactions.get(hash) ?? null,
    getTransactionReceipt: async hash => receipts.get(hash) ?? null,
    getBlock: async tag => tag === 'latest' ? { number: 121, hash: hex(2121) }
      : tag === 'finalized' || tag === 120 ? { number: 120, hash: hex(2120) }
        : blockHashes.has(tag) ? { number: tag, hash: blockHashes.get(tag),
          transactions: [...transactions.values()].filter(tx => tx.blockNumber === tag).map(tx => tx.hash) } : null,
    getTransactionCount: async () => 23,
  };
  return { record, provider, transactions, receipts, blockHashes };
}

async function fixture(provider = chainProof(), currentArtifactDigest = () => hex(5),
  assertSigningInputsCurrent = () => {}, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pinkuang-journal-'));
  const dbPath = join(directory, 'private', 'journal.sqlite');
  const service = createJournalService({ dbPath, origin, provider, currentArtifactDigest,
    assertSigningInputsCurrent, ...options });
  const server = options.fullServer ? createDeploymentServer({ journalService: service })
    : createServer((req, res) => service.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = 'GET', body, cookie, requestOrigin = origin, extraHeaders = {}) => {
    const response = await fetch(`${base}${path}`, { method,
      headers: { ...(method === 'GET' ? {} : { Origin: requestOrigin, 'Content-Type': 'application/json' }),
        ...(path.startsWith('/api/journal/fresh-activation') ? {'X-Pinkuang-Activation-Protocol':'2'} : {}),
        ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
  };
  const login = async signer => {
    const challenge = await request('/api/journal/challenge', 'POST', { account: signer.address });
    assert.equal(challenge.status, 200);
    const signature = await signer.signMessage(challenge.body.message);
    const session = await request('/api/journal/session', 'POST', { account: signer.address, nonce: challenge.body.nonce, signature });
    assert.equal(session.status, 200);
    return { cookie: session.cookie.split(';')[0], challenge, signature };
  };
  // Tests cannot hold the deployment hardware wallet's private key. Seed only
  // the server-side session row to exercise authorization after wallet login.
  const sessionFor = address => {
    const token = randomBytes(32).toString('base64url');
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare('INSERT INTO sessions(token_hash,account,expires) VALUES(?,?,?)')
        .run(createHash('sha256').update(token).digest('hex'), address.toLowerCase(), Date.now() + 60_000);
    } finally { db.close(); }
    return `pinkuang_journal=${token}`;
  };
  return { directory, dbPath, service, server, request, login, sessionFor,
    async close() { await new Promise(resolve => server.close(resolve)); await service.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('pre-genesis console keeps deployment journals but rejects every product write', async () => {
  assert.equal(journalConfiguration({ BEMINE_FRESH_CONSOLE_PRE_GENESIS: '1' }).freshConsolePreGenesis, true);
  assert.equal(journalConfiguration({ BEMINE_FRESH_CONSOLE_PRE_GENESIS: '0' }).freshConsolePreGenesis, false);
  assert.equal(journalConfiguration({ BEMINE_FRESH_STAGE2_HOLD: '1' }).freshStage2Hold, true);
  assert.equal(journalConfiguration({}).freshStage2Hold, true);
  assert.equal(journalConfiguration({ BEMINE_FRESH_STAGE2_HOLD: '0' }).freshStage2Hold, false);
  assert.throws(() => journalConfiguration({ BEMINE_FRESH_CONSOLE_PRE_GENESIS: 'true' }),
    /BEMINE_FRESH_CONSOLE_PRE_GENESIS/);
  assert.throws(() => journalConfiguration({ BEMINE_FRESH_STAGE2_HOLD: 'true' }),
    /BEMINE_FRESH_STAGE2_HOLD/);
  const f = await fixture(chainProof(), () => hex(5), () => {},
    { freshConsolePreGenesis: true });
  try {
    const cookie = f.sessionFor(deploymentAccount);
    const initial = deployment(deploymentAccount);
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: initial, expectedRevision: 0 }, cookie)).status, 200);
    assert.equal((await f.request('/api/journal/deployment', 'GET', undefined, cookie)).body.record.id,
      initial.id);
    assert.equal((await f.request('/api/journal/fresh-activation/config', 'GET', undefined, cookie)).status, 200);
    const held = await f.request('/api/journal/fresh-activation', 'PUT',
      { record: {}, expectedRevision: 0 }, cookie);
    assert.equal(held.status, 409);
    assert.match(held.body.error, /Stage 2 signing is held/);
    const heldRecovery = await f.request('/api/journal/fresh-activation/release-unused-signing', 'POST',
      { expectedRevision: 0, stepId: 'deployAuthority', nonce: 8, dataHash: hex(8) }, cookie);
    assert.equal(heldRecovery.status, 409);
    assert.match(heldRecovery.body.error, /Stage 2 signing is held/);
    assert.equal((await f.request('/api/journal/fresh-activation', 'GET', undefined, cookie)).body.record, null);
    for (const [path, method, body] of [
      ['/api/journal/market', 'PUT', { record: intent(), expectedRevision: 0 }],
      ['/api/journal/market', 'DELETE', { expectedRevision: 0, hash: hex(77) }],
      ['/api/journal/market/prepare-and-arm', 'POST', {}],
      ['/api/journal/market/arm', 'POST', {}],
      ['/api/journal/market/cancel-intent', 'POST', {}],
      ['/api/journal/market/abandon', 'POST', {}],
      ['/api/journal/quote', 'POST', { record: { name: 'old quote' } }],
      ['/api/journal/budget-queue?parent=' + factory, 'PUT', { record: {}, expectedRevision: 0 }],
      ['/api/journal/deployment/import-archive', 'POST', { record: initial }],
    ]) {
      const result = await f.request(path, method, body, cookie);
      assert.equal(result.status, 409, `${method} ${path} must remain closed`);
      assert.match(result.body.error, /pre-genesis/);
    }
    assert.equal((await f.request('/api/journal/market', 'GET', undefined, cookie)).body.record, null);
    assert.deepEqual((await f.request('/api/journal/quotes', 'GET', undefined, cookie)).body.items, []);
  } finally { await f.close(); }
  const legacy = await fixture();
  try {
    const { cookie } = await legacy.login(wallet);
    assert.equal((await legacy.request('/api/journal/market', 'PUT',
      { record: intent(), expectedRevision: 0 }, cookie)).status, 200,
    'existing v2/v3 behavior is unchanged without the explicit flag');
  } finally { await legacy.close(); }
});

test('fresh activation reports only a Gas public address derived from the reviewed credential', async () => {
  const expected=Wallet.createRandom().address;
  const f=await fixture(chainProof(),()=>hex(5),()=>{},
    {expectedGasWallet:expected,gasWalletAddressReader:()=>expected,freshStage2Hold:false});
  try {
    const session=await f.login(wallet);
    const config=await f.request('/api/journal/fresh-activation/config','GET',undefined,session.cookie);
    assert.deepEqual(config.body,{credentialVerified:true,gasWallet:expected,stage2Held:false});
    const missing=await f.request('/api/journal/fresh-activation','PUT',
      {record:{},expectedRevision:0},session.cookie);
    assert.equal(missing.status,400,'valid credential still requires a complete Stage2 record');
  } finally {await f.close();}
  const mismatch=await fixture(chainProof(),()=>hex(5),()=>{},
    {expectedGasWallet:expected,gasWalletAddressReader:()=>Wallet.createRandom().address,freshStage2Hold:false});
  try {
    const session=await mismatch.login(wallet);
    const config=await mismatch.request('/api/journal/fresh-activation/config','GET',undefined,session.cookie);
    assert.deepEqual(config.body,{credentialVerified:false,gasWallet:null,stage2Held:false});
    const denied=await mismatch.request('/api/journal/fresh-activation','PUT',
      {record:{},expectedRevision:0},session.cookie);
    assert.equal(denied.status,503);
  } finally {await mismatch.close();}
});

test('public deployment console never treats its configured Gas address as a verified signer', async () => {
  const expected=Wallet.createRandom().address;
  const f=await fixture(chainProof(),()=>hex(5),()=>{},
    {expectedGasWallet:expected,freshConsolePreGenesis:true,freshStage2Hold:false});
  try {
    const cookie=f.sessionFor(deploymentAccount);
    const config=await f.request('/api/journal/fresh-activation/config','GET',undefined,cookie);
    assert.deepEqual(config.body,{credentialVerified:false,gasWallet:expected,stage2Held:false});
    const denied=await f.request('/api/journal/fresh-activation','PUT',
      {record:{},expectedRevision:0},cookie);
    assert.equal(denied.status,503);
  } finally {await f.close();}
});

test('the actual deployment HTTP server accepts only a fresh isolated signer proof for the completed genesis', async () => {
  const gas = Wallet.createRandom();
  let signer = gas;
  let challengeSeen = false;
  const f = await fixture(chainProof(), () => hex(5), () => {}, {
    fullServer: true, freshConsolePreGenesis: true, freshStage2Hold: false, expectedGasWallet: gas.address,
    gasWalletProofReader: async challenge => {
      challengeSeen = true;
      return { gasWallet: gas.address,
        signature: await signer.signMessage(gasSignerAttestationMessage(challenge)) };
    },
  });
  try {
    const genesis = completedProof(deploymentAccount).record;
    genesis.kind = 'integrated-v2';
    const db = new DatabaseSync(f.dbPath);
    try { db.prepare('INSERT INTO deployment(account,revision,record) VALUES(?,?,?)')
      .run(deploymentAccount, 1, JSON.stringify(genesis)); }
    finally { db.close(); }
    const cookie = f.sessionFor(deploymentAccount);
    assert.equal((await f.request('/api/journal/deployment', 'GET', undefined, cookie)).body.record?.status, 'complete');
    const status = await f.request('/api/journal/fresh-activation/config', 'GET', undefined, cookie);
    assert.equal(challengeSeen, true, 'a completed deployment must reach the isolated proof reader');
    assert.deepEqual(status.body, { credentialVerified: true, gasWallet: gas.address, stage2Held: false });
    assert.equal((await f.request('/api/journal/fresh-activation', 'PUT',
      { record: {}, expectedRevision: 0 }, cookie)).status, 400,
    'the independent proof passes the credential gate but cannot bypass record validation');
    signer = Wallet.createRandom();
    const changed = await f.request('/api/journal/fresh-activation/config', 'GET', undefined, cookie);
    assert.deepEqual(changed.body, { credentialVerified: false, gasWallet: gas.address, stage2Held: false });
    assert.equal((await f.request('/api/journal/fresh-activation', 'PUT',
      { record: {}, expectedRevision: 0 }, cookie)).status, 503);
  } finally { await f.close(); }
});

test('pre-genesis journal writes require the fixed deployment wallet, including with EIP-7702 code', async () => {
  const gasWallet = Wallet.createRandom();
  const delegatedProvider = { ...chainProof(deploymentAccount),
    getCode: async address => address.toLowerCase() === deploymentAccount
      ? `0xef0100${'11'.repeat(20)}` : '0x' };
  const f = await fixture(delegatedProvider, () => hex(5), () => {},
    { freshConsolePreGenesis: true, freshStage2Hold: true, expectedGasWallet: gasWallet.address });
  try {
    assert.equal((await f.request('/api/journal/fresh-activation/config', 'GET', undefined,
      f.sessionFor(deploymentAccount))).body.stage2Held, true);
    const publicRead = await f.request('/api/journal/product-graph');
    assert.equal(publicRead.status, 503, 'public product-graph reads do not require a wallet session');
    const { cookie: gasCookie } = await f.login(gasWallet);
    assert.equal((await f.request('/api/journal/session', 'GET', undefined, gasCookie)).status, 200,
      'Stage 1 login remains available to a non-deployer');
    const ownerCookie = f.sessionFor(deploymentAccount);
    const initial = deployment(deploymentAccount);
    const saved = await f.request('/api/journal/deployment', 'PUT',
      { record: initial, expectedRevision: 0 }, ownerCookie);
    assert.equal(saved.status, 200, 'the designated wallet may write despite EIP-7702 delegated code');
    assert.equal((await f.request('/api/journal/deployment', 'GET', undefined, ownerCookie)).body.record.id,
      initial.id);
    for (const [name, cookie] of [
      ['Gas wallet', gasCookie],
      ['administrator one', f.sessionFor(FRESH_ADMIN_ONE)],
      ['administrator two', f.sessionFor(FRESH_ADMIN_TWO)],
      ['unrelated wallet', (await f.login(wallet)).cookie],
    ]) {
      assert.equal((await f.request('/api/journal/deployment', 'GET', undefined, cookie)).status, 200,
        `${name} can read their own journal`);
      for (const [path, method, body] of [
        ['/api/journal/deployment', 'PUT', { record: deployment(), expectedRevision: 0 }],
        ['/api/journal/deployment/archive', 'POST', { id: 'first', expectedRevision: 0 }],
        ['/api/journal/fresh-activation', 'PUT', { record: {}, expectedRevision: 0 }],
      ]) {
        const denied = await f.request(path, method, body, cookie);
        assert.equal(denied.status, 403, `${name} must not ${method} ${path}`);
        assert.match(denied.body.error, /designated v4 deployment wallet/);
      }
    }
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: deployment(), expectedRevision: 0 }, gasCookie, origin,
      { 'x-pinkuang-account': deploymentAccount })).status, 409,
    'a selected-account header cannot turn a Gas-wallet session into the deployer');
  } finally { await f.close(); }
});

test('journal API permits only documented no-send rejection and same-intent manual retry', async () => {
  const gasWallet = Wallet.createRandom().address;
  let stagePending = 9;
  const proof = { ...chainProof(),
    getTransactionCount: async (_owner, tag) => tag === 'pending' ? stagePending : 8 };
  const f = await fixture(proof, () => hex(5), () => {},
    { expectedGasWallet: gasWallet, gasWalletAddressReader: () => gasWallet, freshStage2Hold: false });
  try {
    const { cookie } = await f.login(wallet);
    const core = deployment();
    let revision = 0;
    const putDeployment = async record => {
      const result = await f.request('/api/journal/deployment', 'PUT', { record, expectedRevision: revision }, cookie);
      if (result.status === 200) revision = result.body.revision;
      return result;
    };
    assert.equal((await putDeployment(core)).status, 200);
    const signing = structuredClone(core);
    signing.status = 'paused';
    signing.steps[0] = { id: 'PoolVault', status: 'signing', nonce: 7, dataHash: hex(77) };
    assert.equal((await putDeployment(signing)).status, 200);
    const erased = structuredClone(signing); erased.steps[0].status = 'waiting';
    assert.equal((await putDeployment(erased)).status, 409);
    const undocumented = structuredClone(signing); undocumented.steps[0].status = 'rejected';
    assert.equal((await putDeployment(undocumented)).status, 409);
    const rejected = structuredClone(undocumented); rejected.steps[0].rejectionKind = 'wallet-rejected';
    assert.equal((await putDeployment(rejected)).status, 200);
    assert.equal((await putDeployment(signing)).status, 200, 'same nonce and payload can be retried explicitly');
    const uncertain = structuredClone(signing); uncertain.steps[0].status = 'uncertain';
    assert.equal((await putDeployment(uncertain)).status, 200);
    assert.equal((await putDeployment(rejected)).status, 409, 'ambiguous send cannot claim a definite rejection');
    assert.equal((await f.request('/api/journal/deployment', 'GET', undefined, cookie)).body.record.steps[0].status,
      'uncertain');

    const genesis = deployment(account, 'fresh-graph');
    genesis.kind = 'integrated-v2'; genesis.status = 'complete';
    const factoryAddress = Wallet.createRandom().address, portfolioFactory = Wallet.createRandom().address;
    const timelock = Wallet.createRandom().address, shareMarket = Wallet.createRandom().address;
    const portfolioMarket = Wallet.createRandom().address;
    genesis.addresses = { factory: factoryAddress, portfolioFactory, timelock, shareMarket, portfolioShareMarket: portfolioMarket };
    genesis.verification = { code: Object.fromEntries([
      ['factory',hex(1)], ['portfolioFactory',hex(2)], ['shareMarket',hex(3)],
      ['portfolioShareMarket',hex(4)], ['timelock',hex(5)],
    ].map(([name,codehash]) => [name,{codehash}])) };
    // A fresh graph occupies a distinct hardware wallet's single deployment slot.
    const freshWallet = Wallet.createRandom(), freshAccount = freshWallet.address.toLowerCase();
    genesis.account = freshAccount;
    genesis.input.ownerMultisig = genesis.input.operator = genesis.input.treasury = freshAccount;
    const freshSession = await f.login(freshWallet);
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: genesis, expectedRevision: 0 }, freshSession.cookie)).status, 200);
    const ids = ['deployAuthority','coreOperator','coreTreasury','budgetOperator',
      'budgetTreasury','coreOwner','budgetOwner'];
    const stage = { schemaVersion: 1, kind: 'fresh-authority', chainId: 56,
      account: freshAccount, deploymentId: genesis.id, genesisArtifactDigest: genesis.artifactDigest,
      genesis: { factory: factoryAddress, portfolioFactory, timelock, shareMarket, portfolioMarket,
        codehash: { factory:hex(1),portfolioFactory:hex(2),shareMarket:hex(3),portfolioMarket:hex(4),timelock:hex(5) } },
      administratorOne: '0x7674fa446D42b1f7f150DC5e678cc525d275Ea53',
      administratorTwo: '0xed2fcbe59ebe1754a3676aeb9ccfba20f193fcbb', gasWallet,
      createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z',
      maxGasBudgetBnb: '0.05', gasPriceCapGwei: '3', spentWei: '0', status: 'ready',
      steps: ids.map(id => ({ id, status: 'waiting' })) };
    let stageRevision = 0;
    const putStage = async record => {
      const result = await f.request('/api/journal/fresh-activation', 'PUT',
        { record, expectedRevision: stageRevision }, freshSession.cookie);
      if (result.status === 200) stageRevision = result.body.revision;
      return result;
    };
    assert.equal((await putStage(stage)).status, 200);
    const stageSigning = structuredClone(stage);
    stageSigning.status = 'paused';
    stageSigning.steps[0] = { id: ids[0], status: 'signing', nonce: 8, dataHash: hex(88),
      gasLimit: '4000000', gasPriceWei: '1000000000', maxFeeWei: '4000000000000000' };
    assert.equal((await putStage(stageSigning)).status, 200);
    const forgedRelease = structuredClone(stageSigning);
    forgedRelease.steps[0].status = 'rejected';
    forgedRelease.steps[0].rejectionKind = 'nonce-witnessed';
    assert.equal((await putStage(forgedRelease)).status, 409,
      'ordinary journal PUT cannot claim a nonce-witnessed recovery');
    const recover = () => f.request('/api/journal/fresh-activation/release-unused-signing', 'POST',
      { expectedRevision: stageRevision, stepId: ids[0], nonce: 8, dataHash: hex(88) }, freshSession.cookie);
    assert.equal((await recover()).status, 409, 'a pending nonce cannot be released');
    stagePending = 8;
    const released = await recover();
    assert.equal(released.status, 200);
    stageRevision = released.body.revision;
    assert.equal(released.body.record.steps[0].status, 'rejected');
    assert.equal(released.body.record.steps[0].rejectionKind, 'nonce-witnessed');
    assert.equal(released.body.record.steps[0].nonce, 8);
    assert.equal(released.body.record.steps[0].dataHash, hex(88));
    assert.equal((await recover()).status, 409, 'the release is single-use');
    const alteredRetry = structuredClone(stageSigning);
    alteredRetry.steps[0].gasPriceWei = '2000000000';
    alteredRetry.steps[0].maxFeeWei = '8000000000000000';
    assert.equal((await putStage(alteredRetry)).status, 409, 'recovery pins the original gas fields');
    assert.equal((await putStage(stageSigning)).status, 200, 'only a same-intent manual retry is accepted');
    const stageRejected = structuredClone(stageSigning);
    stageRejected.steps[0].status = 'rejected'; stageRejected.steps[0].rejectionKind = 'pre-send';
    assert.equal((await putStage(stageRejected)).status, 200);
    const changed = structuredClone(stageSigning); changed.steps[0].nonce = 9;
    assert.equal((await putStage(changed)).status, 409);
    assert.equal((await putStage(stageSigning)).status, 200);
    const stageUncertain = structuredClone(stageSigning); stageUncertain.steps[0].status = 'uncertain';
    assert.equal((await putStage(stageUncertain)).status, 200);
    assert.equal((await putStage(stageRejected)).status, 409);
  } finally { await f.close(); }
});

test('fresh genesis cannot be archived without losing its activation recovery anchor', async () => {
  const f=await fixture();
  try {
    const {cookie}=await f.login(wallet);
    const fresh=deployment(account,'fresh-genesis');
    fresh.kind='integrated-v2'; fresh.status='complete';
    fresh.steps=[{id:'FreshPoolFactory',status:'confirmed'}];
    assert.equal((await f.request('/api/journal/deployment','PUT',
      {record:fresh,expectedRevision:0},cookie)).status,200);
    const archive=await f.request('/api/journal/deployment/archive','POST',
      {id:fresh.id,expectedRevision:1},cookie);
    assert.equal(archive.status,409);
    assert.match(archive.body.error,/Fresh genesis/);
    const saved=await f.request('/api/journal/deployment','GET',undefined,cookie);
    assert.equal(saved.body.record.id,fresh.id);
    assert.equal(saved.body.revision,1);
  } finally {await f.close();}
});

test('wallet challenge is one-use, origin-bound and sessions are wallet-isolated', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/journal/session')).status, 401);
    assert.equal((await f.request('/api/journal/challenge', 'POST', { account }, null, 'https://wrong.example')).status, 403);
    const a = await f.login(wallet), b = await f.login(other);
    assert.match(a.cookie, /pinkuang_journal=/);
    assert.match(a.cookie, /./);
    assert.equal((await f.request('/api/journal/session', 'POST',
      { account, nonce: a.challenge.body.nonce, signature: a.signature })).status, 401);
    assert.equal((await f.request('/api/journal/session', 'GET', undefined, a.cookie)).body.account, account);
    assert.equal((await f.request('/api/journal/session', 'GET', undefined, b.cookie)).body.account, other.address.toLowerCase());
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: deployment(account), expectedRevision: 0 }, b.cookie)).status, 400);
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: deployment(account), expectedRevision: 0 }, a.cookie)).body.revision, 1);
    assert.equal((await f.request('/api/journal/deployment', 'GET', undefined, b.cookie)).body.record, null);
    assert.equal((await f.request('/api/journal/deployment', 'GET', undefined, b.cookie, origin,
      { 'X-Pinkuang-Account': account })).status, 409);
    assert.equal((await f.request('/api/journal/quote', 'POST', { record: { marker: 'wrong-wallet' } }, b.cookie, origin,
      { 'X-Pinkuang-Account': account })).status, 409);
    assert.deepEqual((await f.request('/api/journal/quotes', 'GET', undefined, b.cookie)).body.items, []);
  } finally { await f.close(); }
});

test('nonce witness is authenticated, wallet-bound and never changes unresolved deployment or market intents', async () => {
  const reads = [];
  const provider = {
    send: async (method, params) => { reads.push([method, params]); return '0x38'; },
    getTransactionCount: async (owner, tag) => { reads.push([owner, tag]); return tag === 'latest' ? 7 : 8; },
  };
  const f = await fixture(provider);
  try {
    assert.equal((await f.request('/api/journal/deployment/nonce')).status, 401);
    assert.deepEqual(reads, []);
    const a = await f.login(wallet), b = await f.login(other);
    assert.equal((await f.request('/api/journal/deployment/nonce', 'GET', undefined, b.cookie, origin,
      { 'X-Pinkuang-Account': account })).status, 409);
    assert.equal((await f.request(`/api/journal/deployment/nonce?account=${other.address}`, 'GET', undefined, a.cookie)).status, 400);
    assert.deepEqual(reads, []);
    const start = deployment();
    assert.equal((await f.request('/api/journal/deployment', 'PUT', { record: start, expectedRevision: 0 }, a.cookie)).status, 200);
    const unresolved = structuredClone(start);
    unresolved.status = 'paused';
    unresolved.steps[0] = { id: 'PoolVault', status: 'uncertain', nonce: 7, dataHash: hex(21) };
    assert.equal((await f.request('/api/journal/deployment', 'PUT', { record: unresolved, expectedRevision: 1 }, a.cookie)).status, 200);
    // An unresolved deployment now owns the wallet signing lane.
    assert.equal((await f.request('/api/journal/market', 'PUT', { record: intent(), expectedRevision: 0 }, a.cookie)).status, 409);
    const before = (await f.request('/api/journal/deployment', 'GET', undefined, a.cookie)).body;
    const marketBefore = (await f.request('/api/journal/market', 'GET', undefined, a.cookie)).body;
    const result = await f.request('/api/journal/deployment/nonce', 'GET', undefined, a.cookie, origin,
      { 'X-Pinkuang-Account': account });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { latest: 7, pending: 8 });
    assert.deepEqual(reads, [['eth_chainId', []], [account, 'latest'], [account, 'pending'], ['eth_chainId', []]]);
    assert.deepEqual((await f.request('/api/journal/deployment', 'GET', undefined, a.cookie)).body, before);
    assert.deepEqual((await f.request('/api/journal/market', 'GET', undefined, a.cookie)).body, marketBefore);
    reads.length = 0;
    assert.equal((await f.request('/api/journal/deployment/nonce', 'GET', undefined, b.cookie)).status, 200);
    assert.deepEqual(reads.filter(([, tag]) => typeof tag === 'string'),
      [[other.address.toLowerCase(), 'latest'], [other.address.toLowerCase(), 'pending']]);
  } finally { await f.close(); }
});

test('nonce witness fails closed on wrong or changing networks, malformed counters and RPC failures', async () => {
  let network = '0x38', latest = 7, pending = 7, failRpc = false, networkReads = 0, changeNetwork = false;
  const provider = {
    send: async () => {
      networkReads += 1;
      return changeNetwork && networkReads === 2 ? '0x1' : network;
    },
    getTransactionCount: async (_owner, tag) => {
      if (failRpc) throw new Error('private RPC credential must not leak');
      return tag === 'latest' ? latest : pending;
    },
  };
  const f = await fixture(provider);
  try {
    const { cookie } = await f.login(wallet);
    const before = (await f.request('/api/journal/deployment', 'GET', undefined, cookie)).body;
    for (const badNetwork of ['0x1', '56', 56, null, '0xzz']) {
      network = badNetwork;
      const result = await f.request('/api/journal/deployment/nonce', 'GET', undefined, cookie);
      assert.equal(result.status, 503);
      assert.match(result.body.error, /BSC/);
    }
    network = '0x38'; changeNetwork = true; networkReads = 0;
    assert.equal((await f.request('/api/journal/deployment/nonce', 'GET', undefined, cookie)).status, 503);
    changeNetwork = false;
    for (const [badLatest, badPending] of [[-1, 7], [7, -1], [7.5, 8], [7, 7.5],
      [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1], [0, Number.MAX_SAFE_INTEGER + 1],
      [null, 7], [7, undefined], ['7', 7], [7, '7'], [NaN, 7], [7, Infinity], [8, 7]]) {
      latest = badLatest; pending = badPending;
      assert.equal((await f.request('/api/journal/deployment/nonce', 'GET', undefined, cookie)).status, 503);
    }
    latest = pending = 0;
    assert.deepEqual((await f.request('/api/journal/deployment/nonce', 'GET', undefined, cookie)).body, { latest: 0, pending: 0 });
    failRpc = true;
    const failed = await f.request('/api/journal/deployment/nonce', 'GET', undefined, cookie);
    assert.equal(failed.status, 503);
    assert.doesNotMatch(failed.body.error, /private RPC credential/);
    assert.deepEqual((await f.request('/api/journal/deployment', 'GET', undefined, cookie)).body, before);
  } finally { await f.close(); }
});

test('nonce witness returns an actionable 503 when server RPC is not configured', async () => {
  const f = await fixture(null);
  try {
    const { cookie } = await f.login(wallet);
    const result = await f.request('/api/journal/deployment/nonce', 'GET', undefined, cookie);
    assert.equal(result.status, 503);
    assert.match(result.body.error, /BSC RPC/);
  } finally { await f.close(); }
});

test('deployment journal is durable, CAS guarded and archives import idempotently', async () => {
  const f = await fixture();
  try {
    const { cookie } = await f.login(wallet);
    const start = deployment();
    assert.equal((await f.request('/api/journal/deployment', 'PUT', { record: start, expectedRevision: 0 }, cookie)).body.revision, 1);
    const signing = structuredClone(start);
    signing.status = 'running'; signing.steps[0] = { id: 'PoolVault', status: 'signing', nonce: 7, dataHash: hex(21) };
    assert.equal((await f.request('/api/journal/deployment', 'PUT', { record: signing, expectedRevision: 1 }, cookie)).body.revision, 2);
    assert.equal((await f.request('/api/journal/deployment', 'PUT', { record: start, expectedRevision: 1 }, cookie)).status, 409);
    const erasing = structuredClone(signing); erasing.steps[0].status = 'waiting';
    assert.equal((await f.request('/api/journal/deployment', 'PUT', { record: erasing, expectedRevision: 2 }, cookie)).status, 409);
    const aborted = structuredClone(signing); aborted.status = 'aborted'; aborted.steps[0].status = 'replaced';
    aborted.steps[0].replacementHash = hex(77);
    aborted.steps[0].receipt = { blockNumber: 100, blockHash: hex(100), status: 1 };
    assert.equal((await f.request('/api/journal/deployment', 'PUT', { record: aborted, expectedRevision: 2 }, cookie)).body.revision, 3);
    assert.equal((await f.request('/api/journal/deployment/archive', 'POST', { id: 'first', expectedRevision: 3 }, cookie)).body.revision, 4);
    assert.equal((await f.request('/api/journal/deployment', 'GET', undefined, cookie)).body.record, null);
    const old = deployment(account, 'legacy'); old.status = 'aborted';
    assert.equal((await f.request('/api/journal/deployment/import-archive', 'POST', { record: old }, cookie)).body.id, 'legacy');
    assert.equal((await f.request('/api/journal/deployment/import-archive', 'POST', { record: old }, cookie)).status, 200);
    old.spentWei = '1';
    assert.equal((await f.request('/api/journal/deployment/import-archive', 'POST', { record: old }, cookie)).status, 409);
    const service2 = createJournalService({ dbPath: f.dbPath, origin, provider: chainProof(), currentArtifactDigest: () => hex(5) });
    try {
      const stored = await new Promise(resolve => {
        const server = createServer((req, res) => service2.handle(req, res));
        server.listen(0, '127.0.0.1', async () => {
          const response = await fetch(`http://127.0.0.1:${server.address().port}/api/journal/deployment`, { headers: { Cookie: cookie } });
          const body = await response.json();
          server.close(() => resolve(body));
        });
      });
      assert.equal(stored.revision, 4);
      assert.deepEqual(stored.archives.map(item => item.id), ['legacy', 'first']);
    } finally { await service2.close(); }
  } finally { await f.close(); }
});

test('stale deployment tab cannot start new signatures but can save an already sent transaction', async () => {
  let currentDigest = hex(5);
  const f = await fixture(chainProof(), () => currentDigest);
  try {
    const { cookie } = await f.login(wallet);
    const old = deployment();
    old.steps.push({ id: 'ShareMarket', status: 'waiting' });
    assert.equal((await f.request('/api/journal/build', 'GET', undefined, cookie)).body.artifactDigest, hex(5));
    currentDigest = hex(6);
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: old, expectedRevision: 0 }, cookie)).status, 409);
    assert.equal((await f.request('/api/journal/deployment', 'GET', undefined, cookie)).body.record, null);
    currentDigest = hex(5);
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: old, expectedRevision: 0 }, cookie)).status, 200);
    const signing = structuredClone(old);
    signing.steps[0] = { id: 'PoolVault', status: 'signing', nonce: 7, dataHash: hex(21) };
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: signing, expectedRevision: 1 }, cookie)).status, 200);
    currentDigest = hex(6);
    const submitted = structuredClone(signing);
    submitted.steps[0].status = 'submitted'; submitted.steps[0].txHash = hex(77);
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: submitted, expectedRevision: 2 }, cookie)).status, 200);
    const confirmed = structuredClone(submitted);
    confirmed.steps[0].status = 'confirmed';
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: confirmed, expectedRevision: 3 }, cookie)).status, 200);
    const nextSigning = structuredClone(confirmed);
    nextSigning.steps[1] = { id: 'ShareMarket', status: 'signing', nonce: 8, dataHash: hex(22) };
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: nextSigning, expectedRevision: 4 }, cookie)).status, 409);
    assert.equal((await f.request('/api/journal/deployment', 'GET', undefined, cookie)).body.record.steps[1].status, 'waiting');
    assert.equal((await f.request('/api/journal/build', 'GET', undefined, cookie)).body.artifactDigest, hex(6));
  } finally { await f.close(); }
});

test('source drift blocks pre-send build checks and new intents without losing a broadcast hash', async () => {
  let sourceCurrent = false;
  const f = await fixture(chainProof(), () => hex(5), () => {
    if (!sourceCurrent) throw new Error('Solidity source changed');
  });
  try {
    const { cookie } = await f.login(wallet);
    const start = deployment();
    start.steps.push({ id: 'ShareMarket', status: 'waiting' });
    assert.equal((await f.request('/api/journal/build', 'GET', undefined, cookie)).status, 503);
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: start, expectedRevision: 0 }, cookie)).status, 503);
    sourceCurrent = true;
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: start, expectedRevision: 0 }, cookie)).status, 200);
    const signing = structuredClone(start);
    signing.steps[0] = { id: 'PoolVault', status: 'signing', nonce: 7, dataHash: hex(21) };
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: signing, expectedRevision: 1 }, cookie)).status, 200);
    sourceCurrent = false;
    assert.equal((await f.request('/api/journal/build', 'GET', undefined, cookie)).status, 503);
    const submitted = structuredClone(signing);
    submitted.steps[0].status = 'submitted'; submitted.steps[0].txHash = hex(77);
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: submitted, expectedRevision: 2 }, cookie)).status, 200);
    const confirmed = structuredClone(submitted);
    confirmed.steps[0].status = 'confirmed';
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: confirmed, expectedRevision: 3 }, cookie)).status, 200);
    const next = structuredClone(confirmed);
    next.steps[1] = { id: 'ShareMarket', status: 'signing', nonce: 8, dataHash: hex(22) };
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: next, expectedRevision: 4 }, cookie)).status, 503);
    const saved = (await f.request('/api/journal/deployment', 'GET', undefined, cookie)).body;
    assert.equal(saved.record.steps[0].txHash, hex(77));
    assert.equal(saved.record.steps[1].status, 'waiting');
  } finally { await f.close(); }
});

test('market intent cannot be overwritten or cleared without a finalized same-nonce chain proof', async () => {
  const f = await fixture();
  try {
    const { cookie } = await f.login(wallet), original = intent();
    assert.equal((await f.request('/api/journal/market', 'PUT', { record: original, expectedRevision: 0 }, cookie)).body.revision, 1);
    assert.equal((await f.request('/api/journal/market', 'PUT', { record: { ...original, nonce: 8 }, expectedRevision: 1 }, cookie)).status, 409);
    assert.equal((await f.request('/api/journal/market', 'DELETE', { expectedRevision: 1 }, cookie)).status, 400);
    const withHash = { ...original, hash: hex(77), recoveryHashes: [hex(88)] };
    assert.equal((await f.request('/api/journal/market', 'PUT', { record: withHash, expectedRevision: 1 }, cookie)).body.revision, 2);
    assert.equal((await f.request('/api/journal/market', 'PUT', { record: original, expectedRevision: 2 }, cookie)).status, 409);
    assert.equal((await f.request('/api/journal/market', 'DELETE', { expectedRevision: 1, hash: hex(77) }, cookie)).status, 409);
    assert.equal((await f.request('/api/journal/market', 'DELETE', { expectedRevision: 2, hash: hex(77) }, cookie)).body.revision, 3);
    assert.equal((await f.request('/api/journal/market', 'GET', undefined, cookie)).body.record, null);
  } finally { await f.close(); }
});

test('two wallets racing one order keep independent market intents, nonces and revisions', async () => {
  const f = await fixture();
  try {
    const a = await f.login(wallet), b = await f.login(other);
    const fill = owner => ({ ...intent(owner), action: { kind: 'fill', orderId: '1', amount: '1', expectedPrice: '0' } });
    const first = fill(account), second = fill(other.address.toLowerCase());
    const [savedA, savedB] = await Promise.all([
      f.request('/api/journal/market', 'PUT', { record: first, expectedRevision: 0 }, a.cookie),
      f.request('/api/journal/market', 'PUT', { record: second, expectedRevision: 0 }, b.cookie),
    ]);
    assert.equal(savedA.status, 200); assert.equal(savedB.status, 200);
    assert.equal(savedA.body.revision, 1); assert.equal(savedB.body.revision, 1);
    assert.equal((await f.request('/api/journal/market', 'GET', undefined, a.cookie)).body.record.account, account);
    assert.equal((await f.request('/api/journal/market', 'GET', undefined, b.cookie)).body.record.account, other.address.toLowerCase());
    assert.equal((await f.request('/api/journal/market', 'GET', undefined, b.cookie, origin,
      { 'X-Pinkuang-Account': account })).status, 409);
    assert.equal((await f.request('/api/journal/market', 'PUT', { record: { ...first, nonce: 8 },
      expectedRevision: 1 }, a.cookie)).status, 409);
    assert.equal((await f.request('/api/journal/market', 'PUT', { record: { ...second, hash: hex(88) },
      expectedRevision: 1 }, b.cookie)).body.revision, 2);
    assert.equal((await f.request('/api/journal/market', 'GET', undefined, a.cookie)).body.revision, 1);
    assert.equal((await f.request('/api/journal/market', 'GET', undefined, b.cookie)).body.revision, 2);
  } finally { await f.close(); }
});

test('market recovery remains pending on unavailable RPC and the production HTTP mount reaches the journal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pinkuang-journal-mount-'));
  const service = createJournalService({ dbPath: join(directory, 'private', 'journal.sqlite'), origin,
    currentArtifactDigest: () => hex(5) });
  const server = createDeploymentServer({ journalService: service });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (path, body, cookie) => {
      const response = await fetch(base + path, { method: 'POST', headers: { Origin: origin,
        'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
      return { response, data: await response.json() };
    };
    const challenge = (await post('/api/journal/challenge', { account })).data;
    const session = await post('/api/journal/session', { account, nonce: challenge.nonce,
      signature: await wallet.signMessage(challenge.message) });
    const cookie = session.response.headers.get('set-cookie').split(';')[0];
    const put = await fetch(base + '/api/journal/market', { method: 'PUT', headers: { Origin: origin,
      Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ record: intent(), expectedRevision: 0 }) });
    assert.equal(put.status, 200);
    const deletion = await fetch(base + '/api/journal/market', { method: 'DELETE', headers: { Origin: origin,
      Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 1, hash: hex(77) }) });
    assert.equal(deletion.status, 503);
    const saved = await (await fetch(base + '/api/journal/market', { headers: { Cookie: cookie } })).json();
    assert.equal(saved.record.nonce, 7);
    assert.equal(saved.revision, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('repeated unauthenticated challenge requests cannot block wallet login', async () => {
  const f = await fixture();
  try {
    let issued;
    for (let i = 0; i < 40; i++) {
      const challenge = await f.request('/api/journal/challenge', 'POST', { account });
      assert.equal(challenge.status, 200);
      if (issued) assert.deepEqual(challenge.body, issued);
      else issued = challenge.body;
    }
    const signature = await wallet.signMessage(issued.message);
    const session = await f.request('/api/journal/session', 'POST', { account, nonce: issued.nonce, signature });
    assert.equal(session.status, 200);
    const next = await f.request('/api/journal/challenge', 'POST', { account });
    assert.equal(next.status, 200);
    assert.notEqual(next.body.nonce, issued.nonce);
  } finally { await f.close(); }
});

test('saved quote plans are paged newest first and never leak across wallet sessions', async () => {
  const f = await fixture();
  try {
    const a = await f.login(wallet), b = await f.login(other);
    for (const marker of [1, 2, 3]) {
      const result = await f.request('/api/journal/quote', 'POST', { record: { marker } }, a.cookie);
      assert.equal(result.status, 200);
    }
    const page = await f.request('/api/journal/quotes?limit=2', 'GET', undefined, a.cookie);
    assert.deepEqual(page.body.items.map(item => item.record.marker), [3, 2]);
    assert.equal(page.body.nextCursor, 2);
    assert.deepEqual((await f.request('/api/journal/quotes?cursor=2&limit=2', 'GET', undefined, a.cookie)).body.items
      .map(item => item.record.marker), [1]);
    assert.deepEqual((await f.request('/api/journal/quotes', 'GET', undefined, b.cookie)).body.items, []);
    assert.equal((await f.request('/api/journal/quotes?limit=101', 'GET', undefined, a.cookie)).status, 400);
  } finally { await f.close(); }
});

test('quote writes reject oversized records and stop repeated writes before SQLite fills', async () => {
  const f = await fixture();
  try {
    const { cookie } = await f.login(wallet);
    assert.equal((await f.request('/api/journal/quote', 'POST',
      { record: { payload: 'x'.repeat(4200) } }, cookie)).status, 409);
    for (let i = 1; i < 40; i++) {
      assert.equal((await f.request('/api/journal/quote', 'POST', { record: { marker: i } }, cookie)).status, 200);
    }
    assert.equal((await f.request('/api/journal/quote', 'POST', { record: { marker: 40 } }, cookie)).status, 429);
  } finally { await f.close(); }
});

test('archive verifies every prior deployment nonce and rejects a forged confirmed step', async () => {
  const firstHash = hex(66), firstBlock = hex(99), firstData = '0x6001';
  const base = chainProof();
  const provider = { ...base,
    getTransaction: async hash => hash === firstHash ? { hash, chainId: 56n, from: account, nonce: 6,
      blockNumber: 99, blockHash: firstBlock, to: null, data: firstData, value: 0n } : base.getTransaction(hash),
    getTransactionReceipt: async hash => hash === firstHash ? { hash, from: account, to: null,
      blockNumber: 99, blockHash: firstBlock, status: 1 } : base.getTransactionReceipt(hash),
    getBlock: async id => id === 99 ? { number: 99, hash: firstBlock } : base.getBlock(id),
  };
  for (const forged of [true, false]) {
    const f = await fixture(provider);
    try {
      const { cookie } = await f.login(wallet);
      const record = deployment(account, forged ? 'forged' : 'valid');
      record.status = 'aborted';
      record.steps = [
        { id: 'Library', status: 'confirmed', nonce: 6, txHash: firstHash,
          dataHash: forged ? hex(999) : keccak256(firstData),
          receipt: { blockNumber: 99, blockHash: firstBlock, status: 1 } },
        { id: 'PoolVault', status: 'replaced', nonce: 7, replacementHash: hex(77), dataHash: hex(21),
          receipt: { blockNumber: 100, blockHash: hex(100), status: 1 } },
      ];
      assert.equal((await f.request('/api/journal/deployment', 'PUT', { record, expectedRevision: 0 }, cookie)).status, 200);
      const archived = await f.request('/api/journal/deployment/archive', 'POST', { id: record.id, expectedRevision: 1 }, cookie);
      assert.equal(archived.status, forged ? 409 : 200);
      assert.equal((await f.request('/api/journal/deployment', 'GET', undefined, cookie)).body.record === null, !forged);
    } finally { await f.close(); }
  }
});

test('a fully finalized deployment archives with its complete record and frees the wallet for another deployment', async () => {
  const proof = completedProof();
  let chainReads = 0, latestReads = 0, finalizedReads = 0, nonceReads = 0, activeReceipts = 0, peakReceipts = 0;
  const send = proof.provider.send, getBlock = proof.provider.getBlock;
  const getTransactionCount = proof.provider.getTransactionCount, getTransactionReceipt = proof.provider.getTransactionReceipt;
  proof.provider.send = async (...args) => { chainReads++; return send(...args); };
  proof.provider.getBlock = async tag => {
    if (tag === 'latest') latestReads++;
    if (tag === 'finalized') finalizedReads++;
    return getBlock(tag);
  };
  proof.provider.getTransactionCount = async (...args) => { nonceReads++; return getTransactionCount(...args); };
  proof.provider.getTransactionReceipt = async hash => {
    activeReceipts++; peakReceipts = Math.max(peakReceipts, activeReceipts);
    try {
      await new Promise(resolve => setTimeout(resolve, 1));
      return getTransactionReceipt(hash);
    } finally { activeReceipts--; }
  };
  const f = await fixture(proof.provider);
  try {
    const { cookie } = await f.login(wallet);
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: proof.record, expectedRevision: 0 }, cookie)).body.revision, 1);
    assert.equal((await f.request('/api/journal/deployment/archive', 'POST',
      { id: proof.record.id, expectedRevision: 0 }, cookie)).status, 409);
    const result = await f.request('/api/journal/deployment/archive', 'POST',
      { id: proof.record.id, expectedRevision: 1 }, cookie);
    assert.equal(result.status, 200);
    assert.equal(result.body.revision, 2);
    assert.deepEqual(result.body.archives[0], proof.record);
    assert.equal((await f.request('/api/journal/deployment', 'GET', undefined, cookie)).body.record, null);
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: deployment(account, 'next-deployment'), expectedRevision: 2 }, cookie)).body.revision, 3);
    assert.equal(chainReads, 2);
    assert.equal(latestReads, 1);
    assert.equal(finalizedReads, 1);
    assert.equal(nonceReads, 0, 'Completed archive uses canonical transaction inclusion without historical state reads.');
    assert.ok(peakReceipts > 1 && peakReceipts <= 4);
  } finally { await f.close(); }
});

test('a same-intent accelerated deployment archives after durable recovery and retains the original hash', async () => {
  const proof = completedProof();
  const recovered = proof.record.steps.at(-1);
  const oldHash = hex(9002);
  const pending = structuredClone(proof.record);
  pending.status = 'paused';
  pending.steps.at(-1).status = 'submitted';
  pending.steps.at(-1).txHash = oldHash;
  pending.spentWei = (BigInt(pending.spentWei) - BigInt(recovered.receipt.feeWei)).toString();
  delete pending.steps.at(-1).receipt;
  recovered.previousTxHashes = [oldHash];
  recovered.finalizedRecovery = true;
  proof.transactions.set(oldHash, { ...proof.transactions.get(recovered.txHash), hash: oldHash,
    blockNumber: null, blockHash: null });
  const f = await fixture(proof.provider);
  try {
    const { cookie } = await f.login(wallet);
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: pending, expectedRevision: 0 }, cookie)).body.revision, 1);
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: proof.record, expectedRevision: 1 }, cookie)).body.revision, 2);
    const result = await f.request('/api/journal/deployment/archive', 'POST',
      { id: proof.record.id, expectedRevision: 2 }, cookie);
    assert.equal(result.status, 200);
    assert.equal(result.body.revision, 3);
    assert.deepEqual(result.body.archives[0], proof.record);
    assert.deepEqual(result.body.archives[0].steps.at(-1).previousTxHashes, [oldHash]);
    assert.equal((await f.request('/api/journal/deployment', 'GET', undefined, cookie)).body.record, null);
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: deployment(account, 'after-acceleration'), expectedRevision: 3 }, cookie)).body.revision, 4);
  } finally { await f.close(); }
});

test('completed archive rejects partial, unknown, replaced, tampered and unfinalized steps without clearing the record', async () => {
  const variants = [
    ['missing step', proof => { proof.record.steps.pop(); }],
    ['unknown step', proof => { proof.record.steps[5].status = 'uncertain'; }],
    ['replaced step', proof => { proof.record.steps[5].replacementHash = hex(9001); }],
    ['unmarked acceleration history', proof => { proof.record.steps[5].previousTxHashes = [hex(9002)]; }],
    ['forged calldata', proof => { proof.record.steps[5].dataHash = hex(9003); }],
    ['forged receipt', proof => { proof.record.steps[5].receipt.blockHash = hex(9004); }],
    ['forged address', proof => { proof.record.steps[5].address = Wallet.createRandom().address; }],
    ['missing address', proof => { delete proof.record.addresses.PoolVault; }],
    ['forged fee', proof => { proof.record.spentWei = '0'; }],
    ['unverified graph', proof => { proof.record.verification.checks[0].passed = false; }],
    ['missing chain transaction', proof => { proof.transactions.delete(proof.record.steps[5].txHash); }],
    ['finalized anchor changed', proof => {
      const original = proof.provider.getBlock;
      proof.provider.getBlock = async tag => tag === 120 ? { number: 120, hash: hex(9990) } : original(tag);
    }],
    ['chain changed', proof => {
      let reads = 0;
      proof.provider.send = async () => ++reads === 1 ? '0x38' : '0x1';
    }],
    ['canonical block changed', proof => {
      const original = proof.provider.getBlock;
      let reads = 0;
      proof.provider.getBlock = async tag => tag === 105 && ++reads > 1
        ? { number: 105, hash: hex(9991) } : original(tag);
    }],
    ['unfinalized chain', proof => {
      const original = proof.provider.getBlock;
      proof.provider.getBlock = async tag => tag === 'finalized' || tag === 120
        ? { number: 105, hash: hex(2105) } : original(tag);
    }],
  ];
  for (const [label, mutate] of variants) {
    const proof = completedProof(account, label.replaceAll(' ', '-'));
    mutate(proof);
    const f = await fixture(proof.provider);
    try {
      const { cookie } = await f.login(wallet);
      assert.equal((await f.request('/api/journal/deployment', 'PUT',
        { record: proof.record, expectedRevision: 0 }, cookie)).status, 200, label);
      const result = await f.request('/api/journal/deployment/archive', 'POST',
        { id: proof.record.id, expectedRevision: 1 }, cookie);
      assert.equal(result.status, 409, label);
      const saved = await f.request('/api/journal/deployment', 'GET', undefined, cookie);
      assert.equal(saved.body.record.id, proof.record.id, label);
      assert.equal(saved.body.revision, 1, label);
    } finally { await f.close(); }
  }
});

test('completed archive keeps the record on an RPC failure midway through batched proof', async () => {
  const proof = completedProof();
  const original = proof.provider.getTransactionReceipt;
  proof.provider.getTransactionReceipt = async hash => {
    if (hash === proof.record.steps[5].txHash) throw new Error('RPC interrupted');
    return original(hash);
  };
  const f = await fixture(proof.provider);
  try {
    const { cookie } = await f.login(wallet);
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: proof.record, expectedRevision: 0 }, cookie)).status, 200);
    assert.equal((await f.request('/api/journal/deployment/archive', 'POST',
      { id: proof.record.id, expectedRevision: 1 }, cookie)).status, 503);
    assert.equal((await f.request('/api/journal/deployment', 'GET', undefined, cookie)).body.record.id, proof.record.id);
  } finally { await f.close(); }
});

test('archive keyset pagination reaches records older than 100 and retains latest completed deployment', async () => {
  const proof = completedProof();
  const f = await fixture(proof.provider);
  try {
    const owner = await f.login(wallet), stranger = await f.login(other);
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: proof.record, expectedRevision: 0 }, owner.cookie)).status, 200);
    const archived = await f.request('/api/journal/deployment/archive', 'POST',
      { id: proof.record.id, expectedRevision: 1 }, owner.cookie);
    assert.equal(archived.status, 200);
    assert.equal(archived.body.latestCompleted.id, proof.record.id);
    for (let index = 0; index < 110; index++) {
      const record = deployment(account, `old-${index.toString().padStart(3, '0')}`);
      record.status = 'aborted';
      assert.equal((await f.request('/api/journal/deployment/import-archive', 'POST',
        { record }, owner.cookie)).status, 200);
    }
    const state = await f.request('/api/journal/deployment', 'GET', undefined, owner.cookie);
    assert.equal(state.body.archives.length, 100);
    assert.equal(state.body.archives.some(item => item.id === proof.record.id), false);
    assert.equal(state.body.latestCompleted.id, proof.record.id);
    assert.match(state.body.archiveNextCursor, /^[1-9]\d*$/);
    const seen = [];
    let cursor = null;
    do {
      const path = `/api/journal/deployment/archives?limit=37${cursor ? `&cursor=${cursor}` : ''}`;
      const page = await f.request(path, 'GET', undefined, owner.cookie);
      assert.equal(page.status, 200);
      seen.push(...page.body.items.map(item => item.id));
      if (cursor === null) {
        assert.equal(page.body.items[0].id, 'old-109');
        const added = deployment(account, 'later-import'); added.status = 'aborted';
        assert.equal((await f.request('/api/journal/deployment/import-archive', 'POST',
          { record: added }, owner.cookie)).status, 200);
      }
      cursor = page.body.nextCursor;
    } while (cursor);
    assert.equal(seen.length, 111);
    assert.equal(new Set(seen).size, 111);
    assert.equal(seen.at(-1), proof.record.id);
    assert.equal(seen.includes('later-import'), false);
    const isolated = await f.request('/api/journal/deployment/archives', 'GET', undefined, stranger.cookie);
    assert.deepEqual(isolated.body, { items: [], nextCursor: null });
    assert.equal((await f.request('/api/journal/deployment', 'GET', undefined, stranger.cookie)).body.latestCompleted, null);
    for (const query of ['cursor=0', 'cursor=9223372036854775808', 'limit=0', 'limit=101', 'cursor=2&cursor=3']) {
      assert.equal((await f.request(`/api/journal/deployment/archives?${query}`, 'GET', undefined, owner.cookie)).status, 400);
    }
  } finally { await f.close(); }
});

test('completed archive stays locked while the fixed BSC verifier is unavailable', async () => {
  const proof = completedProof();
  const f = await fixture(null);
  try {
    const { cookie } = await f.login(wallet);
    assert.equal((await f.request('/api/journal/deployment', 'PUT',
      { record: proof.record, expectedRevision: 0 }, cookie)).status, 200);
    assert.equal((await f.request('/api/journal/deployment/archive', 'POST',
      { id: proof.record.id, expectedRevision: 1 }, cookie)).status, 503);
    assert.equal((await f.request('/api/journal/deployment', 'GET', undefined, cookie)).body.record.id, proof.record.id);
  } finally { await f.close(); }
});

test('verified native upgrade reaches the public graph snapshot without changing the pinned deployment manifest', async () => {
  const directory=await mkdtemp(join(tmpdir(),'journal-native-graph-'));
  const record=JSON.parse(await readFile(new URL('../public/upgrade-genesis/genesis-record.json',import.meta.url),'utf8')),
    bundle=JSON.parse(await readFile(new URL('../public/upgrade-genesis/genesis-artifacts.json',import.meta.url),'utf8'));
  const initial=record.steps.find(step=>step.id==='initialize'),activationBlock=initial.receipt.blockNumber+10,
    activationHash=hex(998),block={number:activationBlock+10,hash:hex(999),timestamp:1_700_000_100};
  const nativeSaleUpgrade={version:1,candidateArtifactDigest:hex(880),operationId:hex(881),replacements:{PoolVault:factory}},
    authority={address:market,gasWallet:wallet.address,administratorOne:account,administratorTwo:other.address,
      codehash:hex(882),deploymentTxHash:hex(883),activationBlock,activationHash};
  const provider={async send(method){assert.equal(method,'eth_chainId');return '0x38';},async getBlock(tag){
    if(tag==='finalized'||tag===block.number)return block;
    if(tag===activationBlock)return {number:tag,hash:activationHash,timestamp:block.timestamp-1};
    throw new Error(`Unexpected block ${tag}`);
  }};
  let verifications=0;
  const service=createJournalService({dbPath:join(directory,'private','journal.sqlite'),origin,provider,
    currentArtifactDigest:()=>record.artifactDigest,productDeploymentRecord:record,productArtifactBundle:bundle,
    allowedProductFactories:[record.addresses.factory,record.addresses.portfolioFactory],
    productGraphVerifier:async()=>{verifications++;return {factory:record.addresses.factory,blockNumber:block.number,
      artifactDigest:record.artifactDigest,addresses:record.addresses,
      codehash:Object.fromEntries(Object.entries(record.verification.code).map(([name,value])=>[name,value.codehash])),
      freshFactoryVerified:true,freshAuthority:authority,nativeSaleUpgrade};}});
  const server=createServer((req,res)=>service.handle(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/journal/product-graph`);
    assert.equal(response.status,200);const payload=await response.json();
    assert.deepEqual(payload.nativeSaleUpgrade,nativeSaleUpgrade);
    assert.deepEqual(service.currentProductGraphSnapshot().nativeSaleUpgrade,nativeSaleUpgrade);
    assert.equal(payload.manifest.artifactDigest,record.artifactDigest);
    assert.equal(payload.manifest.factory,record.addresses.factory);assert.equal(verifications,1);
  }finally{await new Promise(resolve=>server.close(resolve));await service.close();await rm(directory,{recursive:true,force:true});}
});

test('production configuration requires explicit private store, exact HTTPS origin and HTTPS RPC', () => {
  assert.throws(() => journalConfiguration({ NODE_ENV: 'production' }), /requires explicit/);
  assert.throws(() => journalConfiguration({ NODE_ENV: 'production', DEPLOYMENT_JOURNAL_DB: '/tmp/j.sqlite',
    DEPLOYMENT_JOURNAL_ORIGIN: 'https://app.example', DEPLOYMENT_JOURNAL_RPC_URL: 'http://rpc.example' }), /HTTPS/);
  assert.equal(journalConfiguration({ NODE_ENV: 'development', DEPLOYMENT_JOURNAL_ORIGIN: 'https://app.example' }).secureCookies, true);
  const cli = spawnSync(process.execPath, ['server/index.mjs'], { cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { PATH: process.env.PATH, NODE_ENV: 'development' }, encoding: 'utf8', timeout: 3_000 });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /Production journal requires explicit/);
});

test('journal refuses a group-readable database directory, including its WAL files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pinkuang-journal-perms-'));
  try {
    await chmod(directory, 0o755);
    assert.throws(() => createJournalService({ dbPath: join(directory, 'journal.sqlite'), origin,
      provider: chainProof(), currentArtifactDigest: () => hex(5) }), /private/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('Stage 2 protocol handshake rejects authenticated old tabs before reading or writing activation',async()=>{
  const f=await fixture();
  try {
    const {cookie}=await f.login(wallet);
    for(const version of ['','1','3']) for(const [path,method] of [
      ['/api/journal/fresh-activation/config','GET'],['/api/journal/fresh-activation','GET'],
      ['/api/journal/fresh-activation','PUT'],['/api/journal/fresh-activation/release-unused-signing','POST'],
      ['/api/journal/fresh-activation/recover-finalized-attempt','POST'],
    ]){
      const result=await f.request(path,method,method==='GET'?undefined:{},cookie,origin,
        {'X-Pinkuang-Activation-Protocol':version});
      assert.equal(result.status,426);
      assert.match(result.body.error,/部署台已更新/);
    }
    assert.equal((await f.request('/api/journal/fresh-activation','GET',undefined,cookie)).status,200);
    assert.equal((await f.request('/api/journal/deployment','GET',undefined,cookie)).status,200);
  } finally {await f.close();}
});
