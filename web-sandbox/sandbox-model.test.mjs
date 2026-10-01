import test from 'node:test';
import assert from 'node:assert/strict';
import { amount5, parseTestPrice, exactBnb, initialMembers, linkBytecode, runtimeMatches, checkArtifact, checkManifest, receiptResult, walletRejected, proposalView, transactionMatches, KIND, DEPLOY_ORDER, addressesOf, isComplete } from './src/sandbox-model.mjs';

const owner = '0x1111111111111111111111111111111111111111';
const member = '0x2222222222222222222222222222222222222222';
const hash = `0x${'ab'.repeat(32)}`;
const contracts = Object.fromEntries(DEPLOY_ORDER.map((name) => [name, { abi: [], bytecode: '0x6001600055', deployedBytecode: '0x6001' }]));
const artifact = { schemaVersion: 1, kind: KIND, chainId: 56, deployOrder: DEPLOY_ORDER, contracts, productionExcludedAddresses: [member] };
const manifest = { schemaVersion: 1, kind: KIND, chainId: 56, artifactDigest: hash, owner, initialMembers: [owner], initialShares: [100], purchaseCost: '10000000000000', steps: {} };

test('BNB displays five decimals without changing transaction precision, caps real tests', () => {
  assert.equal(amount5(0n), '0.00000'); assert.equal(amount5(10000000000000n), '0.00001');
  assert.equal(amount5(19999999999999n), '0.00001'); assert.equal(amount5(1n), '<0.00001');
  assert.equal(amount5(1234567890000000000n), '1.23456');
  assert.equal(exactBnb(19999999999999n), '0.000019999999999999');
  assert.equal(parseTestPrice('0.001'), 1000000000000000n);
  assert.throws(() => parseTestPrice('0.001000000000000001'), /最高/);
  for (const text of ['-1', '1e-5', '0', '', '0.0000000000000000001']) assert.throws(() => parseTestPrice(text));
});

test('initial members have integer shares totalling 100 and no duplicate wallets', () => {
  assert.deepEqual(initialMembers('', owner), { members: [owner], shares: [100] });
  assert.deepEqual(initialMembers(`${owner} 60\n${member},40`, owner), { members: [owner, member], shares: [60, 40] });
  for (const text of [`${owner} 99`, `${owner} 60\n${owner} 40`, `${owner} 1.1`, `${owner} 0\n${member} 100`, 'not-an-address 100']) assert.throws(() => initialMembers(text, owner));
});

test('bytecode links only the two known libraries at bounded 20-byte offsets', () => {
  const refs = { 'x.sol': { ShareCheckpoints: [{ start: 1, length: 20 }] } };
  assert.equal(linkBytecode(`0x60${'_'.repeat(40)}01`, refs, { ShareCheckpoints: owner }), `0x60${owner.slice(2)}01`);
  assert.throws(() => linkBytecode('0x__', {}, {}), /未完成/);
  assert.throws(() => linkBytecode(`0x60${'_'.repeat(40)}01`, refs, {}), /未部署/);
  assert.throws(() => linkBytecode('0x6001', { x: { ShareCheckpoints: [{ start: 1, length: 20 }] } }, { ShareCheckpoints: owner }), /位置/);
  assert.throws(() => linkBytecode(`0x60${'_'.repeat(40)}01`, { x: { Authority: [{ start: 1, length: 20 }] } }, { Authority: owner }));
});

test('runtime compares linked libraries, immutable slots and library self address', () => {
  const contract = { deployedBytecode: '0x60000001', immutableReferences: { '1': [{ start: 1, length: 2 }] } };
  assert.equal(runtimeMatches('0x60abcd01', contract, {}), true);
  assert.equal(runtimeMatches('0x61abcd01', contract, {}), false);
  assert.equal(runtimeMatches('0x60abcd0100', contract, {}), false);
  const lib = { deployedBytecode: `0x73${'0'.repeat(40)}6001` };
  assert.equal(runtimeMatches(`0x73${owner.slice(2)}6001`, lib, {}, owner), true);
  assert.equal(runtimeMatches(`0x73${member.slice(2)}6001`, lib, {}, owner), false);
});

