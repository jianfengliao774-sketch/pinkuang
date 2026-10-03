import { Interface, ZeroAddress, getAddress, toBeHex, toQuantity } from 'ethers';

const nft = new Interface(['function ownerOf(uint256) view returns(address)',
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']);
const mode = new Interface(['function flexiblePurchase() view returns(bool enabled,uint256 referenceCircuitId,(uint128 minVerifiedWeight,uint256 referencePriceWei,uint256 targetDailyYieldAtomic,uint16 extraBps,uint64 referenceObservedAt,uint64 referenceBlock,bytes32 referenceDigest) config)']);
const hash = value => /^0x[\da-f]{64}$/i.test(value ?? '');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const address = value => getAddress(value).toLowerCase();
const decimal = value => /^(0|[1-9]\d*)$/.test(String(value ?? '')) && BigInt(value) < (1n << 256n);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const funding = row => row.state === 0n || row.state === 1n;

async function boundedMap(items, work, concurrency = 4) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

/** Reconstruct the owner at PoolCreated, including transfers later in that same block. */
export function ownerAtCreation(blockEndOwner, transfers, creation, identity) {
  let owner = address(blockEndOwner);
  if (owner === ZeroAddress || !integer(creation.txIndex) || !integer(creation.logIndex))
    throw new Error('Creation owner ordering is unavailable.');
  const ordered = transfers.map(log => {
    if (log.removed || log.blockNumber !== identity.blockNumber || !same(log.blockHash, identity.blockHash)
      || !same(log.address, identity.collection) || !integer(log.transactionIndex)
      || !integer(log.index ?? log.logIndex) || !hash(log.transactionHash)
      || !Array.isArray(log.topics) || log.topics.length !== 4 || log.data !== '0x')
      throw new Error('Transfer evidence is not canonical.');
    const decoded = nft.parseLog(log);
    if (decoded?.name !== 'Transfer' || decoded.args.tokenId !== BigInt(identity.tokenId))
      throw new Error('Transfer evidence belongs to another target.');
    const encoded = nft.encodeEventLog(nft.getEvent('Transfer'), decoded.args);
    if (encoded.topics.some((topic, i) => !same(topic, log.topics[i])))
      throw new Error('Transfer evidence is not canonical.');
    return { from: address(decoded.args.from), to: address(decoded.args.to),
      txIndex: log.transactionIndex, logIndex: log.index ?? log.logIndex };
  }).sort((a, b) => a.logIndex - b.logIndex);
  if (new Set(ordered.map(log => log.logIndex)).size !== ordered.length
    || ordered.some((log, i) => i && log.txIndex < ordered[i - 1].txIndex)
    || ordered.some(log => log.logIndex === creation.logIndex
      || (log.logIndex > creation.logIndex) !== (log.txIndex > creation.txIndex
        || log.txIndex === creation.txIndex && log.logIndex > creation.logIndex)))
    throw new Error('Transfer evidence has invalid event ordering.');
  for (const log of ordered.filter(log => log.logIndex > creation.logIndex).reverse()) {
    if (owner !== log.to || log.from === ZeroAddress) throw new Error('Transfer owner chain is incomplete.');
    owner = log.from;
  }
  return owner;
}

/** Display-only evidence. No cancellation, refund, wallet operation or HTTP-triggered RPC. */
export class TargetAvailabilityTracker {
  constructor(index, provider, { timeoutMs = 6000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000)
      throw new Error('Invalid target availability timeout.');
    this.index = index; this.provider = provider; this.timeoutMs = timeoutMs;
    this.entries = new Map(); this.inFlight = new Map();
    this.ownerObservations = new Map(); this.observedBlockHash = null;
  }
  restore(saved) {
    if (saved?.schemaVersion !== 1 || !Array.isArray(saved.entries) || saved.entries.length > 500) return;
    for (const entry of saved.entries) {
      try {
        if (!integer(entry.createdBlock) || !hash(entry.createdBlockHash) || !decimal(entry.tokenId)
          || !['fixed', 'flexible'].includes(entry.purchaseMode)
          || entry.originalOwner !== null && address(entry.originalOwner) === ZeroAddress
          || entry.originalOwner !== null && (!integer(entry.creationTxIndex) || !integer(entry.creationLogIndex)
            || entry.creationOwnerProof !== 'block_end_owner_and_ordered_transfers')) continue;
        this.entries.set(address(entry.pool), { ...entry, pool: address(entry.pool), collection: address(entry.collection),
          originalOwner: entry.originalOwner === null ? null : address(entry.originalOwner) });
      } catch { /* A malformed cached baseline cannot prove a target unavailable. */ }
    }
  }
  persisted() { return { schemaVersion: 1, entries: [...this.entries.values()] }; }
  async read(key, work) {
    // Keep the underlying request until it settles, including after our bounded
    // wait expires, so overlapping captures cannot duplicate a stalled read.
    let task = this.inFlight.get(key);
    if (!task) {
      task = Promise.resolve().then(work);
      this.inFlight.set(key, task);
      task.finally(() => { if (this.inFlight.get(key) === task) this.inFlight.delete(key); }).catch(() => {});
    }
    let timer;
    try { return await Promise.race([task, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Target evidence timed out.')), this.timeoutMs);
    })]); } finally { clearTimeout(timer); }
  }
  async call(to, iface, name, args, block, blockHash, requests, historical = false) {
    const data = iface.encodeFunctionData(name, args), key = `${address(to)}:${data}:${blockHash}`;
    if (!requests.has(key)) requests.set(key, this.read(key, async () => {
      const send = historical && typeof this.provider.sendHistorical === 'function'
        ? this.provider.sendHistorical.bind(this.provider) : this.provider.send.bind(this.provider);
      const raw = await send('eth_call', [{ to, data }, toQuantity(block)]);
      const result = iface.decodeFunctionResult(name, raw);
      if (iface.encodeFunctionResult(name, result).toLowerCase() !== raw.toLowerCase())
        throw new Error('Target evidence is malformed.');
      return result;
    }));
    return requests.get(key);
  }
  creationEvents() {
    const result = new Map();
    for (const row of this.index.db.prepare("SELECT block_number,tx_index,log_index,args FROM logs WHERE kind='factory' AND name='PoolCreated'").iterate()) {
      try {
        const args = JSON.parse(row.args), pool = address(args.pool);
        const event = { block: row.block_number, txIndex: row.tx_index, logIndex: row.log_index,
          collection: address(args.circuits), tokenId: String(args.circuitId) };
        // Ambiguous creation identity is unknown, even when one row looks valid.
        result.set(pool, result.has(pool) ? null : event);
      } catch { /* Unrelated or malformed history is not a creation proof. */ }
    }
    return result;
  }
  async capture(rows, directory, source) {
    if (!same(this.observedBlockHash, source.indexedBlockHash)) {
      this.ownerObservations.clear(); this.observedBlockHash = source.indexedBlockHash;
    }
    const metadata = new Map(directory.map(item => [address(item.address), item]));
    for (const pool of this.entries.keys()) if (!metadata.has(pool)) this.entries.delete(pool);
    const requests = new Map(), pending = [], availability = new Map();
    let events;
    const base = (row, meta) => ({ status: 'unknown', purchaseMode: null, originalOwner: null, currentOwner: null,
      observedBlock: source.indexedThrough, observedBlockHash: source.indexedBlockHash,
      creationBlock: meta?.createdBlock ?? null, creationBlockHash: null, chainState: row.state,
      creationOwnerProof: null, reason: 'target_evidence_unavailable' });
    for (const row of rows) {
      const pool = address(row.pool), meta = metadata.get(pool), facts = base(row, meta);
      availability.set(pool, facts);
      if (!meta) { facts.status = 'not_applicable'; facts.reason = 'portfolio_child'; continue; }
      if (!funding(row)) { facts.status = 'not_applicable'; facts.reason = 'pool_not_funding'; continue; }
      const creationHash = this.index._header(meta.createdBlock)?.hash;
      if (!row.params || !integer(meta.createdBlock) || meta.createdBlock > source.indexedThrough
        || !hash(creationHash) || !decimal(meta.circuitId) || !same(meta.collection, row.params.circuits)
        || BigInt(meta.circuitId) !== row.params.circuitId) { facts.reason = 'creation_identity_unverified'; continue; }
      facts.creationBlockHash = creationHash;
      const identity = { pool, collection: address(meta.collection), tokenId: String(meta.circuitId),
        createdBlock: meta.createdBlock, createdBlockHash: creationHash };
      let entry = this.entries.get(pool);
      if (entry && (!same(entry.collection, identity.collection) || entry.tokenId !== identity.tokenId
        || entry.createdBlock !== identity.createdBlock || !same(entry.createdBlockHash, creationHash))) {
        this.entries.delete(pool); entry = null;
      }
      pending.push({ row, identity, facts, entry: entry ? { ...entry } : { ...identity, purchaseMode: null,
        originalOwner: null, creationOwnerProof: null }, changed: false });
    }
    await boundedMap(pending, async item => {
      const { identity, entry, facts } = item;
      try {
        if (!entry.purchaseMode) {
          const [enabled] = await this.call(identity.pool, mode, 'flexiblePurchase', [], identity.createdBlock,
            identity.createdBlockHash, requests, true);
          entry.purchaseMode = enabled ? 'flexible' : 'fixed'; item.changed = true;
        }
        facts.purchaseMode = entry.purchaseMode;
        if (entry.purchaseMode === 'flexible') { facts.status = 'not_applicable'; facts.reason = 'flexible_reference'; }
      } catch { facts.reason = 'purchase_mode_unverified'; }
    });
    const needOriginal = pending.filter(item => item.entry.purchaseMode === 'fixed' && !item.entry.originalOwner);
    if (needOriginal.length) events = this.creationEvents();
    const groups = new Map();
    for (const item of needOriginal) {
      const { identity, facts } = item, event = events.get(identity.pool);
      if (!event || event.block !== identity.createdBlock || !integer(event.txIndex) || !integer(event.logIndex)
        || !same(event.collection, identity.collection) || event.tokenId !== identity.tokenId) {
        facts.reason = 'creation_event_unverified'; continue;
      }
      item.creation = event;
      const key = `${identity.collection}:${identity.createdBlockHash}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    await boundedMap([...groups.values()], async group => {
      const identity = group[0].identity, tokenTopics = [...new Set(group.map(item => toBeHex(BigInt(item.identity.tokenId), 32)))].sort();
      try {
        const key = `transfers:${identity.collection}:${identity.createdBlockHash}:${tokenTopics.join(',')}`;
        const logs = await this.read(key, () => this.provider.getLogs({ address: identity.collection,
          fromBlock: identity.createdBlock, toBlock: identity.createdBlock,
          topics: [nft.getEvent('Transfer').topicHash, null, null, tokenTopics] }));
        if (!Array.isArray(logs) || logs.length > 10_000) throw new Error('Transfer evidence exceeds its bound.');
        // Every returned row must belong to the exact requested token set.
        if (logs.some(log => !Array.isArray(log.topics) || !tokenTopics.some(topic => same(topic, log.topics[3]))))
          throw new Error('Transfer evidence belongs to another target.');
        await boundedMap(group, async item => {
          try {
            const [owner] = await this.call(item.identity.collection, nft, 'ownerOf', [BigInt(item.identity.tokenId)],
              item.identity.createdBlock, item.identity.createdBlockHash, requests, true);
            item.entry.originalOwner = ownerAtCreation(owner,
              logs.filter(log => same(log.topics[3], toBeHex(BigInt(item.identity.tokenId), 32))), item.creation,
              { collection: item.identity.collection, tokenId: item.identity.tokenId,
                blockNumber: item.identity.createdBlock, blockHash: item.identity.createdBlockHash });
            item.entry.creationTxIndex = item.creation.txIndex; item.entry.creationLogIndex = item.creation.logIndex;
            item.entry.creationOwnerProof = 'block_end_owner_and_ordered_transfers'; item.changed = true;
          } catch { item.facts.reason = 'creation_owner_unverified'; }
        });
      } catch { group.forEach(item => { item.facts.reason = 'creation_transfers_unverified'; }); }
    });
    // Seeded mode/owner evidence is committed only after its historical block
    // matches the canonical local prefix. Existing entries need only that
    // local prefix check; the enclosing display pass proves its current tip.
    const seedHeaders = new Map();
    await boundedMap(pending.filter(item => item.changed), async item => {
      const { identity } = item;
      if (!seedHeaders.has(identity.createdBlock)) seedHeaders.set(identity.createdBlock,
        this.read(`header:${identity.createdBlockHash}`, () => this.provider.getBlock(identity.createdBlock)));
      try {
        const header = await seedHeaders.get(identity.createdBlock);
        if (!same(header?.hash, identity.createdBlockHash)
          || !same(this.index._header(identity.createdBlock)?.hash, identity.createdBlockHash))
          throw new Error('Creation block changed.');
        this.entries.set(identity.pool, item.entry);
      } catch {
        item.entry.purchaseMode = null; item.entry.originalOwner = null; item.entry.creationOwnerProof = null;
        Object.assign(item.facts, { status: 'unknown', purchaseMode: null, reason: 'creation_block_unverified' });
      }
    });
    await boundedMap(pending, async item => {
      const { identity, entry, facts } = item;
      facts.originalOwner = entry.originalOwner; facts.creationOwnerProof = entry.creationOwnerProof;
      if (entry.purchaseMode !== 'fixed' || !entry.originalOwner) return;
      try {
        const key = `${identity.collection}:${identity.tokenId}:${source.indexedBlockHash}`;
        const observation = this.ownerObservations.get(key);
        const owner = observation?.blockNumber === source.indexedThrough ? observation.owner
          : (await this.call(identity.collection, nft, 'ownerOf', [BigInt(identity.tokenId)],
            source.indexedThrough, source.indexedBlockHash, requests))[0];
        facts.currentOwner = address(owner);
        if (facts.currentOwner === ZeroAddress) throw new Error('Target owner is invalid.');
        // Only successful exact-block observations are reusable. An RPC failure
        // stays retryable, and another hash at the same height clears all hits.
        if (observation?.blockNumber !== source.indexedThrough) {
          if (this.ownerObservations.size >= 500) this.ownerObservations.delete(this.ownerObservations.keys().next().value);
          this.ownerObservations.set(key, { owner: facts.currentOwner, blockNumber: source.indexedThrough });
        }
        if (same(owner, identity.pool)) { facts.status = 'not_applicable'; facts.reason = 'target_owned_by_pool'; }
        else if (same(owner, entry.originalOwner)) { facts.status = 'available'; facts.reason = 'owner_unchanged'; }
        else { facts.status = 'unavailable'; facts.reason = 'target_owner_changed'; }
      } catch { facts.status = 'unknown'; facts.currentOwner = null; facts.reason = 'current_owner_unverified'; }
    });
    return availability;
  }
}
