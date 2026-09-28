import assert from 'node:assert/strict';
import test from 'node:test';
import { AbiCoder, Interface, ZeroAddress, keccak256, toBeHex } from 'ethers';
import { inspectLegacyPools, REWARD_STORAGE_ROOT } from './legacy-pool-preflight.mjs';

const factory = '0x1111111111111111111111111111111111111111';
const poolA = '0x2222222222222222222222222222222222222222';
const poolB = '0x3333333333333333333333333333333333333333';
const alice = '0x4444444444444444444444444444444444444444';
const bem = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a';
const abi = AbiCoder.defaultAbiCoder();
const root = REWARD_STORAGE_ROOT;
const factoryAbi = new Interface(['function poolCount() view returns(uint256)', 'function allPools(uint256) view returns(address)',
  'function isPool(address) view returns(bool)']);
const poolAbi = new Interface(['function factory() view returns(address)', 'function expiryEnabled() view returns(bool)',
  'function accBemPerShare() view returns(uint256)', 'function bemAccounted() view returns(uint256)',
  'function epochNet(uint32) view returns(uint256)', 'function epochPaid(uint32) view returns(uint256)',
  'function epochBurned(uint32) view returns(uint256)',
  'function rewardSlot(address,uint8) view returns(uint32,uint256,uint256)',
  'function bemOwed(address) view returns(uint256)', 'function lastClaimAt(address) view returns(uint64)',
  'function balanceOf(address) view returns(uint256)', 'function totalSupply() view returns(uint256)',
  'function BEM() view returns(address)',
  'event Transfer(address indexed from,address indexed to,uint256 value)']);
const tokenAbi = new Interface(['function balanceOf(address) view returns(uint256)']);
const checkpointBase = BigInt(keccak256(toBeHex(root + 3n, 32)));
const mappedSlot = (type, key, offset) => BigInt(keccak256(abi.encode([type, 'uint256'], [key, root + BigInt(offset)])));

class ReadOnlyChain {
  constructor(pools = [poolA]) {
    this.pools = pools.map(x => x.toLowerCase());
    this.chainId = '0x38';
    this.head = 200;
    this.timestamp = 20 * 86400;
    this.storage = new Map();
    this.oldPools = new Set();
    this.migratedPools = new Set();
    this.badPublicAcc = false;
    this.epochLedger = new Map();
    for (const pool of this.pools) this.set(root, 1n, pool);
  }
  set(slot, value, contract = poolA) { this.storage.set(`${contract.toLowerCase()}:${toBeHex(slot, 32)}`, BigInt(value)); }
  makeLegacy(contract = poolA, epochs = [20], options = {}) {
    contract = contract.toLowerCase();
    this.oldPools.add(contract);
    this.set(root, 0n, contract);
    this.set(root + 1n, 1000n, contract);
    this.set(root + 3n, BigInt(epochs.length), contract);
    let remaining = 0n;
    for (let i = 0; i < epochs.length; i++) {
      this.set(checkpointBase + BigInt(i), (BigInt(i + 1) * 10n << 32n) | BigInt(epochs[i]), contract);
      const wasBurned = epochs[i] < (options.burnedBefore ?? 0);
      this.epochLedger.set(`${contract}:${epochs[i]}`, { net: 5n, paid: 0n, burned: wasBurned ? 5n : 0n });
      if (wasBurned) this.set(mappedSlot('uint256', epochs[i], 7), 1n, contract);
      else remaining += 5n;
    }
    this.set(root + 2n, remaining, contract);
    if (options.migrated) {
      this.oldPools.delete(contract);
      this.migratedPools.add(contract);
      this.set(root, 1n, contract);
      this.set(root + 17n, 1n, contract);
    }
  }
  async send(method) { assert.equal(method, 'eth_chainId'); return this.chainId; }
  async getBlock(tag) {
    const number = tag === 'latest' ? this.head : tag;
    return { number, hash: `0x${'a'.repeat(64)}`, timestamp: this.timestamp };
  }
  async getCode(contract, block) {
    const normalized = contract.toLowerCase();
    if (normalized === factory.toLowerCase()) return block >= 100 ? '0x6001' : '0x';
    if (normalized === bem.toLowerCase()) return '0x6003';
    if (this.pools.includes(normalized)) return block >= 130 ? '0x6002' : '0x';
    return '0x';
  }
  async getStorage(contract, slot, block) {
    assert.equal(block, 185);
    return toBeHex(this.storage.get(`${contract.toLowerCase()}:${toBeHex(BigInt(slot), 32)}`) ?? 0n, 32);
  }
  async call(tx) {
    assert.equal(tx.blockTag, 185);
    const to = tx.to.toLowerCase();
    const iface = to === factory.toLowerCase() ? factoryAbi : to === bem.toLowerCase() ? tokenAbi : poolAbi;
    const parsed = iface.parseTransaction({ data: tx.data });
    assert(parsed);
    const args = parsed.args;
    let answer;
    if (to === factory.toLowerCase()) {
      answer = parsed.name === 'poolCount' ? [this.pools.length]
        : parsed.name === 'allPools' ? [this.pools[Number(args[0])]] : [this.pools.includes(args[0].toLowerCase())];
    } else if (to === bem.toLowerCase()) answer = [this.storage.get(`${args[0].toLowerCase()}:${toBeHex(root + 2n, 32)}`) ?? 0n];
    else {
      switch (parsed.name) {
        case 'factory': answer = [factory]; break;
        case 'expiryEnabled': answer = [this.oldPools.has(to)]; break;
        case 'accBemPerShare': answer = [this.badPublicAcc ? 999n : this.storage.get(`${to}:${toBeHex(root + 1n, 32)}`) ?? 0n]; break;
        case 'bemAccounted': answer = [this.storage.get(`${to}:${toBeHex(root + 2n, 32)}`) ?? 0n]; break;
        case 'epochNet': case 'epochPaid': case 'epochBurned':
          answer = [this.epochLedger.get(`${to}:${Number(args[0])}`)?.[parsed.name.slice(5).toLowerCase()] ?? 0n]; break;
        case 'rewardSlot': answer = [0, 0, 0]; break;
        case 'bemOwed': case 'lastClaimAt': answer = [0n]; break;
        case 'balanceOf': answer = [args[0].toLowerCase() === alice.toLowerCase() ? 100n : 0n]; break;
        case 'totalSupply': answer = [100n]; break;
        case 'BEM': answer = [bem]; break;
        default: throw new Error(`Unexpected getter ${parsed.name}`);
      }
    }
    return iface.encodeFunctionResult(parsed.name, answer);
  }
  checkpoints(contract) { return Number(this.storage.get(`${contract.toLowerCase()}:${toBeHex(root + 3n, 32)}`) ?? 0n); }
  async getLogs(filter) {
    if (filter.fromBlock > 130 || filter.toBlock < 130) return [];
    const log = poolAbi.encodeEventLog(poolAbi.getEvent('Transfer'), [ZeroAddress, alice, 100n]);
    return [{ address: filter.address, blockNumber: 130, transactionIndex: 0, index: 0, ...log }];
  }
}

