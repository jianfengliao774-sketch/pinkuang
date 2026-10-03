import test from 'node:test';
import assert from 'node:assert/strict';
import { freshUpgradeDeploymentOrder } from '../shared/fresh-active-upgrade-plan.mjs';
import { freshActiveUpgradeJournalKey, newFreshActiveUpgradeJournal, parseFreshActiveUpgradeJournal,
  type FreshActiveUpgradeJournal } from './fresh-active-upgrade-ui';

const context = { factory: `0x${'1'.repeat(40)}`, genesisArtifactDigest: `0x${'2'.repeat(64)}`,
  upgradeArtifactDigest: `0x${'3'.repeat(64)}` };
const salt = `0x${'4'.repeat(64)}`;
const sender = `0x${'5'.repeat(40)}`;
const hash = `0x${'6'.repeat(64)}`;
const journal = () => newFreshActiveUpgradeJournal(context, salt);
const confirmed = (index: number) => ({ status: 'confirmed' as const, from: sender, dataHash: hash,
  txHash: hash, address: `0x${(index + 10).toString(16).padStart(40, '0')}` });
const full = () => ({ ...journal(), deployments: Object.fromEntries(freshUpgradeDeploymentOrder
  .map((name, index) => [name, confirmed(index)])) }) as FreshActiveUpgradeJournal;

test('fresh active upgrade records bind both digests and use a separate namespace', () => {
  const record = journal();
  assert.equal(parseFreshActiveUpgradeJournal(JSON.parse(JSON.stringify(record)), context).kind, 'fresh-active-upgrade');
  assert.match(freshActiveUpgradeJournalKey(context), /^pinkuang\.fresh-active-upgrade\.v1\./);
  assert.throws(() => parseFreshActiveUpgradeJournal(record, { ...context, upgradeArtifactDigest: salt }), /不匹配/);
  assert.throws(() => freshActiveUpgradeJournalKey({ ...context, upgradeArtifactDigest: context.genesisArtifactDigest }), /不同/);
});
test('legacy journals or injected permission migration steps cannot resume this flow', () => {
  assert.throws(() => parseFreshActiveUpgradeJournal({ ...journal(), kind: undefined }, context), /不匹配/);
  assert.throws(() => parseFreshActiveUpgradeJournal({ ...journal(), bootstrap: {} }, context), /其他版本/);
  assert.throws(() => parseFreshActiveUpgradeJournal({ ...journal(), deployments: { PoolFactory: confirmed(0) } }, context), /不属于/);
});
test('only an exact confirmed prefix followed by one pending deployment may resume', () => {
  const record = journal();
  record.deployments.PoolFunds = confirmed(0);
  record.deployments.FlexiblePurchase = { status: 'uncertain', from: sender, dataHash: hash };
  assert.equal(parseFreshActiveUpgradeJournal(record, context).deployments.FlexiblePurchase?.status, 'uncertain');
  assert.throws(() => parseFreshActiveUpgradeJournal({ ...record, deployments: { ...record.deployments,
    SaleSettlement: confirmed(2) } }, context), /依赖顺序/);
  assert.throws(() => parseFreshActiveUpgradeJournal({ ...record, deployments: { FlexiblePurchase: confirmed(1) } }, context), /依赖顺序/);
});
test('a confirmed deployment must retain the original transaction and a unique nonzero address', () => {
  assert.throws(() => parseFreshActiveUpgradeJournal({ ...journal(), deployments: { PoolFunds: {
    ...confirmed(0), txHash: undefined } } }, context), /缺少/);
  const record = journal();
  record.deployments.PoolFunds = confirmed(0);
  record.deployments.FlexiblePurchase = confirmed(0);
  assert.throws(() => parseFreshActiveUpgradeJournal(record, context), /重复/);
});
test('known submissions require a hash but uncertain wallet results remain recoverable', () => {
  const record = journal();
  record.deployments.PoolFunds = { status: 'uncertain', from: sender, dataHash: hash };
  assert.equal(parseFreshActiveUpgradeJournal(record, context).deployments.PoolFunds?.txHash, undefined);
  record.deployments.PoolFunds.status = 'submitted';
  assert.throws(() => parseFreshActiveUpgradeJournal(record, context), /缺少哈希/);
});
test('timelock execution cannot precede confirmed scheduling and ten finalized candidate records', () => {
  assert.throws(() => parseFreshActiveUpgradeJournal({ ...journal(), schedule: {
    status: 'uncertain', from: sender, dataHash: hash } }, context), /十个/);
  const record = full();
  record.execute = { status: 'uncertain', from: sender, dataHash: hash };
  assert.throws(() => parseFreshActiveUpgradeJournal(record, context), /已确认排程/);
  record.schedule = { status: 'confirmed', from: sender, dataHash: hash, txHash: hash };
  assert.equal(parseFreshActiveUpgradeJournal(record, context).execute?.status, 'uncertain');
});
test('nonzero salt and at least 48 hours are required when restoring a journal', () => {
  assert.throws(() => newFreshActiveUpgradeJournal(context, `0x${'0'.repeat(64)}`), /非零/);
  assert.throws(() => parseFreshActiveUpgradeJournal({ ...journal(), delaySeconds: 60 }, context), /不匹配/);
});
