import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Interface, ZeroAddress, getAddress } from 'ethers';

const artifactPath = fileURLToPath(new URL('../../public/deployment-artifacts.json', import.meta.url));
const artifacts = JSON.parse(await readFile(artifactPath, 'utf8'));
const interfaces = Object.freeze({
  factory: new Interface(artifacts.artifacts.PoolFactory.abi),
  market: new Interface(artifacts.artifacts.ShareMarket.abi),
  pool: new Interface(artifacts.artifacts.PoolVault.abi),
});
const binding = new Interface([
  'function shareMarket() view returns (address)',
  'function isPool(address) view returns (bool)',
  'function factory() view returns (address)',
  'function poolCount() view returns (uint256)',
  'function nextOrderId() view returns (uint256)',
]);
const indexedEvents = Object.freeze({
  factory: new Set(['PoolCreated']),
  market: new Set(['OrderListed', 'OrderExpirySet', 'OrderFilled', 'OrderCancelled', 'BnbWithdrawn']),
  pool: new Set(['Deposited', 'DepositWithdrawn', 'Funded', 'Failed', 'Purchased', 'AlternativeMinerSelected',
    'PurchaseSurplusSettled', 'Harvested', 'BemClaimed', 'BnbWithdrawn', 'Transfer', 'SaleProposed', 'Voted',
    'SaleListed', 'SaleCompleted', 'SaleExpired', 'SaleProceedsSettled', 'LockedSharesChanged',
    'FlexiblePurchaseConfigured', 'PurchaseModelLocked', 'PurchaseReferenceWeightLocked']),
});
const topicSets = Object.freeze(Object.fromEntries(Object.entries(interfaces).map(([kind, iface]) =>
  [kind, iface.fragments.filter(fragment => fragment.type === 'event' && indexedEvents[kind].has(fragment.name))
    .map(fragment => fragment.topicHash)])));

