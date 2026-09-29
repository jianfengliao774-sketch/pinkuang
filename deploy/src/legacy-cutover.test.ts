import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Interface } from 'ethers';
import { assertLegacyCutoverReady, legacyPauseData } from './legacy-cutover';

const owner = '0x6F4d78fB59eC938cBAF65b9fc822aD04d00c155E';
const status = { owner, poolCount: 0n, creationPaused: false, block: 124510792 };

test('legacy cutover only permits the owner of an empty, active factory', () => {
  assert.doesNotThrow(() => assertLegacyCutoverReady(status, owner.toLowerCase()));
  assert.throws(() => assertLegacyCutoverReady(status, '0x7674fa446D42b1f7f150DC5e678cc525d275Ea53'), /owner/);
  assert.throws(() => assertLegacyCutoverReady({ ...status, poolCount: 1n }, owner), /已经出现矿池/);
  assert.throws(() => assertLegacyCutoverReady({ ...status, creationPaused: true }, owner), /无需重复/);
});

test('legacy cutover calldata can only pause creation', () => {
  const iface = new Interface(['function pauseCreation(bool)']);
  assert.deepEqual(iface.decodeFunctionData('pauseCreation', legacyPauseData()).toArray(), [true]);
});
