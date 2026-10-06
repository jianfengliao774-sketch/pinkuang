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
  assert.throws(() => parseUpgradeJournal({...journal,pauses:{factory:{status:'submitted',from:factory,dataHash:'0x00'}}},expected),/字段无效/);
  assert.throws(() => parseUpgradeJournal({...journal,pauses:{otherFactory:{status:'submitted',from:factory,dataHash:oldDigest}}},expected),/暂停步骤/);
  assert.throws(() => parseUpgradeJournal({...journal,bootstrap:{hardwareWallet:factory,salt:'0x00',delaySeconds:172800}},expected),/角色授权/);
});

test('restored stage-two records reject incomplete public addresses and altered migration steps', () => {
  const journal = newUpgradeJournal(expected,salt);
  const validTx = {status:'submitted' as const,from:factory,dataHash:oldDigest,txHash:newDigest};
  assert.throws(() => parseUpgradeJournal({...journal,authority:{hardwareWallet:factory,
    gasWallet:'0x123',deployment:validTx}},expected),/invalid address/i);
  assert.throws(() => parseUpgradeJournal({...journal,role:{salt,delaySeconds:172800,
    direct:{6:validTx}}},expected),/角色迁移记录无效/);
  assert.throws(() => parseUpgradeJournal({...journal,treasury:{saltSeed:salt,
    delaySeconds:172800,operations:{'01':{schedule:validTx}}}},expected),/金库迁移记录无效/);
  assert.throws(() => parseUpgradeJournal({...journal,treasury:{saltSeed:salt,
    delaySeconds:172800,operations:{0:{execute:{...validTx,dataHash:'0x00'}}}}},expected),/交易字段无效/);
});
