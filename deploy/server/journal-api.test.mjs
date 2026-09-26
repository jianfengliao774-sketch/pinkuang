import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Wallet, getCreateAddress, keccak256 } from 'ethers';
import { createJournalService, journalConfiguration } from './journal-api.mjs';
import { createDeploymentServer } from './index.mjs';

const origin = 'http://127.0.0.1:4173';
const hex = n => `0x${n.toString(16).padStart(64, '0')}`;
const wallet = Wallet.createRandom(), other = Wallet.createRandom();
const account = wallet.address.toLowerCase(), market = Wallet.createRandom().address.toLowerCase();
const factory = Wallet.createRandom().address.toLowerCase();

function deployment(owner = account, id = 'first') {
  return { schemaVersion: 1, id, chainId: 56, account: owner, sourceCommit: 'a'.repeat(40),
    artifactDigest: hex(5), input: { ownerMultisig: owner, operator: owner, treasury: owner,
      governanceMode: 'single', maxGasBudgetBnb: '0.05', gasPriceCapGwei: '1', governanceReviewed: true, protocolReviewed: true },
    status: 'ready', steps: [{ id: 'PoolVault', status: 'waiting' }], addresses: {}, spentWei: '0', preflight: {} };
}
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
    const receipt = { hash, from: owner, to, blockNumber, blockHash, status: 1,
      contractAddress, gasUsed: 21_000n, gasPrice: 1_000_000_000n, fee };
    transactions.set(hash, { hash, chainId: 56n, from: owner, nonce, blockNumber, blockHash,
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
        : blockHashes.has(tag) ? { number: tag, hash: blockHashes.get(tag) } : null,
    getTransactionCount: async () => 23,
  };
  return { record, provider, transactions, receipts, blockHashes };
}

async function fixture(provider = chainProof()) {
  const directory = await mkdtemp(join(tmpdir(), 'pinkuang-journal-'));
  const dbPath = join(directory, 'private', 'journal.sqlite');
  const service = createJournalService({ dbPath, origin, provider });
  const server = createServer((req, res) => service.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = 'GET', body, cookie, requestOrigin = origin, extraHeaders = {}) => {
    const response = await fetch(`${base}${path}`, { method,
      headers: { ...(method === 'GET' ? {} : { Origin: requestOrigin, 'Content-Type': 'application/json' }),
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
  return { directory, dbPath, service, server, request, login,
    async close() { await new Promise(resolve => server.close(resolve)); await service.close(); await rm(directory, { recursive: true, force: true }); } };
}

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
    const service2 = createJournalService({ dbPath: f.dbPath, origin, provider: chainProof() });
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

test('market recovery remains pending on unavailable RPC and the production HTTP mount reaches the journal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pinkuang-journal-mount-'));
  const service = createJournalService({ dbPath: join(directory, 'private', 'journal.sqlite'), origin });
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
    assert.equal(nonceReads, 1);
    assert.ok(peakReceipts > 1 && peakReceipts <= 4);
  } finally { await f.close(); }
});

test('completed archive rejects partial, unknown, replaced, tampered and unfinalized steps without clearing the record', async () => {
  const variants = [
    ['missing step', proof => { proof.record.steps.pop(); }],
    ['unknown step', proof => { proof.record.steps[5].status = 'uncertain'; }],
    ['replaced step', proof => { proof.record.steps[5].replacementHash = hex(9001); }],
    ['replacement history', proof => { proof.record.steps[5].previousTxHashes = [hex(9002)]; }],
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
    assert.throws(() => createJournalService({ dbPath: join(directory, 'journal.sqlite'), origin, provider: chainProof() }), /private/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
