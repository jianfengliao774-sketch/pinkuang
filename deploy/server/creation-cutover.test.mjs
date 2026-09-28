import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, getAddress } from 'ethers';
import { legacyFactoryConfiguration, verifyCreationCutover } from './creation-cutover.mjs';
import { journalConfiguration } from './journal-api.mjs';

const address = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`), old = address(10), current = address(20);
const abi = new Interface(['function poolCount() view returns(uint256)', 'function creationPaused() view returns(bool)']);
const block = { number: 124457051, hash: `0x${'ab'.repeat(32)}` };
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
function fixture() {
  const state = { count: 0n, paused: true, code: '0x6000', failMethod: null, reads: [] };
  const provider = {
    getCode: async (target, height) => { assert.equal(target, old); assert.equal(height, block.number); return state.code; },
    send: async (method, [tx, tag]) => {
      assert.equal(method, 'eth_call'); assert.equal(tx.to, old); assert.equal(tag, `0x${block.number.toString(16)}`);
      const name = abi.parseTransaction(tx).name; state.reads.push(name);
      if (name === state.failMethod) throw Error('RPC unavailable');
      return abi.encodeFunctionResult(name, [name === 'poolCount' ? state.count : state.paused]);
    },
  };
  const check = (type = 'factory', name = 'createPool', configured = old) =>
    verifyCreationCutover(provider, { targetType: type, factory: current }, { name }, block, configured, fail);
  return { state, provider, check };
}

test('explicit legacy cutover configuration rejects empty, zero and malformed addresses; missing config remains compatible', () => {
  assert.equal(legacyFactoryConfiguration(undefined), undefined);
  assert.equal(journalConfiguration({}).legacyFactory, undefined);
  assert.equal(journalConfiguration({ BEMINE_LEGACY_FACTORY: old }).legacyFactory, old);
  for (const value of ['', null, address(0), 'https://example.com', `${old},${current}`])
    assert.throws(() => journalConfiguration({ BEMINE_LEGACY_FACTORY: value }), /BEMINE_LEGACY_FACTORY/);
});

test('both core creation routes and budget creation require a paused empty legacy Factory at the exact preview block', async () => {
  for (const [kind, name] of [['factory', 'createPool'], ['factory', 'createFlexiblePoolChecked'], ['portfolioFactory', 'createPortfolio']]) {
    const f = fixture(); await f.check(kind, name);
    assert.deepEqual(f.state.reads.sort(), ['creationPaused', 'poolCount']);
    f.state.paused = false; await assert.rejects(f.check(kind, name), error => error.status === 409 && /尚未停建/.test(error.message));
    f.state.paused = true; f.state.count = 1n;
    await assert.rejects(f.check(kind, name), error => error.status === 409 && /已有项目/.test(error.message));
  }
});

test('legacy RPC failures, absent bytecode and a mistaken new-Factory address never imply a paused zero-pool deployment', async () => {
  const f = fixture();
  for (const name of ['poolCount', 'creationPaused']) {
    f.state.failMethod = name;
    await assert.rejects(f.check(), error => error.status === 503 && /无法核对/.test(error.message));
  }
  f.state.failMethod = null; f.state.code = '0x';
  await assert.rejects(f.check(), error => error.status === 503);
  await assert.rejects(f.check('factory', 'createPool', current), /迁移中/);
});

test('cutover errors leave user exit, orders, harvesting and recovery paths independent of the legacy RPC', async () => {
  const f = fixture(); f.state.failMethod = 'poolCount'; f.state.paused = false;
  for (const [kind, name] of [['pool', 'claim'], ['pool', 'withdrawBnb'], ['pool', 'withdrawDeposit'],
    ['pool', 'harvest'], ['pool', 'completeFirstoSale'], ['market', 'cancel'], ['market', 'withdrawBnb'],
    ['portfolio', 'claimBem'], ['portfolio', 'withdrawBnb'], ['portfolio', 'buyOfficial'], ['portfolioMarket', 'cancel']])
    await f.check(kind, name);
  await verifyCreationCutover(f.provider, { targetType: 'factory', factory: current }, { name: 'createPool' }, block, undefined, fail);
  assert.deepEqual(f.state.reads, []);
});
