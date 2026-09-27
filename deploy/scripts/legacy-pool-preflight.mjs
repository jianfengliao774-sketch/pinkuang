import { AbiCoder, Interface, ZeroAddress, getAddress, keccak256, toBeHex } from 'ethers';

// PoolRewardState.REWARD_STORAGE_LOCATION and its delivered append-only layout.
// Read-only storage inspection is cross-checked against public getters below.
export const REWARD_STORAGE_ROOT = 0xbe2e6742b44a407aefa2f874e2465ec804b9b29179760a8ce2b26da776718500n;
const BEM = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a';
const ZERO = ZeroAddress.toLowerCase();
const DAY = 86400;
const MAX_POOLS = 1000;
const MAX_CHECKPOINTS = 4096;
const MAX_HOLDERS = 10000;
const MAX_LOGS = 100000;
const abi = AbiCoder.defaultAbiCoder();
const factoryAbi = new Interface([
  'function poolCount() view returns(uint256)', 'function allPools(uint256) view returns(address)',
  'function isPool(address) view returns(bool)',
]);
const poolAbi = new Interface([
  'function factory() view returns(address)', 'function expiryEnabled() view returns(bool)',
  'function accBemPerShare() view returns(uint256)', 'function bemAccounted() view returns(uint256)',
  'function epochNet(uint32) view returns(uint256)', 'function epochPaid(uint32) view returns(uint256)',
  'function epochBurned(uint32) view returns(uint256)', 'function rewardSlot(address,uint8) view returns(uint32,uint256,uint256)',
  'function bemOwed(address) view returns(uint256)', 'function lastClaimAt(address) view returns(uint64)',
  'function balanceOf(address) view returns(uint256)', 'function totalSupply() view returns(uint256)',
  'function BEM() view returns(address)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const tokenAbi = new Interface(['function balanceOf(address) view returns(uint256)']);
const transferTopic = poolAbi.getEvent('Transfer').topicHash;

function address(value) {
  const normalized = getAddress(value).toLowerCase();
  if (normalized === ZERO) throw new Error('Zero address is not a deployment address.');
  return normalized;
}

function safeInteger(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}.`);
  return value;
}

function at(root, offset) { return toBeHex(root + BigInt(offset), 32); }
function mappedSlot(type, key, root, offset) {
  return BigInt(keccak256(abi.encode([type, 'uint256'], [key, root + BigInt(offset)])));
}
async function word(provider, contract, location, block) {
  const value = await provider.getStorage(contract, toBeHex(location, 32), block);
  if (!/^0x[0-9a-f]{64}$/i.test(value)) throw new Error('Invalid storage word from RPC.');
  return BigInt(value);
}
async function read(provider, contract, iface, method, args, block) {
  const result = await provider.call({ to: contract, data: iface.encodeFunctionData(method, args), blockTag: block });
  return iface.decodeFunctionResult(method, result)[0];
}
async function codeHash(provider, contract, block) {
  const code = await provider.getCode(contract, block);
  if (!/^0x(?:[0-9a-f]{2})+$/i.test(code)) throw new Error(`Missing contract code: ${contract}.`);
  return keccak256(code);
}

async function holdersFromTransfers(provider, pool, firstBlock, block, scanRange) {
  const users = new Set();
  const balances = new Map();
  let minted = 0n;
  let burned = 0n;
  let lastPosition = [-1, -1, -1];
  let logCount = 0;
  for (let fromBlock = firstBlock; fromBlock <= block; fromBlock += scanRange) {
    const toBlock = Math.min(block, fromBlock + scanRange - 1);
    const logs = await provider.getLogs({ address: pool, topics: [transferTopic], fromBlock, toBlock });
    if (!Array.isArray(logs) || (logCount += logs.length) > MAX_LOGS) throw new Error('Transfer log scan exceeded its bound.');
    for (const log of logs) {
      if (address(log.address) !== pool || log.blockNumber < fromBlock || log.blockNumber > toBlock) {
        throw new Error('Transfer log source/range mismatch.');
      }
      const parsed = poolAbi.parseLog(log);
      if (!parsed || parsed.name !== 'Transfer') throw new Error('Unexpected Transfer log.');
      const index = log.index ?? log.logIndex;
      const position = [log.blockNumber, log.transactionIndex, index];
      if (!position.every(Number.isSafeInteger) || position.some(x => x < 0)
        || position[0] < lastPosition[0]
        || (position[0] === lastPosition[0] && (position[1] < lastPosition[1]
          || (position[1] === lastPosition[1] && position[2] <= lastPosition[2])))) {
        throw new Error('Transfer logs are unordered or have invalid identity.');
      }
      lastPosition = position;
      const from = getAddress(parsed.args.from).toLowerCase();
      const to = getAddress(parsed.args.to).toLowerCase();
      const amount = parsed.args.value;
      if (from === ZERO) minted += amount;
      else {
        users.add(from);
        const held = balances.get(from) ?? 0n;
        if (held < amount) throw new Error('Transfer history has a negative share balance.');
        balances.set(from, held - amount);
      }
      if (to === ZERO) burned += amount;
      else {
        users.add(to);
        balances.set(to, (balances.get(to) ?? 0n) + amount);
      }
      if (users.size > MAX_HOLDERS) throw new Error('Historical holder scan exceeded its bound.');
    }
  }
  return { users: [...users].sort(), balances, reconstructedSupply: minted - burned, logCount };
}

async function creationBlock(provider, pool, fromBlock, block) {
  let lo = fromBlock;
  let hi = block;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const code = await provider.getCode(pool, mid);
    if (code === '0x') lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && await provider.getCode(pool, lo - 1) !== '0x') {
    throw new Error('Cannot prove the pool creation block.');
  }
  return lo;
}

async function inspectLegacyLedger(provider, pool, block, blockTimestamp, fromBlock, scanRange, base) {
  const checkpointLength = await word(provider, pool, base.root + 3n, block);
  if (checkpointLength > MAX_CHECKPOINTS) throw new Error('Checkpoint scan exceeded its bound.');
  const count = Number(checkpointLength);
  const checkpointBase = BigInt(keccak256(at(base.root, 3)));
  const checkpoints = [];
  let priorEpoch = -1;
  let outstanding = 0n;
  let overdue = false;
  const currentEpoch = Math.floor(blockTimestamp / DAY);
  for (let i = 0; i < count; i++) {
    const packed = await word(provider, pool, checkpointBase + BigInt(i), block);
    const epoch = Number(packed & 0xffffffffn);
    const acc = packed >> 32n;
    if (epoch <= priorEpoch || epoch > currentEpoch || acc > base.acc) {
      throw new Error('Checkpoint ordering/epoch/accumulator mismatch.');
    }
    priorEpoch = epoch;
    const [net, paid, burned, flagWord] = await Promise.all([
      read(provider, pool, poolAbi, 'epochNet', [epoch], block),
      read(provider, pool, poolAbi, 'epochPaid', [epoch], block),
      read(provider, pool, poolAbi, 'epochBurned', [epoch], block),
      word(provider, pool, mappedSlot('uint256', epoch, base.root, 7), block),
    ]);
    if (paid > net || flagWord > 1n) throw new Error('Invalid epoch ledger.');
    const burnedFlag = flagWord === 1n;
    const unpaid = burnedFlag ? 0n : net - paid;
    outstanding += unpaid;
    if (unpaid !== 0n && epoch < currentEpoch - 7) overdue = true;
    checkpoints.push({ epoch, acc: acc.toString(), net: net.toString(), paid: paid.toString(),
      burned: burned.toString(), burnedFlag, unpaid: unpaid.toString() });
  }

  const firstBlock = await creationBlock(provider, pool, fromBlock, block);
  const { users, balances, reconstructedSupply, logCount } = await holdersFromTransfers(provider, pool, firstBlock, block, scanRange);
  const historicalHolders = [];
  let shareSum = 0n;
  for (const member of users) {
    const userBase = mappedSlot('address', member, base.root, 8);
    const [shares, debtAcc, owed, remainder, lastClaimAt] = await Promise.all([
      read(provider, pool, poolAbi, 'balanceOf', [member], block),
      word(provider, pool, userBase, block), word(provider, pool, userBase + 1n, block),
      word(provider, pool, userBase + 2n, block), word(provider, pool, userBase + 3n, block),
    ]);
    const [publicOwed, publicLastClaim] = await Promise.all([
      read(provider, pool, poolAbi, 'bemOwed', [member], block),
      read(provider, pool, poolAbi, 'lastClaimAt', [member], block),
    ]);
    if (publicOwed !== owed || publicLastClaim !== lastClaimAt) throw new Error('Raw/public user ledger mismatch.');
    if (shares !== balances.get(member)) throw new Error('Transfer history disagrees with member balance.');
    shareSum += shares;
    const slots = [];
    for (let index = 0; index < 8; index++) {
      const [epoch, amount, fraction] = await provider.call({
        to: pool, data: poolAbi.encodeFunctionData('rewardSlot', [member, index]), blockTag: block,
      }).then(result => poolAbi.decodeFunctionResult('rewardSlot', result));
      slots.push({ epoch: Number(epoch), amount: amount.toString(), remainder: fraction.toString() });
    }
    historicalHolders.push({ address: member, shares: shares.toString(), debtAcc: debtAcc.toString(),
      owed: owed.toString(), globalRemainder: remainder.toString(), lastClaimAt: lastClaimAt.toString(), slots });
  }
  const totalSupply = await read(provider, pool, poolAbi, 'totalSupply', [], block);
  if (shareSum !== totalSupply || reconstructedSupply !== totalSupply) {
    throw new Error('Transfer history does not explain total supply.');
  }
  const bemAddress = address(await read(provider, pool, poolAbi, 'BEM', [], block));
  if (bemAddress !== BEM.toLowerCase()) throw new Error('Unexpected BEM token binding.');
  const bemCodehash = await codeHash(provider, bemAddress, block);
  const bemBalance = await read(provider, bemAddress, tokenAbi, 'balanceOf', [pool], block);
  if (bemBalance < base.bemAccounted) throw new Error('BEM balance is below accounted liability.');
  const totals = {};
  for (const [label, offset] of Object.entries({ gross: 9, platform: 10, baseBurned: 11,
    memberNet: 12, memberPaid: 13, expiredBurned: 14, globalRemainderScaled: 16 })) {
    totals[label] = (await word(provider, pool, base.root + BigInt(offset), block)).toString();
  }
  return { checkpointCount: count, checkpoints, currentEpoch, outstanding: outstanding.toString(),
    overdue, accountedMatchesOutstanding: outstanding === base.bemAccounted,
    hypotheticalAutomaticCutoverCheck: count <= 64 && !overdue && outstanding === base.bemAccounted,
    poolCreatedBlock: firstBlock, transferLogCount: logCount, totalSupply: totalSupply.toString(),
    historicalHolders, bemAddress, bemCodehash, bemBalance: bemBalance.toString(), totals };
}

async function inspectPool(provider, pool, factory, block, timestamp, fromBlock, scanRange) {
  const result = { address: pool, classification: 'unknown', manualReviewRequired: true };
  try {
    result.codehash = await codeHash(provider, pool, block);
    const [registered, boundFactory, expiryEnabled, publicAcc, publicAccounted] = await Promise.all([
      read(provider, factory, factoryAbi, 'isPool', [pool], block),
      read(provider, pool, poolAbi, 'factory', [], block),
      read(provider, pool, poolAbi, 'expiryEnabled', [], block),
      read(provider, pool, poolAbi, 'accBemPerShare', [], block),
      read(provider, pool, poolAbi, 'bemAccounted', [], block),
    ]);
    if (!registered || address(boundFactory) !== factory) throw new Error('Pool/Factory registration mismatch.');
    const root = REWARD_STORAGE_ROOT;
    const [flags, acc, accounted, migrationWord] = await Promise.all([
      word(provider, pool, root, block), word(provider, pool, root + 1n, block),
      word(provider, pool, root + 2n, block), word(provider, pool, root + 17n, block),
    ]);
    const expiryByte = flags & 0xffn;
    const configuredByte = (flags >> 8n) & 0xffn;
    const migrationByte = migrationWord & 0xffn;
    if (expiryByte > 1n || configuredByte > 1n || migrationByte > 1n) {
      throw new Error('Invalid packed reward flags.');
    }
    const rawExpiryDisabled = expiryByte === 1n;
    const migrationStarted = migrationByte === 1n;
    if (expiryEnabled === rawExpiryDisabled || acc !== publicAcc || accounted !== publicAccounted) {
      throw new Error('Raw/public reward state mismatch.');
    }
    result.expiryEnabled = expiryEnabled;
    result.migrationStarted = migrationStarted;
    result.accBemPerShare = acc.toString();
    result.bemAccounted = accounted.toString();
    result.checkpointCount = Number(await word(provider, pool, root + 3n, block));
    if (!Number.isSafeInteger(result.checkpointCount) || result.checkpointCount > MAX_CHECKPOINTS) {
      throw new Error('Checkpoint count exceeds inspection bound.');
    }
    if (expiryEnabled || migrationStarted || result.checkpointCount > 0) {
      result.classification = expiryEnabled ? 'legacy-expiry-requires-reviewed-migration' : 'legacy-history-requires-review';
      result.legacyLedger = await inspectLegacyLedger(provider, pool, block, timestamp, fromBlock, scanRange,
        { root, acc, bemAccounted: accounted });
    } else {
      result.classification = 'no-legacy-expiry-evidence';
      result.manualReviewRequired = false;
    }
  } catch (error) {
    result.classification = 'unknown';
    result.manualReviewRequired = true;
    // RPC errors may embed an authenticated endpoint; report only their code.
    result.error = error?.code ? `RPC/ABI read failed (${error.code})` : String(error?.message ?? error)
      .replace(/https?:\/\/[^\s"']+/gi, '[RPC endpoint]');
  }
  return result;
}

/** No signer, transaction, simulation override, or wallet method is accepted. */
export async function inspectLegacyPools(provider, options) {
  if (!provider || !['send', 'getBlock', 'getCode', 'getStorage', 'getLogs', 'call'].every(
    method => typeof provider[method] === 'function')) throw new Error('A read-only JSON-RPC provider is required.');
  const factory = address(options.factory);
  const expectedFactoryCodehash = String(options.factoryCodehash ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(expectedFactoryCodehash)) {
    throw new Error('Reviewed Factory proxy codehash is required.');
  }
  const fromBlock = safeInteger(options.fromBlock, 'factory creation block', 1, Number.MAX_SAFE_INTEGER);
  const confirmations = safeInteger(options.confirmations ?? 15, 'confirmations', 12, 10000);
  const scanRange = safeInteger(options.scanRange ?? 10000, 'scan range', 1, 100000);
  const rawChain = await provider.send('eth_chainId', []);
  if (!/^0x[0-9a-f]+$/i.test(rawChain) || BigInt(rawChain) !== 56n) throw new Error('RPC is not BSC mainnet (chainId 56).');
  const latest = await provider.getBlock('latest');
  if (!latest || !Number.isSafeInteger(latest.number) || latest.number <= fromBlock + confirmations) {
    throw new Error('No sufficiently confirmed BSC block is available.');
  }
  const block = latest.number - confirmations;
  const header = await provider.getBlock(block);
  if (!header || !/^0x[0-9a-f]{64}$/i.test(header.hash) || !Number.isSafeInteger(header.timestamp)) {
    throw new Error('Cannot pin a confirmed block hash.');
  }
  if (await provider.getCode(factory, fromBlock - 1) !== '0x') {
    throw new Error('--from-block must be the Factory deployment block (archive RPC required).');
  }
  const factoryCodehash = await codeHash(provider, factory, fromBlock);
  if (factoryCodehash.toLowerCase() !== expectedFactoryCodehash) {
    throw new Error('Factory proxy codehash differs from reviewed deployment evidence.');
  }
  if (factoryCodehash !== await codeHash(provider, factory, block)) {
    throw new Error('Factory proxy code changed across the requested history.');
  }
  const count = await read(provider, factory, factoryAbi, 'poolCount', [], block);
  if (count > MAX_POOLS) throw new Error('Factory pool count exceeds inspection bound.');
  const registry = [];
  for (let i = 0; i < Number(count); i++) registry.push(address(await read(provider, factory, factoryAbi, 'allPools', [i], block)));
  if (new Set(registry).size !== registry.length) throw new Error('Factory contains duplicate pool addresses.');
  const requested = options.pools ? options.pools.map(address) : registry;
  if (new Set(requested).size !== requested.length) throw new Error('Duplicate pool in requested set.');
  if (requested.some(pool => !registry.includes(pool))) throw new Error('Requested pool is absent from Factory registry.');
  const coverageComplete = requested.length === registry.length;
  const pools = [];
  for (const pool of requested) pools.push(await inspectPool(provider, pool, factory, block, header.timestamp, fromBlock, scanRange));
  const finalHeader = await provider.getBlock(block);
  if (!finalHeader || finalHeader.hash.toLowerCase() !== header.hash.toLowerCase()) {
    throw new Error('Snapshot block was reorganized during inspection.');
  }
  const blocked = !coverageComplete || pools.some(pool => pool.manualReviewRequired);
  return { schemaVersion: 1, readOnly: true, chainId: 56, factory, factoryCodehash,
    factoryDeploymentBlock: fromBlock, snapshotBlock: block, snapshotBlockHash: header.hash.toLowerCase(),
    snapshotTimestamp: header.timestamp, confirmations, registryPoolCount: registry.length,
    inspectedPoolCount: pools.length, coverageComplete, releaseGate: blocked ? 'BLOCKED' : 'NO_F04_BLOCKER_FOUND',
    note: 'No result authorizes an upgrade; upgrade bytecode, storage layout, cutover and governance still require independent review.',
    pools };
}
