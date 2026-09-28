import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Interface, ZeroAddress, getAddress } from 'ethers';
import { notificationPage } from './notifications.mjs';

const artifactPath = fileURLToPath(new URL('../../public/deployment-artifacts.json', import.meta.url));
const artifacts = JSON.parse(await readFile(artifactPath, 'utf8'));
const interfaces = Object.freeze({
  factory: new Interface(artifacts.artifacts.PoolFactory.abi),
  market: new Interface(artifacts.artifacts.ShareMarket.abi),
  pool: new Interface(artifacts.artifacts.PoolVault.abi),
  portfolioFactory: new Interface(['event PortfolioCreated(address indexed portfolio,uint256 budgetWei,uint256 absoluteCapWei,uint256 unitCapWei)']),
  portfolioMarket: new Interface(artifacts.artifacts.ShareMarket.abi),
  portfolio: new Interface(artifacts.artifacts.BudgetPortfolioVault?.abi ?? [
    'event Transfer(address indexed from,address indexed to,uint256 value)',
    'event Deposited(address indexed member,uint8 shares,uint256 amount)',
    'event ChildPurchased(address indexed child,address indexed collection,uint256 indexed tokenId,uint256 cost,bool official)',
    'event AcquisitionFinalized(uint256 spent,uint256 officialFee,uint256 refundableToMembers,uint256 roundingWei,uint256 children)',
    'event BemCollected(address indexed child,uint256 received)', 'event ChildHarvestFailed(address indexed child,bytes32 reasonHash)',
    'event BemClaimed(address indexed member,uint256 amount)', 'event BnbWithdrawn(address indexed member,uint256 amount)',
    'event ChildSaleProposed(uint256 indexed proposalId,address indexed child,uint256 price,uint64 endsAt)',
    'event ChildSaleVoted(uint256 indexed proposalId,address indexed member,bool support,uint256 shares)',
    'event ChildSaleApproved(uint256 indexed proposalId,address indexed child)',
    'event ChildSaleSettled(address indexed child,uint256 netProceeds)', 'event ChildSaleExpired(uint256 indexed proposalId)',
  ]),
});
const binding = new Interface([
  'function shareMarket() view returns (address)',
  'function isPool(address) view returns (bool)',
  'function factory() view returns (address)',
  'function poolCount() view returns (uint256)',
  'function nextOrderId() view returns (uint256)',
  'function legacyFactory() view returns(address)', 'function OFFICIAL_FACTORY() view returns(address)',
  'function portfolioCount() view returns(uint256)', 'function childCount() view returns(uint256)',
  'function childInfo(address) view returns(address collection,uint256 tokenId,uint256 purchaseCost,bool official,bool sold)',
]);
const indexedEvents = Object.freeze({
  factory: new Set(['PoolCreated']),
  market: new Set(['OrderListed', 'OrderExpirySet', 'OrderFilled', 'BuyerFeeCharged', 'OrderCancelled', 'BnbWithdrawn']),
  portfolioFactory: new Set(['PortfolioCreated']),
  portfolioMarket: new Set(['OrderListed','OrderExpirySet','OrderFilled','BuyerFeeCharged','OrderCancelled','BnbWithdrawn']),
  portfolio: new Set(['Transfer','Deposited','ChildPurchased','AcquisitionFinalized','BemCollected','ChildHarvestFailed',
    'BemClaimed','BnbWithdrawn','ChildSaleProposed','ChildSaleVoted','ChildSaleApproved','ChildSaleSettled','ChildSaleExpired']),
  pool: new Set(['Deposited', 'DepositWithdrawn', 'Funded', 'Failed', 'Purchased', 'FirstoPurchased', 'AlternativeMinerSelected',
    'PurchaseSurplusSettled', 'Harvested', 'BemClaimed', 'BnbWithdrawn', 'Transfer', 'SaleProposed', 'Voted',
    'SaleListed', 'SaleCompleted', 'FirstoSaleCompleted', 'SaleExpired', 'SaleSnapshotRecorded', 'SaleProceedsSettled', 'LockedSharesChanged',
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
  constructor(provider, { dbPath, factory, market, portfolioFactory, portfolioMarket, startBlock, confirmations = 12, scanRange = 100, maxBlocksPerSync = 500 }) {
    if (!provider || typeof provider.getLogs !== 'function' || typeof provider.call !== 'function'
      || typeof provider.send !== 'function') throw new Error('Read-only provider required.');
    this.provider = provider;
    this.factory = exactAddress(factory);
    this.market = exactAddress(market);
    if (Boolean(portfolioFactory) !== Boolean(portfolioMarket)) throw new Error('Both portfolio Factory and market must be configured.');
    this.portfolioFactory = portfolioFactory ? exactAddress(portfolioFactory) : null;
    this.portfolioMarket = portfolioMarket ? exactAddress(portfolioMarket) : null;
    if (this.portfolioFactory && new Set([this.factory,this.market,this.portfolioFactory,this.portfolioMarket]).size !== 4)
      throw new Error('Integrated deployment addresses must differ.');
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
      CREATE TABLE IF NOT EXISTS pools (address TEXT PRIMARY KEY, created_block INTEGER NOT NULL, collection TEXT NOT NULL, circuit_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS portfolios (address TEXT PRIMARY KEY, created_block INTEGER NOT NULL,budget TEXT NOT NULL,absolute_cap TEXT NOT NULL,unit_cap TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS portfolio_children (address TEXT PRIMARY KEY,portfolio TEXT NOT NULL,purchased_block INTEGER NOT NULL,collection TEXT NOT NULL,token_id TEXT NOT NULL,cost TEXT NOT NULL,official INTEGER NOT NULL);`);
    const identity = JSON.stringify({ version: this.portfolioFactory ? 2 : 1, chainId: 56, factory: this.factory, market: this.market,
      ...(this.portfolioFactory ? {portfolioFactory:this.portfolioFactory,portfolioMarket:this.portfolioMarket} : {}),startBlock: this.startBlock });
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
      ...(this.portfolioFactory ? {portfolioFactory:this.portfolioFactory,portfolioMarket:this.portfolioMarket} : {}),
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
    if (this.portfolioFactory) {
      const values=await Promise.allSettled([this.provider.getCode(this.portfolioFactory,blockNumber),this.provider.getCode(this.portfolioMarket,blockNumber),
        this._call(this.portfolioFactory,'shareMarket',[],blockNumber),this._call(this.portfolioMarket,'factory',[],blockNumber),
        this._call(this.portfolioFactory,'legacyFactory',[],blockNumber)]);
      if (values.some(v=>v.status==='rejected')) throw new Error('Portfolio deployment read failed.');
      const [fc,mc,registered,factory,legacy]=values.map(v=>v.value);
      if (fc==='0x' || mc==='0x' || exactAddress(registered)!==this.portfolioMarket || exactAddress(factory)!==this.portfolioFactory
        || exactAddress(legacy)!==this.factory) throw new Error('Portfolio deployment binding mismatch.');
    }
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
    if (this.portfolioFactory) {
      const count=await this._call(this.portfolioFactory,'portfolioCount',[],blockNumber);
      const orders=await this._call(this.portfolioMarket,'nextOrderId',[],blockNumber);
      if (count!==BigInt(this.db.prepare('SELECT COUNT(*) AS n FROM portfolios').get().n)
        || orders!==BigInt(this.db.prepare("SELECT COUNT(*) AS n FROM logs WHERE kind='portfolioMarket' AND name='OrderListed'").get().n)+1n)
        throw new Error('Event history is incomplete for budget projects.');
      for (const row of this.db.prepare('SELECT address FROM portfolios').iterate()) {
        if (await this._call(row.address,'childCount',[],blockNumber)!==BigInt(this.db.prepare('SELECT COUNT(*) AS n FROM portfolio_children WHERE portfolio=?').get(row.address).n))
          throw new Error('Event history is incomplete for budget child miners.');
      }
    }
  }

  _rollback(number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM logs WHERE block_number > ?').run(number);
      this.db.prepare('DELETE FROM pools WHERE created_block > ?').run(number);
      this.db.prepare('DELETE FROM portfolios WHERE created_block > ?').run(number);
      this.db.prepare('DELETE FROM portfolio_children WHERE purchased_block > ?').run(number);
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
    // Fetch a small, fixed batch concurrently, then validate in chain order.
    // allSettled drains every in-flight read before failure releases the sync lock.
    for (let first = fromBlock; first <= toBlock; first += 8) {
      const numbers = Array.from({ length: Math.min(8, toBlock - first + 1) }, (_, offset) => first + offset);
      const batch = await Promise.allSettled(numbers.map(async number => {
        const header = normalizeBlock(await this.provider.getBlock(number));
        if (header.number !== number) throw new Error('RPC returned a different block number.');
        return header;
      }));
      for (const result of batch) {
        if (result.status === 'rejected') throw result.reason;
        const header = result.value;
        const parent = headers.at(-1) ?? this._header(header.number - 1);
        if (parent && header.parentHash !== parent.hash) throw new Error('Chain changed during header scan.');
        headers.push(header);
      }
    }
    // These registered global addresses do not depend on discovery in this chunk.
    // Drain every request before throwing, so a failed scan cannot leave old reads
    // running after the sync lock is released or during a new scan/shutdown.
    const globalReads = await Promise.allSettled([
      this._logs('factory', [this.factory], fromBlock, toBlock),
      this._logs('market', [this.market], fromBlock, toBlock),
      ...(this.portfolioFactory ? [
        this._logs('portfolioFactory', [this.portfolioFactory], fromBlock, toBlock),
        this._logs('portfolioMarket', [this.portfolioMarket], fromBlock, toBlock),
      ] : []),
    ]);
    const failedGlobal = globalReads.find(result => result.status === 'rejected');
    if (failedGlobal) throw failedGlobal.reason;
    const [factoryLogs, marketLogs, portfolioFactoryLogs, portfolioMarketLogs] = globalReads.map(result => result.value);
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
    const portfolioLogs=[],newPortfolios=[],newChildren=[];
    if (this.portfolioFactory) {
      const factoryEvents=portfolioFactoryLogs;
      const known=this.db.prepare('SELECT address FROM portfolios').all().map(row=>row.address);
      for (const log of factoryEvents) {
        const address=exactAddress(log.args.portfolio);
        if (known.includes(address) || newPortfolios.some(row=>row.address===address)) throw new Error('Duplicate budget project.');
        if (!await this._call(this.portfolioFactory,'isPool',[address],toBlock)
          || exactAddress(await this._call(address,'OFFICIAL_FACTORY',[],toBlock))!==this.portfolioFactory
          || exactAddress(await this._call(address,'legacyFactory',[],toBlock))!==this.factory)
          throw new Error('Budget project is not registered to the configured graph.');
        newPortfolios.push({address,createdBlock:log.blockNumber,...log.args});
      }
      const events=await this._logs('portfolio',[...known,...newPortfolios.map(row=>row.address)],fromBlock,toBlock);
      const corePools=new Set([...existing,...created.map(row=>row.address)]);
      for (const log of events.filter(row=>row.name==='ChildPurchased')) {
        const child=exactAddress(log.args.child);
        if (!corePools.has(child) || this.db.prepare('SELECT 1 FROM portfolio_children WHERE address=?').get(child)
          || newChildren.some(row=>row.address===child)) throw new Error('Unknown or duplicate budget child miner.');
        const raw=await this.provider.call({to:log.address,data:binding.encodeFunctionData('childInfo',[child]),blockTag:toBlock});
        const info=binding.decodeFunctionResult('childInfo',raw);
        if (exactAddress(info.collection)!==exactAddress(log.args.collection) || String(info.tokenId)!==log.args.tokenId
          || String(info.purchaseCost)!==log.args.cost || info.official!==log.args.official)
          throw new Error('Child purchase event differs from portfolio custody.');
        newChildren.push({address:child,portfolio:log.address,purchasedBlock:log.blockNumber,...log.args});
      }
      portfolioLogs.push(...factoryEvents,...events,...portfolioMarketLogs);
    }
    const logs = [...factoryLogs, ...marketLogs, ...poolLogs,...portfolioLogs].sort((a, b) => a.blockNumber - b.blockNumber || a.txIndex - b.txIndex || a.logIndex - b.logIndex);
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
    const canonicalTip = normalizeBlock(await this.provider.getBlock(toBlock));
    if (canonicalTip.number !== toBlock || canonicalTip.hash !== headers.at(-1).hash) {
      throw new Error('Chain changed before index commit.');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insertHeader = this.db.prepare('INSERT INTO headers(number,hash,parent_hash,timestamp) VALUES(?,?,?,?)');
      const insertPool = this.db.prepare('INSERT INTO pools(address,created_block,collection,circuit_id) VALUES(?,?,?,?)');
      const insertLog = this.db.prepare('INSERT INTO logs(block_number,tx_index,log_index,tx_hash,address,kind,name,args) VALUES(?,?,?,?,?,?,?,?)');
      for (const header of headers) insertHeader.run(header.number, header.hash, header.parentHash, header.timestamp);
      for (const pool of created) insertPool.run(pool.address, pool.createdBlock, pool.collection, pool.circuitId);
      const insertPortfolio=this.db.prepare('INSERT INTO portfolios(address,created_block,budget,absolute_cap,unit_cap) VALUES(?,?,?,?,?)');
      for (const row of newPortfolios) insertPortfolio.run(row.address,row.createdBlock,row.budgetWei,row.absoluteCapWei,row.unitCapWei);
      const insertChild=this.db.prepare('INSERT INTO portfolio_children(address,portfolio,purchased_block,collection,token_id,cost,official) VALUES(?,?,?,?,?,?,?)');
      for (const row of newChildren) insertChild.run(row.address,row.portfolio,row.purchasedBlock,exactAddress(row.collection),row.tokenId,row.cost,row.official?1:0);
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

  notifications(options = {}) { return notificationPage(this, interfaces.pool, options); }

  pools({ cursor = 0, limit = 20 } = {}) {
    integer(cursor, 'cursor'); integer(limit, 'limit', 1);
    if (limit > 50) throw new Error('Page limit exceeds 50.');
    const rows = this.db.prepare('SELECT address,created_block AS createdBlock,collection,circuit_id AS circuitId FROM pools WHERE address NOT IN (SELECT address FROM portfolio_children) ORDER BY created_block,address LIMIT ? OFFSET ?').all(limit + 1, cursor);
    return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? cursor + limit : null };
  }

  portfolios({cursor=0,limit=20,account}={}) {
    integer(cursor,'cursor');integer(limit,'limit',1);if(limit>50)throw new Error('Page limit exceeds 50.');
    const related=new Set();
    if(account) {
      const wallet=exactAddress(account),orders=new Map();
      for(const event of this._mergeLogs(this._allLogs({kind:'portfolio'}),this._allLogs({kind:'portfolioMarket'}))) {
        const a=event.args;
        if(event.kind==='portfolio' && [a.member,a.from,a.to].some(v=>v && lower(v)===wallet))related.add(event.address);
        if(event.kind==='portfolioMarket' && event.name==='OrderListed') {orders.set(a.orderId,a.pool);if(a.seller===wallet)related.add(a.pool);}
        if(event.kind==='portfolioMarket' && event.name==='OrderFilled' && a.buyer===wallet && orders.has(a.orderId))related.add(orders.get(a.orderId));
      }
    }
    const rows=this.db.prepare('SELECT address,created_block AS createdBlock,budget AS budgetWei,absolute_cap AS absoluteCapWei,unit_cap AS unitCapWei FROM portfolios ORDER BY created_block,address').all()
      .filter(row=>!account || related.has(row.address)).map(row=>({...row,kind:'portfolio',factory:this.portfolioFactory}));
    return {items:rows.slice(cursor,cursor+limit),nextCursor:cursor+limit<rows.length?cursor+limit:null};
  }

  portfolioChildren(portfolio,{cursor=0,limit=20}={}) {
    const address=exactAddress(portfolio);integer(cursor,'cursor');integer(limit,'limit',1);
    if(limit>50 || !this.db.prepare('SELECT 1 FROM portfolios WHERE address=?').get(address))throw new Error('Unknown budget project.');
    const rows=this.db.prepare('SELECT address,portfolio,purchased_block AS purchasedBlock,collection,token_id AS tokenId,cost AS costWei,official FROM portfolio_children WHERE portfolio=? ORDER BY purchased_block,address LIMIT ? OFFSET ?')
      .all(address,limit+1,cursor).map(row=>({...row,pool:row.address,official:row.official===1}));
    return {items:rows.slice(0,limit),nextCursor:rows.length>limit?cursor+limit:null};
  }

  /** Historical totals only. No estimated production or current pool state is inferred from events. */
  stats() {
    const status = this.status();
    const cacheKey = `${status.indexedThrough}:${status.indexedBlockHash}`;
    if (this.cachedStats?.key === cacheKey) return this.cachedStats.value;
    const registeredPoolCount = this.db.prepare('SELECT COUNT(*) AS count FROM pools').get().count;
    const system = new Set([ZeroAddress.toLowerCase(), this.factory, this.market,this.portfolioFactory,this.portfolioMarket]);
    for (const row of this.db.prepare('SELECT address FROM pools').iterate()) system.add(row.address);
    for (const row of this.db.prepare('SELECT address FROM portfolios').iterate()) system.add(row.address);
    const participants = new Set();
    let purchasedCost = 0n, marketGross = 0n, harvestedNet = 0n;
    const rows = this.db.prepare(`SELECT kind,name,args FROM logs WHERE
      (kind = 'pool' AND name IN ('Deposited','Transfer','Purchased','Harvested'))
      OR (kind = 'portfolio' AND name IN ('Deposited','Transfer'))
      OR (kind IN ('market','portfolioMarket') AND name = 'OrderFilled')`);
    for (const row of rows.iterate()) {
      const a = JSON.parse(row.args);
      if (row.name === 'Deposited' || row.name === 'Transfer') {
        const address = lower(row.name === 'Deposited' ? a.user ?? a.member : a.to);
        if (!system.has(address)) participants.add(address);
      } else if (row.name === 'Purchased') purchasedCost += BigInt(a.cost);
      else if (row.name === 'OrderFilled') marketGross += BigInt(a.gross);
      else if (row.name === 'Harvested') harvestedNet += BigInt(a.toMembers);
    }
    const portfolioCount=this.db.prepare('SELECT COUNT(*) AS n FROM portfolios').get().n;
    const childPoolCount=this.db.prepare('SELECT COUNT(*) AS n FROM portfolio_children').get().n;
    const value = { scope: 'confirmed_indexed_history', registeredPoolCount: String(registeredPoolCount),
      standalonePoolCount:String(registeredPoolCount-childPoolCount),portfolioCount:String(portfolioCount),childPoolCount:String(childPoolCount),
      topLevelProjectCount:String(registeredPoolCount-childPoolCount+portfolioCount),
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

  orders({ pool, seller, active, cursor, limit = 20, portfolio = false } = {}) {
    const targetPool = pool === undefined ? null : exactAddress(pool);
    const targetSeller = seller === undefined ? null : exactAddress(seller);
    if (active !== undefined && typeof active !== 'boolean') throw new Error('Invalid active filter.');
    if (cursor !== undefined && !/^[1-9]\d*$/.test(String(cursor))) throw new Error('Invalid order cursor.');
    integer(limit, 'limit', 1); if (limit > 50) throw new Error('Page limit exceeds 50.');
    const orders = new Map();
    for (const event of this._allLogs({ kind: portfolio ? 'portfolioMarket' : 'market', names: ['OrderListed', 'OrderExpirySet', 'OrderFilled', 'OrderCancelled'] })) {
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
      this._allLogs({kind:'portfolio',address:targetPool}),this._allLogs({kind:'portfolioMarket'}),this._allLogs({kind:'portfolioFactory'}),
      this._allLogs({ kind: 'market' }), this._allLogs({ kind: 'factory' })) : this._allLogs();
    for (const event of history) {
      const a = event.args;
      const orderKey=`${event.kind}:${a.orderId}`;
      if (['market','portfolioMarket'].includes(event.kind) && event.name === 'OrderListed') { orderPools.set(orderKey, a.pool); orderSellers.set(orderKey, a.seller); }
      const eventPool = ['pool','portfolio'].includes(event.kind) ? event.address
        : event.kind === 'factory' && event.name === 'PoolCreated' ? a.pool
          : event.kind==='portfolioFactory' && event.name==='PortfolioCreated' ? a.portfolio : orderPools.get(orderKey) ?? null;
      if (targetPool && eventPool !== targetPool) continue;
      if (targetAccount && ![a.user, a.member, a.proposer, a.voter, a.seller, a.buyer, a.treasury, a.from, a.to, orderSellers.get(orderKey)]
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
    const candidate=exactAddress(pool),portfolio=Boolean(this.db.prepare('SELECT 1 FROM portfolios WHERE address=?').get(candidate));
    const targetPool = portfolio ? candidate : this._registeredPool(pool);
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
    for (const event of this._allLogs({ kind: portfolio?'portfolio':'pool', address: targetPool,
      names: [portfolio?'BemCollected':'Harvested', 'BemClaimed'], fromTimestamp: firstTimestamp })) {
      if (event.address !== targetPool) continue;
      const bucket = buckets.get(beijingDay(this._header(event.blockNumber).timestamp));
      if (!bucket) continue;
      if (event.name === 'Harvested') bucket.poolHarvestNetAtomic = (BigInt(bucket.poolHarvestNetAtomic) + BigInt(event.args.toMembers)).toString();
      if (event.name === 'BemCollected') bucket.poolHarvestNetAtomic = (BigInt(bucket.poolHarvestNetAtomic) + BigInt(event.args.received)).toString();
      if (targetAccount && event.name === 'BemClaimed' && (event.args.user ?? event.args.member) === targetAccount) {
        bucket.accountClaimedAtomic = (BigInt(bucket.accountClaimedAtomic) + BigInt(event.args.amount)).toString();
      }
    }
    return { scope: portfolio?'portfolio':'pool', pool: targetPool, account: targetAccount, timezone: 'Asia/Shanghai', token: 'BEM', tokenDecimals: 8,
      buckets: [...buckets.values()], accountUnclaimedDailyAccrual: null,
      note: 'Harvested is pool accounting time; BemClaimed is actual wallet payout. Historical unclaimed per-wallet daily accrual is not inferred.' };
  }
}

export const chainIndexInterfaces = interfaces;