const opts = { factory, factoryCodehash: keccak256('0x6001'), fromBlock: 100 };

test('complete new-pool Factory produces only a scoped F04 no-blocker finding', async () => {
  const chain = new ReadOnlyChain([poolA, poolB]);
  const report = await inspectLegacyPools(chain, opts);
  assert.equal(report.chainId, 56);
  assert.equal(report.snapshotBlock, 185);
  assert.equal(report.coverageComplete, true);
  assert.equal(report.releaseGate, 'NO_F04_BLOCKER_FOUND');
  assert(report.pools.every(pool => pool.classification === 'no-legacy-expiry-evidence'));
});

test('old expiry pool is always blocked even when its current ledger passes the on-chain bounded check', async () => {
  const chain = new ReadOnlyChain();
  chain.makeLegacy();
  const report = await inspectLegacyPools(chain, opts);
  const pool = report.pools[0];
  assert.equal(report.releaseGate, 'BLOCKED');
  assert.equal(pool.classification, 'legacy-expiry-requires-reviewed-migration', pool.error);
  assert.equal(pool.legacyLedger.hypotheticalAutomaticCutoverCheck, true);
  assert.equal(pool.legacyLedger.historicalHolders[0].shares, '100');
  assert.equal(pool.legacyLedger.checkpoints[0].net, '5');
  assert.equal(pool.legacyLedger.bemBalance, '5');
});

test('65 checkpoints are reported as manual review, never auto-safe', async () => {
  const chain = new ReadOnlyChain();
  chain.timestamp = 84 * 86400;
  chain.makeLegacy(poolA, Array.from({ length: 65 }, (_, i) => i + 20));
  const report = await inspectLegacyPools(chain, opts);
  assert.equal(report.releaseGate, 'BLOCKED');
  assert.equal(report.pools[0].legacyLedger?.checkpointCount, 65, report.pools[0].error);
  assert.equal(report.pools[0].legacyLedger.hypotheticalAutomaticCutoverCheck, false);
});

test('64 checkpoints with older epochs already burned still require manual review', async () => {
  const chain = new ReadOnlyChain();
  chain.timestamp = 83 * 86400;
  chain.makeLegacy(poolA, Array.from({ length: 64 }, (_, i) => i + 20), { burnedBefore: 76 });
  const report = await inspectLegacyPools(chain, opts);
  assert.equal(report.releaseGate, 'BLOCKED');
  const ledger = report.pools[0].legacyLedger;
  assert.equal(ledger?.checkpointCount, 64, report.pools[0].error);
  assert.equal(ledger.outstanding, '40');
  assert.equal(ledger.hypotheticalAutomaticCutoverCheck, true);
  assert.equal(ledger.checkpoints[0].burned, '5');
});

test('previously migrated history and partial Factory coverage both block automatic release', async () => {
  const chain = new ReadOnlyChain([poolA, poolB]);
  chain.makeLegacy(poolA, [20], { migrated: true });
  const migrated = await inspectLegacyPools(chain, { ...opts, pools: [poolA] });
  assert.equal(migrated.coverageComplete, false);
  assert.equal(migrated.releaseGate, 'BLOCKED');
  assert.equal(migrated.pools[0].classification, 'legacy-history-requires-review', migrated.pools[0].error);
});

test('wrong chain, invalid source block, raw/getter mismatch, and unknown pool fail closed', async () => {
  const chain = new ReadOnlyChain();
  chain.chainId = '0x61';
  await assert.rejects(inspectLegacyPools(chain, opts), /not BSC mainnet/);
  chain.chainId = '0x38';
  await assert.rejects(inspectLegacyPools(chain, { ...opts, factoryCodehash: keccak256('0x6002') }), /differs from reviewed/);
  await assert.rejects(inspectLegacyPools(chain, { ...opts, fromBlock: 101 }), /Factory deployment block/);
  chain.badPublicAcc = true;
  const mismatch = await inspectLegacyPools(chain, opts);
  assert.equal(mismatch.releaseGate, 'BLOCKED');
  assert.equal(mismatch.pools[0].classification, 'unknown');
  await assert.rejects(inspectLegacyPools(chain, { ...opts, pools: [alice] }), /absent from Factory registry/);
});