test('artifact and manifests reject wrong chain/version/digest and formal targets', () => {
  assert.equal(checkArtifact(artifact), artifact);
  assert.throws(() => checkArtifact({ ...artifact, chainId: 97 }));
  assert.throws(() => checkArtifact({ ...artifact, deployOrder: DEPLOY_ORDER.toReversed() }));
  assert.equal(checkManifest(manifest, artifact, hash), manifest);
  assert.throws(() => checkManifest({ ...manifest, artifactDigest: 'old' }, artifact, hash));
  assert.throws(() => checkManifest({ ...manifest, purchaseCost: '1000000000000001' }, artifact, hash));
  assert.throws(() => checkManifest({ ...manifest, steps: { SandboxSalePool: { status: 'confirmed', hash, address: member } } }, artifact, hash), /正式合约/);
  const full = { ...manifest, steps: Object.fromEntries(DEPLOY_ORDER.map((name, i) => [name, { status: 'confirmed', hash, address: `0x${String(i + 3).repeat(40)}` }])) };
  assert.equal(isComplete(full), true); assert.equal(Object.keys(addressesOf(full)).length, 3);
});

test('only an explicit matching receipt confirms or fails; network/pending is neither', () => {
  assert.equal(receiptResult(null, hash), 'pending');
  assert.equal(receiptResult({ transactionHash: hash }, hash), 'pending');
  assert.equal(receiptResult({ transactionHash: `0x${'cd'.repeat(32)}`, status: '0x1' }, hash), 'pending');
  assert.equal(receiptResult({ transactionHash: hash, status: '0x1' }, hash), 'success');
  assert.equal(receiptResult({ hash, status: 0 }, hash), 'failed');
  assert.equal(walletRejected({ code: 'ACTION_REJECTED' }), true);
  assert.equal(walletRejected({ info: { error: { code: 4001 } } }), true);
  assert.equal(walletRejected({ code: 'NETWORK_ERROR' }), false);
});

test('governance preserves dual majority, low-price review, fresh price and immediate execution', () => {
  const now = 1000;
  const proposal = { price: 100n, snapshotMemberCount: 3n, snapshotTotalShares: 100n, yesCount: 2n, yesShares: 51n, endsAt: 1100n, executed: false };
  const reference = [120n, 999n, hash];
  assert.equal(proposalView(proposal, reference, [0, 0], now).executable, false);
  assert.equal(proposalView(proposal, reference, [1, 100n], now).executable, true);
  assert.equal(proposalView({ ...proposal, yesShares: 50n }, reference, [1, 100n], now).passed, false);
  assert.equal(proposalView({ ...proposal, yesCount: 1n }, reference, [1, 100n], now).passed, false);
  assert.equal(proposalView(proposal, reference, [1, 100n], 1100).executable, false);
  assert.equal(proposalView(proposal, [100n, 1n, hash], [0, 0], now).executable, false);
  assert.equal(proposalView(proposal, [100n, 999n, hash], [0, 0], now).executable, true);
});

test('manual transaction recovery binds sender, target, exact data, value and known hash', () => {
  const record = { account: owner, target: null, data: '0x600100', value: '0' };
  const tx = { hash, from: owner, to: null, input: '0x600100', value: '0x0' };
  assert.equal(transactionMatches(record, tx), true);
  for (const change of [{ from: member }, { to: member }, { input: '0x600101' }, { value: '0x1' }, { hash: 'not-a-hash' }]) assert.equal(transactionMatches(record, { ...tx, ...change }), false);
  assert.equal(transactionMatches({ ...record, hash: `0x${'cd'.repeat(32)}` }, tx), false);
  assert.equal(transactionMatches({ ...record, target: member }, { ...tx, to: member }), true);
  assert.equal(transactionMatches({ ...record, target: member }, tx), false);
  assert.equal(checkManifest({ ...manifest, steps: { ShareCheckpoints: { ...record, status: 'signing' } } }, artifact, hash).steps.ShareCheckpoints.status, 'signing');
  assert.equal(checkManifest({ ...manifest, steps: { ShareCheckpoints: { ...record, status: 'uncertain' } } }, artifact, hash).steps.ShareCheckpoints.status, 'uncertain');
});
