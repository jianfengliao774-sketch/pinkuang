import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newUpgradeJournal, parseUpgradeJournal, upgradeJournalKey } from './upgrade-journal';

const factory = '0x1111111111111111111111111111111111111111';
const oldDigest = `0x${'a'.repeat(64)}`;
const newDigest = `0x${'b'.repeat(64)}`;
const salt = `0x${'c'.repeat(64)}`;
const expected = {factory,genesisArtifactDigest:oldDigest,upgradeArtifactDigest:newDigest};

test('journal key binds factory and both artifact digests', () => {
  assert.match(upgradeJournalKey(factory,oldDigest,newDigest),/pinkuang\.upgrade\.v1\./);
  assert.notEqual(upgradeJournalKey(factory,oldDigest,newDigest),upgradeJournalKey(factory,newDigest,oldDigest));
});

test('journal rejects a changed build, invalid delay and corrupted transaction', () => {
  const journal = newUpgradeJournal(expected,salt);
  assert.deepEqual(parseUpgradeJournal(JSON.parse(JSON.stringify(journal)),expected),journal);
  assert.throws(() => parseUpgradeJournal(journal,{...expected,upgradeArtifactDigest:oldDigest}),/不匹配/);
  assert.throws(() => parseUpgradeJournal({...journal,delaySeconds:60},expected),/不匹配/);
  assert.throws(() => parseUpgradeJournal({...journal,deployments:{PoolFunds:{status:'confirmed',from:factory,dataHash:'0x00'}}},expected),/字段无效/);
});