const exactAddress = value => {
  const address = getAddress(value);
  if (address === ZeroAddress) throw new Error('Zero contract address is forbidden.');
  return address.toLowerCase();
};
const integer = (value, label, minimum = 0) => {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${label}.`);
  return value;
};
const scalar = value => typeof value === 'bigint' ? value.toString()
  : typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) ? value.toLowerCase() : value;
const eventArgs = parsed => Object.fromEntries(parsed.fragment.inputs.map((input, i) => [input.name || `arg${i}`, scalar(parsed.args[i])]));
const lower = value => String(value).toLowerCase();
const normalizeBlock = block => {
  if (!block || !Number.isSafeInteger(block.number) || !Number.isSafeInteger(block.timestamp)
    || !/^0x[0-9a-f]{64}$/i.test(block.hash) || !/^0x[0-9a-f]{64}$/i.test(block.parentHash)) {
    throw new Error('RPC returned an invalid block header.');
  }
  return { number: block.number, hash: lower(block.hash), parentHash: lower(block.parentHash), timestamp: block.timestamp };
};

/** Read-only, event-sourced index. All amounts stay decimal strings; no transaction method is used. */
export class ChainIndex {
  constructor(provider, { dbPath, factory, market, startBlock, confirmations = 12, scanRange = 100, maxBlocksPerSync = 500 }) {
    if (!provider || typeof provider.getLogs !== 'function' || typeof provider.call !== 'function'
      || typeof provider.send !== 'function') throw new Error('Read-only provider required.');
    this.provider = provider;
    this.factory = exactAddress(factory);
    this.market = exactAddress(market);
    if (this.factory === this.market) throw new Error('Factory and market must differ.');
    this.startBlock = integer(startBlock, 'startBlock');
    this.confirmations = integer(confirmations, 'confirmations', 2);
    this.scanRange = integer(scanRange, 'scanRange', 1);
    this.maxBlocksPerSync = integer(maxBlocksPerSync, 'maxBlocksPerSync', 1);
    if (this.scanRange > 500 || this.maxBlocksPerSync > 2000) throw new Error('Scan bounds exceeded.');
    this.db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS headers (number INTEGER PRIMARY KEY, hash TEXT NOT NULL, parent_hash TEXT NOT NULL, timestamp INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS logs (
        block_number INTEGER NOT NULL, tx_index INTEGER NOT NULL, log_index INTEGER NOT NULL,
        tx_hash TEXT NOT NULL, address TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL,
        PRIMARY KEY (tx_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS logs_order ON logs(block_number, tx_index, log_index);
      CREATE INDEX IF NOT EXISTS logs_source ON logs(kind, address, block_number);
      CREATE INDEX IF NOT EXISTS logs_event ON logs(kind, name, block_number);
      CREATE TABLE IF NOT EXISTS pools (address TEXT PRIMARY KEY, created_block INTEGER NOT NULL, collection TEXT NOT NULL, circuit_id TEXT NOT NULL);`);
    const identity = JSON.stringify({ version: 1, chainId: 56, factory: this.factory, market: this.market, startBlock: this.startBlock });
    const saved = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('identity');
    if (saved && saved.value !== identity) { this.db.close(); throw new Error('Index database belongs to a different deployment.'); }
    if (!saved) {
      this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('identity', identity);
      this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('indexedThrough', String(this.startBlock - 1));
    }
    this.ready = false;
    this.lastError = null;
    this.observedSafeHead = null;
    this.checkedAt = null;
    this.syncing = false;
    this.cachedStats = null;
  }

  close() { this.db.close(); }
  get indexedThrough() { return Number(this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('indexedThrough').value); }
  _setIndexedThrough(number) { this.db.prepare('UPDATE metadata SET value = ? WHERE key = ?').run(String(number), 'indexedThrough'); }
  _header(number) { return this.db.prepare('SELECT number,hash,parent_hash AS parentHash,timestamp FROM headers WHERE number = ?').get(number); }

  status() {
    const indexedThrough = this.indexedThrough;
    const source = indexedThrough >= this.startBlock ? this._header(indexedThrough) : null;
    return {
      chainId: 56, factory: this.factory, market: this.market, startBlock: this.startBlock,
      confirmations: this.confirmations, indexedThrough, indexedBlockHash: source?.hash ?? null,
      indexedTimestamp: source?.timestamp ?? null, observedSafeHead: this.observedSafeHead,
      complete: this.ready && this.lastError === null && indexedThrough === this.observedSafeHead,
      checkedAt: this.checkedAt, unknownReason: this.lastError ?? (this.ready ? null : 'index_not_caught_up'),
    };
  }

  async _call(to, method, args, blockNumber) {
    const data = binding.encodeFunctionData(method, args);
    // ethers v6 call() takes the block tag inside the transaction request;
    // a second positional argument is ignored and would silently read latest.
    const result = await this.provider.call({ to, data, blockTag: blockNumber });
    return binding.decodeFunctionResult(method, result)[0];
  }

  async _verifyDeployment(blockNumber) {
    // Ask the RPC directly every sync; ethers' getNetwork() may cache a
    // configured chain ID and must not authorize a wrong-chain endpoint.
    const rawChainId = await this.provider.send('eth_chainId', []);
    if (!/^0x[0-9a-f]+$/i.test(rawChainId) || BigInt(rawChainId) !== 56n) {
      throw new Error('RPC is not BSC mainnet (56).');
    }
    const [factoryCode, marketCode, registeredMarket, marketFactory] = await Promise.all([
      this.provider.getCode(this.factory, blockNumber), this.provider.getCode(this.market, blockNumber),
      this._call(this.factory, 'shareMarket', [], blockNumber), this._call(this.market, 'factory', [], blockNumber),
    ]);
    if (factoryCode === '0x' || marketCode === '0x' || exactAddress(registeredMarket) !== this.market
      || exactAddress(marketFactory) !== this.factory) throw new Error('Factory/market code or binding mismatch.');
  }

  async _verifyHistoryComplete(blockNumber) {
    const [onchainPools, nextOrderId] = await Promise.all([
      this._call(this.factory, 'poolCount', [], blockNumber),
      this._call(this.market, 'nextOrderId', [], blockNumber),
    ]);
    const indexedPools = this.db.prepare('SELECT COUNT(*) AS count FROM pools').get().count;
    const indexedOrders = this.db.prepare("SELECT COUNT(*) AS count FROM logs WHERE kind = 'market' AND name = 'OrderListed'").get().count;
    if (onchainPools !== BigInt(indexedPools) || nextOrderId !== BigInt(indexedOrders) + 1n) {
      throw new Error('Event history is incomplete for the configured deployment start block.');
    }
  }

  _rollback(number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM logs WHERE block_number > ?').run(number);
      this.db.prepare('DELETE FROM pools WHERE created_block > ?').run(number);
      this.db.prepare('DELETE FROM headers WHERE number > ?').run(number);
      this._setIndexedThrough(number);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  async _reconcile() {
    let current = this.indexedThrough;
    if (current < this.startBlock) return;
    let checked = 0;
    while (current >= this.startBlock && checked < 2000) {
      const stored = this._header(current);
      if (!stored) throw new Error('Index header gap; rebuild the local database.');
      const chain = normalizeBlock(await this.provider.getBlock(current));
      if (stored.hash === chain.hash) break;
      current--; checked++;
    }
    // A deeper fork is rare but cannot trigger an unbounded RPC walk. Rebuild
    // from the reviewed deployment block, serving 503 until complete again.
    if (checked === 2000) current = this.startBlock - 1;
    if (current !== this.indexedThrough) this._rollback(current);
  }

  async _logs(kind, addresses, fromBlock, toBlock) {
    if (!addresses.length) return [];
    const all = [];
    for (let i = 0; i < addresses.length; i += 20) {
      const group = addresses.slice(i, i + 20);
      const found = await this.provider.getLogs({ address: group.length === 1 ? group[0] : group,
        fromBlock, toBlock, topics: [topicSets[kind]] });
      if (!Array.isArray(found) || found.length > 10_000) throw new Error('RPC event page exceeds the bound.');
      for (const log of found) {
        if (!group.includes(lower(log.address))) throw new Error('RPC returned a log from another contract.');
        const parsed = interfaces[kind].parseLog(log);
        if (!parsed || !indexedEvents[kind].has(parsed.name)) throw new Error('RPC returned an unrecognized event.');
        const logIndex = log.index ?? log.logIndex;
        const txIndex = log.transactionIndex;
        if (!Number.isSafeInteger(log.blockNumber) || !Number.isSafeInteger(logIndex) || !Number.isSafeInteger(txIndex)
          || !/^0x[0-9a-f]{64}$/i.test(log.transactionHash) || !/^0x[0-9a-f]{64}$/i.test(log.blockHash)) {
          throw new Error('RPC returned an invalid event identity.');
        }
        all.push({ blockNumber: log.blockNumber, txIndex, logIndex, txHash: lower(log.transactionHash),
          blockHash: lower(log.blockHash), address: lower(log.address), kind, name: parsed.name,
          args: eventArgs(parsed) });
      }
    }
    return all;
  }

  async _scanChunk(fromBlock, toBlock) {
    const headers = [];
    for (let number = fromBlock; number <= toBlock; ++number) {
      const header = normalizeBlock(await this.provider.getBlock(number));
      if (header.number !== number) throw new Error('RPC returned a different block number.');
      const parent = headers.at(-1) ?? this._header(number - 1);
      if (parent && header.parentHash !== parent.hash) throw new Error('Chain changed during header scan.');
      headers.push(header);
    }
    const factoryLogs = await this._logs('factory', [this.factory], fromBlock, toBlock);
    const marketLogs = await this._logs('market', [this.market], fromBlock, toBlock);
    const existing = this.db.prepare('SELECT address FROM pools').all().map(row => row.address);
    const created = [];
    for (const log of factoryLogs.filter(log => log.name === 'PoolCreated')) {
      const pool = exactAddress(log.args.pool);
      if (!existing.includes(pool) && !created.some(entry => entry.address === pool)) {
        if (!(await this._call(this.factory, 'isPool', [pool], toBlock))) throw new Error('Factory event is not registered on-chain.');
        created.push({ address: pool, createdBlock: log.blockNumber, collection: exactAddress(log.args.circuits), circuitId: log.args.circuitId });
      }
    }
    const poolLogs = await this._logs('pool', [...new Set([...existing, ...created.map(entry => entry.address)])], fromBlock, toBlock);
    const logs = [...factoryLogs, ...marketLogs, ...poolLogs].sort((a, b) => a.blockNumber - b.blockNumber || a.txIndex - b.txIndex || a.logIndex - b.logIndex);
    const hashes = new Map(headers.map(header => [header.number, header.hash]));
    const seen = new Set();
    for (const log of logs) {
      if (log.blockNumber < fromBlock || log.blockNumber > toBlock || hashes.get(log.blockNumber) !== log.blockHash) {
        throw new Error('RPC logs do not match canonical scanned headers.');
      }
      const key = `${log.txHash}:${log.logIndex}`;
      if (seen.has(key)) throw new Error('RPC returned duplicate log identity.');
      seen.add(key);
    }
    if (normalizeBlock(await this.provider.getBlock(toBlock)).hash !== headers.at(-1).hash) {
      throw new Error('Chain changed before index commit.');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insertHeader = this.db.prepare('INSERT INTO headers(number,hash,parent_hash,timestamp) VALUES(?,?,?,?)');
      const insertPool = this.db.prepare('INSERT INTO pools(address,created_block,collection,circuit_id) VALUES(?,?,?,?)');
      const insertLog = this.db.prepare('INSERT INTO logs(block_number,tx_index,log_index,tx_hash,address,kind,name,args) VALUES(?,?,?,?,?,?,?,?)');
      for (const header of headers) insertHeader.run(header.number, header.hash, header.parentHash, header.timestamp);
      for (const pool of created) insertPool.run(pool.address, pool.createdBlock, pool.collection, pool.circuitId);
      for (const log of logs) insertLog.run(log.blockNumber, log.txIndex, log.logIndex, log.txHash, log.address, log.kind, log.name, JSON.stringify(log.args));
      this._setIndexedThrough(toBlock);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  async sync() {
    if (this.syncing) throw new Error('Index sync already running.');
    this.syncing = true;
    this.ready = false;
    try {
      const latest = normalizeBlock(await this.provider.getBlock('latest'));
      const safeHead = latest.number - this.confirmations;
      if (safeHead < this.startBlock) throw new Error('Configured deployment block is not yet confirmed.');
      this.observedSafeHead = safeHead;
      await this._verifyDeployment(safeHead);
      // A shorter replacement chain cannot supply our old tip by number. Drop
      // that tail first, then compare the remaining stored headers normally.
      if (this.indexedThrough > safeHead) this._rollback(safeHead);
      await this._reconcile();
      const until = Math.min(safeHead, this.indexedThrough + this.maxBlocksPerSync);
      for (let from = this.indexedThrough + 1; from <= until; from += this.scanRange) {
        await this._scanChunk(from, Math.min(until, from + this.scanRange - 1));
      }
      if (this.indexedThrough >= this.startBlock) {
        const stored = this._header(this.indexedThrough);
        if (stored.hash !== normalizeBlock(await this.provider.getBlock(this.indexedThrough)).hash) {
          await this._reconcile();
          throw new Error('Chain changed after index commit; retry sync.');
        }
      }
      if (this.indexedThrough === safeHead) await this._verifyHistoryComplete(safeHead);
      this.lastError = null;
      this.checkedAt = new Date().toISOString();
      this.ready = this.indexedThrough === safeHead;
      return this.status();
    } catch (error) {
      // Status is public. Never echo provider errors, which may contain an RPC
      // URL with credentials or an upstream response body.
      this.lastError = error instanceof Error && error.message === 'RPC is not BSC mainnet (56).'
        ? 'wrong_chain' : error instanceof Error && error.message.startsWith('Event history is incomplete')
          ? 'incomplete_history' : 'sync_failed';
      this.checkedAt = new Date().toISOString();
      throw error;
    } finally { this.syncing = false; }
  }

  _allLogs({ kind, address, names, fromTimestamp } = {}) {
    const conditions = [], params = [];
    if (kind) { conditions.push('l.kind = ?'); params.push(kind); }
    if (address) { conditions.push('l.address = ?'); params.push(address); }
    if (names?.length) { conditions.push(`l.name IN (${names.map(() => '?').join(',')})`); params.push(...names); }
    if (fromTimestamp !== undefined) { conditions.push('h.timestamp >= ?'); params.push(fromTimestamp); }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    return this.db.prepare(`SELECT l.block_number AS blockNumber,l.tx_index AS txIndex,l.log_index AS logIndex,
      l.tx_hash AS txHash,l.address,l.kind,l.name,l.args FROM logs l
      JOIN headers h ON h.number = l.block_number${where} ORDER BY l.block_number,l.tx_index,l.log_index`)
      .all(...params).map(row => ({ ...row, args: JSON.parse(row.args) }));
  }

  _mergeLogs(...lists) {
    return lists.flat().sort((a, b) => a.blockNumber - b.blockNumber || a.txIndex - b.txIndex || a.logIndex - b.logIndex);
  }

  _registeredPool(value) {
    const pool = exactAddress(value);
    if (!this.db.prepare('SELECT 1 FROM pools WHERE address = ?').get(pool)) throw new Error('Pool is not registered in this indexed Factory.');
    return pool;
  }

  pools({ cursor = 0, limit = 20 } = {}) {
    integer(cursor, 'cursor'); integer(limit, 'limit', 1);
    if (limit > 50) throw new Error('Page limit exceeds 50.');
    const rows = this.db.prepare('SELECT address,created_block AS createdBlock,collection,circuit_id AS circuitId FROM pools ORDER BY created_block,address LIMIT ? OFFSET ?').all(limit + 1, cursor);
    return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? cursor + limit : null };
  }

  /** Historical totals only. No estimated production or current pool state is inferred from events. */
  stats() {
    const status = this.status();
    const cacheKey = `${status.indexedThrough}:${status.indexedBlockHash}`;
    if (this.cachedStats?.key === cacheKey) return this.cachedStats.value;
    const registeredPoolCount = this.db.prepare('SELECT COUNT(*) AS count FROM pools').get().count;
    const system = new Set([ZeroAddress.toLowerCase(), this.factory, this.market]);
    for (const row of this.db.prepare('SELECT address FROM pools').iterate()) system.add(row.address);
    const participants = new Set();
    let purchasedCost = 0n, marketGross = 0n, harvestedNet = 0n;
    const rows = this.db.prepare(`SELECT kind,name,args FROM logs WHERE
      (kind = 'pool' AND name IN ('Deposited','Transfer','Purchased','Harvested'))
      OR (kind = 'market' AND name = 'OrderFilled')`);
    for (const row of rows.iterate()) {
      const a = JSON.parse(row.args);
      if (row.name === 'Deposited' || row.name === 'Transfer') {
        const address = lower(row.name === 'Deposited' ? a.user : a.to);
        if (!system.has(address)) participants.add(address);
      } else if (row.name === 'Purchased') purchasedCost += BigInt(a.cost);
      else if (row.name === 'OrderFilled') marketGross += BigInt(a.gross);
      else if (row.name === 'Harvested') harvestedNet += BigInt(a.toMembers);
    }
    const value = { scope: 'confirmed_indexed_history', registeredPoolCount: String(registeredPoolCount),
      everParticipantAddressCount: String(participants.size), purchasedCostWei: purchasedCost.toString(),
      shareMarketFilledGrossWei: marketGross.toString(), harvestedToMembersBemAtomic: harvestedNet.toString(),
      estimatedDailyBemAtomic: null, currentlyActivePoolCount: null };
    this.cachedStats = { key: cacheKey, value };
    return value;
  }

  /** Ever-associated pools include holders who sold all shares but retain BEM/BNB rights. */
  accountPools(account, { cursor = 0, limit = 20 } = {}) {
    const wallet = exactAddress(account);
    integer(cursor, 'cursor'); integer(limit, 'limit', 1);
    if (limit > 50) throw new Error('Page limit exceeds 50.');
    const found = new Set();
    const orderPools = new Map();
    const history = this._mergeLogs(
      this._allLogs({ kind: 'pool', names: ['Deposited', 'DepositWithdrawn', 'Transfer', 'BemClaimed', 'BnbWithdrawn',
        'PurchaseSurplusSettled', 'SaleProceedsSettled', 'Voted', 'SaleProposed', 'LockedSharesChanged'] }),
      this._allLogs({ kind: 'market', names: ['OrderListed', 'OrderFilled'] }),
    );
    for (const event of history) {
      const a = event.args;
      if (event.kind === 'market' && event.name === 'OrderListed') orderPools.set(a.orderId, a.pool);
      if (event.kind === 'pool' && [a.user, a.member, a.proposer, a.voter, a.seller, a.buyer, a.from, a.to].some(value => value && lower(value) === wallet)) found.add(event.address);
      if (event.kind === 'market' && event.name === 'OrderListed' && a.seller === wallet) found.add(a.pool);
      if (event.kind === 'market' && event.name === 'OrderFilled' && a.buyer === wallet && orderPools.has(a.orderId)) found.add(orderPools.get(a.orderId));
    }
    const sorted = [...found].sort();
    return { items: sorted.slice(cursor, cursor + limit), nextCursor: cursor + limit < sorted.length ? cursor + limit : null };
  }

  orders({ pool, seller, active, cursor, limit = 20 } = {}) {
    const targetPool = pool === undefined ? null : exactAddress(pool);
    const targetSeller = seller === undefined ? null : exactAddress(seller);
    if (active !== undefined && typeof active !== 'boolean') throw new Error('Invalid active filter.');
    if (cursor !== undefined && !/^[1-9]\d*$/.test(String(cursor))) throw new Error('Invalid order cursor.');
    integer(limit, 'limit', 1); if (limit > 50) throw new Error('Page limit exceeds 50.');
    const orders = new Map();
    for (const event of this._allLogs({ kind: 'market', names: ['OrderListed', 'OrderExpirySet', 'OrderFilled', 'OrderCancelled'] })) {
      if (event.kind !== 'market') continue;
      const a = event.args;
      if (event.name === 'OrderListed') orders.set(a.orderId, { orderId: a.orderId, seller: a.seller, pool: a.pool,
        remaining: a.amount, pricePerUnitWei: a.pricePerUnit, expiresAt: null, listedBlock: event.blockNumber });
      else if (event.name === 'OrderExpirySet' && orders.has(a.orderId)) orders.get(a.orderId).expiresAt = a.expiresAt;
      else if (event.name === 'OrderFilled' && orders.has(a.orderId)) {
        const order = orders.get(a.orderId);
        if (BigInt(a.amount) > BigInt(order.remaining)) throw new Error('Indexed market fill exceeds the listed remainder.');
        order.remaining = (BigInt(order.remaining) - BigInt(a.amount)).toString();
      } else if (event.name === 'OrderCancelled' && orders.has(a.orderId)) orders.get(a.orderId).remaining = '0';
    }
    const at = this.status().indexedTimestamp;
    const filtered = [...orders.values()].map(order => ({ ...order,
      openAtSourceBlock: BigInt(order.remaining) > 0n && order.expiresAt !== null && Number(order.expiresAt) > at,
      executable: false, // Always re-read and simulate on-chain before a wallet signature.
    })).filter(order => (!targetPool || order.pool === targetPool) && (!targetSeller || order.seller === targetSeller)
      && (active === undefined || order.openAtSourceBlock === active)
      && (cursor === undefined || BigInt(order.orderId) < BigInt(cursor)))
      .sort((a, b) => BigInt(a.orderId) > BigInt(b.orderId) ? -1 : 1);
    return { items: filtered.slice(0, limit), nextCursor: filtered.length > limit ? filtered[limit - 1].orderId : null };
  }

  activity({ pool, account, cursor, limit = 20 } = {}) {
    const targetPool = pool === undefined ? null : exactAddress(pool);
    const targetAccount = account === undefined ? null : exactAddress(account);
    integer(limit, 'limit', 1); if (limit > 50) throw new Error('Page limit exceeds 50.');
    let cursorParts = null;
    if (cursor !== undefined) {
      if (!/^\d+:\d+:\d+$/.test(cursor)) throw new Error('Invalid activity cursor.');
      cursorParts = cursor.split(':').map(Number);
      cursorParts.forEach((n, i) => integer(n, `cursor${i}`));
    }
    const orderPools = new Map();
    const orderSellers = new Map();
    const items = [];
    const history = targetPool ? this._mergeLogs(this._allLogs({ kind: 'pool', address: targetPool }),
      this._allLogs({ kind: 'market' }), this._allLogs({ kind: 'factory' })) : this._allLogs();
    for (const event of history) {
      const a = event.args;
      if (event.kind === 'market' && event.name === 'OrderListed') { orderPools.set(a.orderId, a.pool); orderSellers.set(a.orderId, a.seller); }
      const eventPool = event.kind === 'pool' ? event.address
        : event.kind === 'factory' && event.name === 'PoolCreated' ? a.pool
          : orderPools.get(a.orderId) ?? null;
      if (targetPool && eventPool !== targetPool) continue;
      if (targetAccount && ![a.user, a.member, a.proposer, a.voter, a.seller, a.buyer, a.from, a.to, orderSellers.get(a.orderId)]
        .some(value => value && lower(value) === targetAccount)) continue;
      if (cursorParts && (event.blockNumber > cursorParts[0]
        || event.blockNumber === cursorParts[0] && (event.txIndex > cursorParts[1]
          || event.txIndex === cursorParts[1] && event.logIndex >= cursorParts[2]))) continue;
      const header = this._header(event.blockNumber);
      items.push({ blockNumber: event.blockNumber, blockHash: header.hash, timestamp: header.timestamp,
        transactionHash: event.txHash, transactionIndex: event.txIndex, logIndex: event.logIndex,
        contract: event.address, pool: eventPool, source: event.kind, event: event.name, fields: a });
    }
    items.reverse();
    const page = items.slice(0, limit);
    const last = page.at(-1);
    return { items: page, nextCursor: items.length > limit ? `${last.blockNumber}:${last.transactionIndex}:${last.logIndex}` : null };
  }

  /** Pool receipts and actual wallet claims are separate series; unclaimed individual accrual is unknown. */
  yieldCurve({ pool, account, days = 30 }) {
    const targetPool = this._registeredPool(pool);
    const targetAccount = account === undefined ? null : exactAddress(account);
    integer(days, 'days', 1); if (days > 90) throw new Error('Yield window exceeds 90 days.');
    const end = this.status().indexedTimestamp;
    const beijingDay = timestamp => new Date((timestamp + 8 * 3600) * 1000).toISOString().slice(0, 10);
    const lastDay = beijingDay(end);
    const buckets = new Map();
    for (let i = days - 1; i >= 0; --i) {
      const date = new Date(Date.parse(`${lastDay}T00:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10);
      buckets.set(date, { date, poolHarvestNetAtomic: '0', accountClaimedAtomic: targetAccount ? '0' : null });
    }
    const firstDay = [...buckets.keys()][0];
    const firstTimestamp = Math.floor(Date.parse(`${firstDay}T00:00:00Z`) / 1000) - 8 * 3600;
    for (const event of this._allLogs({ kind: 'pool', address: targetPool,
      names: ['Harvested', 'BemClaimed'], fromTimestamp: firstTimestamp })) {
      if (event.kind !== 'pool' || event.address !== targetPool) continue;
      const bucket = buckets.get(beijingDay(this._header(event.blockNumber).timestamp));
      if (!bucket) continue;
      if (event.name === 'Harvested') bucket.poolHarvestNetAtomic = (BigInt(bucket.poolHarvestNetAtomic) + BigInt(event.args.toMembers)).toString();
      if (targetAccount && event.name === 'BemClaimed' && event.args.user === targetAccount) {
        bucket.accountClaimedAtomic = (BigInt(bucket.accountClaimedAtomic) + BigInt(event.args.amount)).toString();
      }
    }
    return { scope: 'pool', pool: targetPool, account: targetAccount, timezone: 'Asia/Shanghai', token: 'BEM', tokenDecimals: 8,
      buckets: [...buckets.values()], accountUnclaimedDailyAccrual: null,
      note: 'Harvested is pool accounting time; BemClaimed is actual wallet payout. Historical unclaimed per-wallet daily accrual is not inferred.' };
  }
}

export const chainIndexInterfaces = interfaces;
