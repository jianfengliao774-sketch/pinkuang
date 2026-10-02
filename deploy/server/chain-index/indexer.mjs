import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Interface, ZeroAddress, getAddress, keccak256 } from 'ethers';
import { notificationPage } from './notifications.mjs';
import { summarizeOverviewActivity } from '../../shared/activity-summary.mjs';

const artifactPath = fileURLToPath(new URL('../../public/deployment-artifacts.json', import.meta.url));
const artifacts = JSON.parse(await readFile(artifactPath, 'utf8'));
const interfaces = Object.freeze({
  factory: new Interface(artifacts.artifacts.PoolFactory.abi),
  market: new Interface(artifacts.artifacts.ShareMarket.abi),
  // Additive current events live in source, without changing the sealed genesis artifact.
  pool: new Interface([...artifacts.artifacts.PoolVault.abi,
    'event SaleDelistingProposed(uint256 indexed cancellationId,uint256 indexed listedProposalId,address indexed proposer,uint48 snapshotTs,uint256 snapshotMemberCount)',
    'event SaleDelistingVoted(uint256 indexed cancellationId,address indexed voter,bool support,uint256 weight)',
    'event SaleDelisted(uint256 indexed proposalId,uint256 indexed cancellationId)',
  ]),
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
    'event ChildSaleReviewed(uint256 indexed proposalId,bool approved,address indexed operator)',
  ]),
});
const binding = new Interface([
  'function shareMarket() view returns (address)',
  'function isPool(address) view returns (bool)',
  'function factory() view returns (address)',
  'function poolCount() view returns (uint256)',
  'function nextOrderId() view returns (uint256)',
  'function legacyFactory() view returns(address)', 'function OFFICIAL_FACTORY() view returns(address)',
  'function designatedSubscriber(address) view returns(address)',
  'function portfolioCount() view returns(uint256)', 'function childCount() view returns(uint256)',
  'function childInfo(address) view returns(address collection,uint256 tokenId,uint256 purchaseCost,bool official,bool sold)',
]);
const CHILD_COUNT_READ_CONCURRENCY = 16;
// A fresh deployment is checked on its first sync and again about once per
// minute. The pinned runtime hashes complement (but cannot replace) the
// proxy/market binding checks made on every sync.
const FRESH_CODEHASH_RECHECK_BLOCKS = 20;
const indexedEvents = Object.freeze({
  factory: new Set(['PoolCreated']),
  market: new Set(['OrderListed', 'OrderExpirySet', 'OrderFilled', 'BuyerFeeCharged', 'OrderCancelled', 'BnbWithdrawn', 'SaleReviewed']),
  portfolioFactory: new Set(['PortfolioCreated']),
  portfolioMarket: new Set(['OrderListed','OrderExpirySet','OrderFilled','BuyerFeeCharged','OrderCancelled','BnbWithdrawn','SaleReviewed']),
  portfolio: new Set(['Transfer','Deposited','ChildPurchased','AcquisitionFinalized','BemCollected','ChildHarvestFailed',
    'BemClaimed','BnbWithdrawn','ChildSaleProposed','ChildSaleVoted','ChildSaleApproved','ChildSaleSettled','ChildSaleExpired',
    'ChildSaleReviewed']),
  pool: new Set(['Deposited', 'DepositWithdrawn', 'Funded', 'Failed', 'Purchased', 'FirstoPurchased', 'AlternativeMinerSelected',
    'PurchaseSurplusSettled', 'Harvested', 'BemClaimed', 'BnbWithdrawn', 'Transfer', 'SaleProposed', 'Voted',
    'SaleListed', 'SaleCompleted', 'FirstoSaleCompleted', 'SaleExpired', 'SaleSnapshotRecorded', 'SaleProceedsSettled', 'LockedSharesChanged',
    'SaleDelistingProposed', 'SaleDelistingVoted', 'SaleDelisted',
    'FlexiblePurchaseConfigured', 'PurchaseModelLocked', 'PurchaseReferenceWeightLocked']),
});
const topicSets = Object.freeze(Object.fromEntries(Object.entries(interfaces).map(([kind, iface]) =>
  [kind, iface.fragments.filter(fragment => fragment.type === 'event' && indexedEvents[kind].has(fragment.name))
    .map(fragment => fragment.topicHash)])));
const topicSchema = topics => createHash('sha256').update(JSON.stringify(Object.entries(topics)
  .sort(([left],[right])=>left.localeCompare(right))
  .map(([kind,values])=>[kind,[...values].sort()]))).digest('hex');
const eventSchema = topicSchema(topicSets);
const additivePoolNames = ['SaleDelistingProposed','SaleDelistingVoted','SaleDelisted'];
const additivePoolTopics = additivePoolNames.map(name => interfaces.pool.getEvent(name).topicHash);
// The exact previously deployed topic set is known even though older databases
// stored only its digest. Later versions also persist the complete topic map.
const previousTopicSets = {...topicSets,pool:topicSets.pool.filter(topic=>!additivePoolTopics.includes(topic))};
const previousEventSchema = topicSchema(previousTopicSets);

function additiveTopicMigration(previous,current) {
  if (!previous || Object.keys(previous).length!==Object.keys(current).length) return null;
  const additions={};
  for (const [kind,topics] of Object.entries(current)) {
    const old=previous[kind];
    if(!Array.isArray(old)||new Set(old).size!==old.length||old.some(topic=>!topics.includes(topic)))return null;
    const extra=topics.filter(topic=>!old.includes(topic));
    // Registration/materialized-table changes require their own migration.
    if(extra.length && (kind!=='pool'||extra.some(topic=>!additivePoolTopics.includes(topic))))return null;
    if(extra.length)additions[kind]=extra;
  }
  return additions;
}

function checkedTopicBackfill(value,startBlock) {
  const additions=additiveTopicMigration(value?.sourceTopics,topicSets);
  if(value?.schemaVersion!==1||value.targetEventSchema!==eventSchema
    ||topicSchema(value.sourceTopics??{})!==value.sourceEventSchema||!additions||!Object.keys(additions).length
    ||JSON.stringify(additions)!==JSON.stringify(value.topics)||value.fromBlock!==startBlock
    ||!Number.isSafeInteger(value.through)||value.through<startBlock
    ||!Number.isSafeInteger(value.nextBlock)||value.nextBlock<startBlock||value.nextBlock>value.through+1)
    throw new Error('Index additive event migration is malformed; existing history was preserved.');
  return value;
}

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

// The persisted row is the source of truth. Once trusted, parse it once per
// verified tip and share only an immutable, display-only copy with readers.
const freezeDisplay = value => {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeDisplay(nested);
    Object.freeze(value);
  }
  return value;
};
const parseDisplaySnapshot = row => freezeDisplay({
  source: JSON.parse(row.source), pools: JSON.parse(row.pools),
  stats: row.stats ? JSON.parse(row.stats) : null,
  portfolios: row.portfolios ? JSON.parse(row.portfolios) : null,
  orders: row.orders ? JSON.parse(row.orders) : null,
});

/** Read-only, event-sourced index. All amounts stay decimal strings; no transaction method is used. */
export class ChainIndex {
  constructor(provider, { dbPath, factory, market, portfolioFactory, portfolioMarket, reservationMode = 'legacy',
    startBlock, confirmations = 12, scanRange = 100, maxBlocksPerSync = 500, headerConcurrency = 8, freshCodehashes = null }) {
    if (!provider || typeof provider.getLogs !== 'function' || typeof provider.call !== 'function'
      || typeof provider.send !== 'function') throw new Error('Read-only provider required.');
    this.provider = provider;
    this.factory = exactAddress(factory);
    this.market = exactAddress(market);
    if (Boolean(portfolioFactory) !== Boolean(portfolioMarket)) throw new Error('Both portfolio Factory and market must be configured.');
    this.portfolioFactory = portfolioFactory ? exactAddress(portfolioFactory) : null;
    this.portfolioMarket = portfolioMarket ? exactAddress(portfolioMarket) : null;
    this.freshCodehashes = freshCodehashes === null ? null : Object.freeze(freshCodehashes.map(({address,expected}) => {
      if (typeof expected !== 'string' || !/^0x[\da-f]{64}$/i.test(expected))
        throw new Error('Invalid fresh index codehash.');
      return Object.freeze({address:exactAddress(address),expected:expected.toLowerCase()});
    }));
    if (this.freshCodehashes && (this.freshCodehashes.length !== 11
      || new Set(this.freshCodehashes.map(item=>item.address)).size !== 11
      || !this.freshCodehashes.some(item=>item.address===this.factory)
      || !this.freshCodehashes.some(item=>item.address===this.market)
      || !this.freshCodehashes.some(item=>item.address===this.portfolioFactory)
      || !this.freshCodehashes.some(item=>item.address===this.portfolioMarket)))
      throw new Error('Fresh index codehash graph is incomplete.');
    this.freshCodehashVerifiedAt = null;
    if (!['legacy','required'].includes(reservationMode)) throw new Error('Invalid reservation mode.');
    if (reservationMode === 'required' && !this.portfolioFactory)
      throw new Error('Reservation proofs require the integrated portfolio Factory.');
    this.reservationMode = reservationMode;
    if (this.portfolioFactory && new Set([this.factory,this.market,this.portfolioFactory,this.portfolioMarket]).size !== 4)
      throw new Error('Integrated deployment addresses must differ.');
    if (this.factory === this.market) throw new Error('Factory and market must differ.');
    this.startBlock = integer(startBlock, 'startBlock');
    this.confirmations = integer(confirmations, 'confirmations', 2);
    this.scanRange = integer(scanRange, 'scanRange', 1);
    this.maxBlocksPerSync = integer(maxBlocksPerSync, 'maxBlocksPerSync', 1);
    this.headerConcurrency = integer(headerConcurrency, 'headerConcurrency', 1);
    if (this.scanRange > 500 || this.maxBlocksPerSync > 2000 || this.headerConcurrency > 64) throw new Error('Scan bounds exceeded.');
    this.dbPath = dbPath;
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
      CREATE TABLE IF NOT EXISTS pools (address TEXT PRIMARY KEY, created_block INTEGER NOT NULL, collection TEXT NOT NULL, circuit_id TEXT NOT NULL, designated_subscriber TEXT);
      CREATE TABLE IF NOT EXISTS portfolios (address TEXT PRIMARY KEY, created_block INTEGER NOT NULL,budget TEXT NOT NULL,absolute_cap TEXT NOT NULL,unit_cap TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS portfolio_children (address TEXT PRIMARY KEY,portfolio TEXT NOT NULL,purchased_block INTEGER NOT NULL,collection TEXT NOT NULL,token_id TEXT NOT NULL,cost TEXT NOT NULL,official INTEGER NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS verified_display_snapshot (id INTEGER PRIMARY KEY CHECK(id = 1), source TEXT NOT NULL, pools TEXT NOT NULL, stats TEXT)');
    if (!this.db.prepare('PRAGMA table_info(verified_display_snapshot)').all().some(column => column.name === 'portfolios'))
      this.db.exec('ALTER TABLE verified_display_snapshot ADD COLUMN portfolios TEXT');
    if (!this.db.prepare('PRAGMA table_info(verified_display_snapshot)').all().some(column => column.name === 'orders'))
      this.db.exec('ALTER TABLE verified_display_snapshot ADD COLUMN orders TEXT');
    const priorIdentity = JSON.stringify({ version: this.portfolioFactory ? 2 : 1, chainId: 56, factory: this.factory, market: this.market,
      ...(this.portfolioFactory ? {portfolioFactory:this.portfolioFactory,portfolioMarket:this.portfolioMarket} : {}),startBlock: this.startBlock });
    const baseIdentity = this.portfolioFactory
      ? JSON.stringify({ ...JSON.parse(priorIdentity), reservationMode: this.reservationMode }) : priorIdentity;
    const identity = JSON.stringify({ ...JSON.parse(baseIdentity), eventSchema });
    const saved = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('identity');
    if (saved && saved.value !== identity) {
      let previous;
      try { previous = JSON.parse(saved.value); } catch { /* Invalid identity must fail closed. */ }
      const withoutSchema = previous && { ...previous };
      if (withoutSchema) delete withoutSchema.eventSchema;
      const compatible = JSON.stringify(withoutSchema) === baseIdentity
        || this.reservationMode === 'legacy' && JSON.stringify(withoutSchema) === priorIdentity;
      if (!compatible) { this.db.close(); throw new Error('Index database belongs to a different deployment or reservation mode.'); }
      if (previous.eventSchema !== eventSchema) {
        const savedTopics=this.db.prepare("SELECT value FROM metadata WHERE key='indexedEventTopics'").get();
        let oldTopics;
        try {oldTopics=savedTopics?JSON.parse(savedTopics.value):previous.eventSchema===previousEventSchema?previousTopicSets:null;}
        catch { /* Invalid persisted topic maps must preserve the database and stop. */ }
        let additions;
        try {additions=oldTopics&&topicSchema(oldTopics)===previous.eventSchema?additiveTopicMigration(oldTopics,topicSets):null;}
        catch { /* A malformed map cannot authorize a migration. */ }
        if(!additions||!Object.keys(additions).length){this.db.close();throw new Error('Index event schema requires an explicit migration; existing history was preserved.');}
        const through=Number(this.db.prepare("SELECT value FROM metadata WHERE key='indexedThrough'").get()?.value);
        if(!Number.isSafeInteger(through)||through<this.startBlock-1){this.db.close();throw new Error('Index event migration checkpoint is invalid.');}
        const migration=through>=this.startBlock?{schemaVersion:1,sourceEventSchema:previous.eventSchema,
          sourceTopics:oldTopics,targetEventSchema:eventSchema,topics:additions,fromBlock:this.startBlock,
          nextBlock:this.startBlock,through}:null;
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.prepare('UPDATE metadata SET value = ? WHERE key = ?').run(identity,'identity');
          if(migration)this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('eventTopicBackfill',JSON.stringify(migration));
          this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
      } else this.db.prepare('UPDATE metadata SET value = ? WHERE key = ?').run(identity,'identity');
    }
    const legacyReservationSchema = !this.db.prepare('PRAGMA table_info(pools)').all()
      .some(column => column.name === 'designated_subscriber');
    if (legacyReservationSchema) this.db.exec('ALTER TABLE pools ADD COLUMN designated_subscriber TEXT');
    this.reservationMigrationPending = this.db.prepare('SELECT 1 FROM pools WHERE designated_subscriber IS NULL LIMIT 1').get() !== undefined;
    // A prior complete snapshot may contain a reserved child as an ordinary
    // pool. It cannot be served while legacy rows still lack their marker.
    if (legacyReservationSchema || this.reservationMigrationPending)
      this.db.prepare('DELETE FROM verified_display_snapshot WHERE id = 1').run();
    if (!saved) {
      this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('identity', identity);
      this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('indexedThrough', String(this.startBlock - 1));
    }
    this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('indexedEventTopics',JSON.stringify(topicSets));
    const pendingTopics=this.db.prepare("SELECT value FROM metadata WHERE key='eventTopicBackfill'").get();
    try {this.eventTopicBackfill=pendingTopics?checkedTopicBackfill(JSON.parse(pendingTopics.value),this.startBlock):null;}
    catch(error){this.db.close();throw error;}
    this.ready = false;
    this.lastError = null;
    this.observedSafeHead = null;
    this.checkedAt = null;
    this.syncing = false;
    this.syncSettled = null;
    this.lastFailureStage = null;
    this.lastScanPhase = null;
    this.cachedStats = null;
    // Confirmed block headers often arrive without business events. Keep the
    // historical totals until a committed log change or rollback, rather than
    // scanning the full history on every new safe head.
    this.statsGeneration = 0;
    this.snapshotTrusted = false;
    // undefined means a trusted persisted row may still need one lazy load;
    // null means no usable row until the next verified capture.
    this.verifiedDisplaySnapshotCache = undefined;
    this.lastSnapshotError = null;
    this.verifiedReadView = null;
  }

  close() { this._retireVerifiedReadView(true); this.verifiedDisplaySnapshotCache = null; this.db.close(); }
  get indexedThrough() { return Number(this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('indexedThrough').value); }
  _setIndexedThrough(number) { this.db.prepare('UPDATE metadata SET value = ? WHERE key = ?').run(String(number), 'indexedThrough'); }
  _header(number) { return this.db.prepare('SELECT number,hash,parent_hash AS parentHash,timestamp FROM headers WHERE number = ?').get(number); }

  _retireVerifiedReadView(invalidated = false) {
    const entry = this.verifiedReadView;
    if (!entry) return;
    this.verifiedReadView = null;
    entry.valid = false;
    entry.invalidated ||= invalidated;
    if (entry.readers === 0) this._closeVerifiedReadView(entry);
  }

  _closeVerifiedReadView(entry) {
    if (entry.transactional) entry.index.db.exec('ROLLBACK');
    entry.index.db.close();
    if (entry.directory) rmSync(entry.directory, { recursive: true, force: true });
  }

  _invalidateVerifiedHistory() {
    this.snapshotTrusted = false;
    this.verifiedDisplaySnapshotCache = null;
    this._retireVerifiedReadView(true);
    // A failed chain or history proof invalidates the persisted page as well;
    // otherwise a restart could trust an obsolete row after the next sync.
    this.db.prepare('DELETE FROM verified_display_snapshot WHERE id = 1').run();
  }

  acquireVerifiedReadView() {
    const entry = this.verifiedReadView;
    if (!entry?.valid) return null;
    if (Date.now() - Date.parse(entry.source.checkedAt) > 30 * 60 * 1000) {
      // A retained WAL reader must not pin the database indefinitely if an
      // upstream outage lasts beyond the permitted display-snapshot age.
      this._retireVerifiedReadView();
      return null;
    }
    entry.readers++;
    return entry;
  }

  releaseVerifiedReadView(entry) {
    if (!entry) return;
    entry.readers--;
    if (!entry.valid && entry.readers === 0) this._closeVerifiedReadView(entry);
  }

  isVerifiedReadView(entry) { return Boolean(entry && !entry.invalidated); }

  async _saveVerifiedReadView() {
    const source = this.status();
    if (!source.complete) return;
    let directory, view, readDb, transactionStarted = false;
    try {
      if (this.dbPath === ':memory:') {
        // In-memory test indexes have no second connection to pin. Production
        // file-backed indexes use the WAL reader below without a full copy.
        directory = mkdtempSync(join(tmpdir(), 'bemine-chain-index-read-'));
        const path = join(directory, 'verified.sqlite');
        await backup(this.db, path);
        readDb = new DatabaseSync(path, { readOnly: true });
      } else {
        readDb = new DatabaseSync(this.dbPath, { readOnly: true });
        readDb.exec('BEGIN');
        transactionStarted = true;
      }
      // Establish the WAL snapshot before the writer can commit a scan chunk.
      readDb.prepare('SELECT value FROM metadata WHERE key = ?').get('indexedThrough');
      view = Object.assign(Object.create(ChainIndex.prototype), {
        db: readDb, provider: this.provider, factory: this.factory, market: this.market,
        portfolioFactory: this.portfolioFactory, portfolioMarket: this.portfolioMarket,
        startBlock: this.startBlock, confirmations: this.confirmations,
        ready: true, lastError: null, observedSafeHead: source.indexedThrough,
        checkedAt: source.checkedAt, cachedStats: this.cachedStats, statsGeneration: this.statsGeneration,
      });
      if (view.indexedThrough !== source.indexedThrough || view._header(source.indexedThrough)?.hash !== source.indexedBlockHash)
        throw new Error('Verified read view changed before it was pinned.');
      const entry = { index: view, directory, source, readers: 0, valid: true, invalidated: false,
        transactional: !directory };
      this._retireVerifiedReadView();
      this.verifiedReadView = entry;
    } catch (error) {
      if (readDb) {
        if (transactionStarted) readDb.exec('ROLLBACK');
        readDb.close();
      }
      if (directory) rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  status() {
    const indexedThrough = this.indexedThrough;
    const source = indexedThrough >= this.startBlock ? this._header(indexedThrough) : null;
    return {
      chainId: 56, factory: this.factory, market: this.market, startBlock: this.startBlock,
      ...(this.portfolioFactory ? {portfolioFactory:this.portfolioFactory,portfolioMarket:this.portfolioMarket} : {}),
      confirmations: this.confirmations, indexedThrough, indexedBlockHash: source?.hash ?? null,
      indexedTimestamp: source?.timestamp ?? null, observedSafeHead: this.observedSafeHead,
      complete: !this.eventTopicBackfill && !this.reservationMigrationPending && this.ready && this.lastError === null && indexedThrough === this.observedSafeHead,
      checkedAt: this.checkedAt, unknownReason: this.reservationMigrationPending ? 'reservation_unverified'
        : this.lastError ?? (this.eventTopicBackfill?'event_topic_backfill':this.ready?null:'index_not_caught_up'),
    };
  }

  async waitForSync(timeoutMs) {
    if (!this.syncing || !this.syncSettled) return;
    let timer;
    try {
      await Promise.race([this.syncSettled, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
    } finally { clearTimeout(timer); }
  }

  async _call(to, method, args, blockNumber) {
    const data = binding.encodeFunctionData(method, args);
    // ethers v6 call() takes the block tag inside the transaction request;
    // a second positional argument is ignored and would silently read latest.
    const result = await this.provider.call({ to, data, blockTag: blockNumber });
    return binding.decodeFunctionResult(method, result)[0];
  }

  async _registrationProof(historicalBlock) {
    // The reviewed fresh contracts only set registration, subscriber and child
    // purchase identity at creation. Read those permanent fields at the confirmed
    // head so catch-up does not require archive state. Events still establish the
    // historical creation/purchase block; mutable balances and sold state do not
    // use this proof. Unpinned/legacy deployments retain historical reads.
    if (!this.freshCodehashes || this.reservationMode !== 'required') return null;
    if (this.freshCodehashVerifiedAt === null || this.observedSafeHead < historicalBlock)
      throw new Error('Fresh registration proof is not verified.');
    const header = normalizeBlock(await this.provider.getBlock(this.observedSafeHead));
    if (header.number !== this.observedSafeHead) throw new Error('Registration proof block differs.');
    return header;
  }

  async _verifyRegistrationProof(proof) {
    if (proof && normalizeBlock(await this.provider.getBlock(proof.number)).hash !== proof.hash)
      throw new Error('Registration proof block changed before index commit.');
  }

  async _backfillPoolReservations() {
    if (!this.reservationMigrationPending) return;
    const rows = this.db.prepare('SELECT address,created_block AS createdBlock FROM pools WHERE designated_subscriber IS NULL ORDER BY created_block,address').all();
    const resolved = [];
    for (const row of rows) {
      const saved = this._header(row.createdBlock);
      if (!saved || normalizeBlock(await this.provider.getBlock(row.createdBlock)).hash !== saved.hash)
        throw new Error('Legacy pool creation block is not canonical.');
      const proof = await this._registrationProof(row.createdBlock);
      const subscriber = this.reservationMode === 'required'
        ? getAddress(await this._call(this.factory, 'designatedSubscriber', [row.address], proof?.number ?? row.createdBlock)).toLowerCase()
        : ZeroAddress.toLowerCase();
      await this._verifyRegistrationProof(proof);
      if (normalizeBlock(await this.provider.getBlock(row.createdBlock)).hash !== saved.hash)
        throw new Error('Legacy pool creation block changed during reservation proof.');
      resolved.push({ address: row.address, subscriber });
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const update = this.db.prepare('UPDATE pools SET designated_subscriber = ? WHERE address = ? AND designated_subscriber IS NULL');
      for (const row of resolved) {
        if (update.run(row.subscriber, row.address).changes !== 1)
          throw new Error('Legacy pool reservation changed during backfill.');
      }
      this.db.exec('COMMIT');
      this.reservationMigrationPending = false;
      this.statsGeneration++;
      this.cachedStats = null;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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
      if (this.reservationMode === 'legacy') {
        // A legacy index is valid only while the Factory truly lacks the
        // reservation selector. An in-place implementation upgrade must stop
        // this database until it is rebuilt in required mode.
        const data=binding.encodeFunctionData('designatedSubscriber',[ZeroAddress]);
        try {
          const result=await this.provider.call({to:this.factory,data,blockTag:blockNumber});
          if (result !== '0x') throw new Error('Factory reservation capability requires a required-mode index.');
        } catch (error) {
          if (error?.code !== 'CALL_EXCEPTION' || error?.data && error.data !== '0x') throw error;
        }
      }
    }
    if (this.freshCodehashes && (this.freshCodehashVerifiedAt === null
      || blockNumber < this.freshCodehashVerifiedAt
      || blockNumber - this.freshCodehashVerifiedAt >= FRESH_CODEHASH_RECHECK_BLOCKS)) {
      const codes = await Promise.all(this.freshCodehashes.map(item => this.provider.getCode(item.address, blockNumber)));
      if (codes.some((code, index) => typeof code !== 'string' || !/^0x(?:[\da-f]{2})*$/i.test(code)
        || keccak256(code).toLowerCase() !== this.freshCodehashes[index].expected))
        throw new Error('Fresh manifest codehash mismatch.');
      this.freshCodehashVerifiedAt = blockNumber;
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
    this._poolCounts();
    if (this.portfolioFactory) {
      if (this.db.prepare('SELECT COUNT(*) AS n FROM portfolio_children c LEFT JOIN pools p ON p.address = c.address WHERE p.address IS NULL').get().n !== 0)
        throw new Error('Event history is incomplete for budget child registration.');
      const count=await this._call(this.portfolioFactory,'portfolioCount',[],blockNumber);
      const orders=await this._call(this.portfolioMarket,'nextOrderId',[],blockNumber);
      if (count!==BigInt(this.db.prepare('SELECT COUNT(*) AS n FROM portfolios').get().n)
        || orders!==BigInt(this.db.prepare("SELECT COUNT(*) AS n FROM logs WHERE kind='portfolioMarket' AND name='OrderListed'").get().n)+1n)
        throw new Error('Event history is incomplete for budget projects.');
      const parents = this.db.prepare(`SELECT p.address,COUNT(c.address) AS child_count FROM portfolios p
        LEFT JOIN portfolio_children c ON c.portfolio = p.address GROUP BY p.address ORDER BY p.address`).all();
      for (let offset=0;offset<parents.length;offset+=CHILD_COUNT_READ_CONCURRENCY) {
        const batch=parents.slice(offset,offset+CHILD_COUNT_READ_CONCURRENCY);
        const reads=await Promise.allSettled(batch.map(row=>this._call(row.address,'childCount',[],blockNumber)));
        // An unavailable RPC is not evidence of missing historical events.
        // Keep the last verified display view while the provider recovers.
        if (reads.some(read=>read.status==='rejected')) throw new Error('Budget child count read failed.');
        if (reads.some((read,i)=>read.value!==BigInt(batch[i].child_count)))
          throw new Error('Event history is incomplete for budget child miners.');
      }
    }
  }

  _rollback(number) {
    let backfill = this.eventTopicBackfill;
    if (backfill) backfill = number < this.startBlock ? null : {
      ...backfill, through: Math.min(backfill.through, number),
      nextBlock: Math.min(backfill.nextBlock, number + 1),
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM logs WHERE block_number > ?').run(number);
      this.db.prepare('DELETE FROM pools WHERE created_block > ?').run(number);
      this.db.prepare('DELETE FROM portfolios WHERE created_block > ?').run(number);
      this.db.prepare('DELETE FROM portfolio_children WHERE purchased_block > ?').run(number);
      this.db.prepare('DELETE FROM headers WHERE number > ?').run(number);
      this._setIndexedThrough(number);
      if (backfill) this.db.prepare("UPDATE metadata SET value=? WHERE key='eventTopicBackfill'").run(JSON.stringify(backfill));
      else this.db.prepare("DELETE FROM metadata WHERE key='eventTopicBackfill'").run();
      // Every reorg requires a new display proof. Do not permit an old row to
      // reappear merely because the replacement scan reaches its old height.
      this.db.prepare('DELETE FROM verified_display_snapshot WHERE id = 1').run();
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.eventTopicBackfill = backfill;
    // Reaching the former height again does not prove the replacement chain's
    // event counts or bindings. A successful sync must re-establish readiness.
    this.ready = false;
    this.snapshotTrusted = false;
    this.verifiedDisplaySnapshotCache = null;
    this._retireVerifiedReadView(true);
    this.statsGeneration++;
    this.cachedStats = null;
  }

  _restartHistoryAfterIncompleteProof() {
    // A log-serving RPC may have returned an empty but successful response.
    // Once a later same-block count proves history incomplete, replay from the
    // deployment anchor exactly once. The marker survives process restarts so
    // an upstream that keeps omitting logs cannot cause an endless rebuild.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of ['logs','pools','portfolios','portfolio_children','headers','verified_display_snapshot'])
        this.db.exec(`DELETE FROM ${table}`);
      this._setIndexedThrough(this.startBlock - 1);
      this.db.prepare("DELETE FROM metadata WHERE key='eventTopicBackfill'").run();
      this.db.prepare("UPDATE metadata SET value='attempted' WHERE key='historyRepair'").run();
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.eventTopicBackfill = null;
    this.ready = false;
    this.snapshotTrusted = false;
    this.verifiedDisplaySnapshotCache = null;
    this._retireVerifiedReadView(true);
    this.cachedStats = null;
    this.statsGeneration++;
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

  async _logs(kind, addresses, fromBlock, toBlock, requestedTopics = topicSets[kind]) {
    if (!addresses.length) return [];
    const all = [];
    for (let i = 0; i < addresses.length; i += 20) {
      const group = addresses.slice(i, i + 20);
      const found = await this.provider.getLogs({ address: group.length === 1 ? group[0] : group,
        fromBlock, toBlock, topics: [requestedTopics] });
      if (!Array.isArray(found) || found.length > 10_000) throw new Error('RPC event page exceeds the bound.');
      for (const log of found) {
        if (!group.includes(lower(log.address))) throw new Error('RPC returned a log from another contract.');
        if (!requestedTopics.includes(lower(log.topics?.[0]))) throw new Error('RPC returned an event outside the requested topic set.');
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

  async _backfillNewEventTopics() {
    const migration = this.eventTopicBackfill;
    if (!migration) return;
    // The saved tip has already been reconciled. Its hash binds the complete
    // stored parent chain, so only missing topics need a historical log read.
    const until = Math.min(migration.through, migration.nextBlock + this.maxBlocksPerSync - 1);
    for (let from = migration.nextBlock; from <= until; from += this.scanRange) {
      const to = Math.min(until, from + this.scanRange - 1);
      const pools = this.db.prepare('SELECT address,created_block FROM pools WHERE created_block<=?').all(to);
      const creation = new Map(pools.map(row => [row.address,row.created_block]));
      const logs = await this._logs('pool', pools.map(row=>row.address), from, to, migration.topics.pool);
      const seen = new Set();
      for (const log of logs) {
        if (log.blockNumber < from || log.blockNumber > to || log.blockNumber < creation.get(log.address)
          || this._header(log.blockNumber)?.hash !== log.blockHash)
          throw new Error('RPC backfill logs do not match canonical indexed headers.');
        const key = `${log.txHash}:${log.logIndex}`;
        if (seen.has(key)) throw new Error('RPC returned duplicate log identity.');
        seen.add(key);
      }
      const anchor = this._header(this.indexedThrough);
      if (!anchor) throw new Error('Index header gap during additive event migration.');
      const canonical = normalizeBlock(await this.provider.getBlock(anchor.number));
      if (canonical.number !== anchor.number || canonical.hash !== anchor.hash)
        throw new Error('Chain changed before additive event migration commit.');
      const next = {...this.eventTopicBackfill,nextBlock:to+1};
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const insert = this.db.prepare('INSERT INTO logs(block_number,tx_index,log_index,tx_hash,address,kind,name,args) VALUES(?,?,?,?,?,?,?,?)');
        for (const log of logs) insert.run(log.blockNumber,log.txIndex,log.logIndex,log.txHash,log.address,log.kind,log.name,JSON.stringify(log.args));
        if (next.nextBlock > next.through) this.db.prepare("DELETE FROM metadata WHERE key='eventTopicBackfill'").run();
        else this.db.prepare("UPDATE metadata SET value=? WHERE key='eventTopicBackfill'").run(JSON.stringify(next));
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      this.eventTopicBackfill = next.nextBlock > next.through ? null : next;
      if (logs.length) { this.statsGeneration++; this.cachedStats = null; }
    }
    // A reorg may have shortened the old prefix to an already scanned range.
    if (this.eventTopicBackfill?.nextBlock > this.eventTopicBackfill?.through) {
      this.db.prepare("DELETE FROM metadata WHERE key='eventTopicBackfill'").run();
      this.eventTopicBackfill = null;
    }
  }

  async _scanChunk(fromBlock, toBlock) {
    this.lastScanPhase = 'headers';
    // Global event queries need only the numeric range. Overlap them with
    // header reads, then drain both sides before validating or committing.
    const globalReadsPromise = Promise.allSettled([
      this._logs('factory', [this.factory], fromBlock, toBlock),
      this._logs('market', [this.market], fromBlock, toBlock),
      ...(this.portfolioFactory ? [
        this._logs('portfolioFactory', [this.portfolioFactory], fromBlock, toBlock),
        this._logs('portfolioMarket', [this.portfolioMarket], fromBlock, toBlock),
      ] : []),
    ]);
    const headers = [];
    // Fetch a small, fixed batch concurrently, then validate in chain order.
    // allSettled drains every in-flight read before failure releases the sync lock.
    let headerFailure;
    try {
      for (let first = fromBlock; first <= toBlock; first += this.headerConcurrency) {
        const numbers = Array.from({ length: Math.min(this.headerConcurrency, toBlock - first + 1) }, (_, offset) => first + offset);
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
    } catch (error) { headerFailure = error; }
    // Even a failed header scan must drain started log reads before unlocking sync.
    const globalReads = await globalReadsPromise;
    if (headerFailure) throw headerFailure;
    const failedGlobal = globalReads.findIndex(result => result.status === 'rejected');
    if (failedGlobal >= 0) {
      this.lastScanPhase = ['factory_logs', 'market_logs', 'portfolio_factory_logs', 'portfolio_market_logs'][failedGlobal];
      throw globalReads[failedGlobal].reason;
    }
    const [factoryLogs, marketLogs, portfolioFactoryLogs, portfolioMarketLogs] = globalReads.map(result => result.value);
    const existing = this.db.prepare('SELECT address FROM pools').all().map(row => row.address);
    const created = [];
    let registrationProof;
    const registrationBlock = async () => {
      if (registrationProof === undefined) registrationProof = await this._registrationProof(toBlock);
      return registrationProof?.number ?? toBlock;
    };
    this.lastScanPhase = 'registration';
    for (const log of factoryLogs.filter(log => log.name === 'PoolCreated')) {
      const pool = exactAddress(log.args.pool);
      if (!existing.includes(pool) && !created.some(entry => entry.address === pool)) {
        if (!(await this._call(this.factory, 'isPool', [pool], await registrationBlock()))) throw new Error('Factory event is not registered on-chain.');
        const designatedSubscriber = this.reservationMode === 'required'
          ? getAddress(await this._call(this.factory, 'designatedSubscriber', [pool], registrationProof?.number ?? log.blockNumber)).toLowerCase()
          : ZeroAddress.toLowerCase();
        if (normalizeBlock(await this.provider.getBlock(log.blockNumber)).hash !== log.blockHash)
          throw new Error('Pool creation block changed during reservation proof.');
        created.push({ address: pool, createdBlock: log.blockNumber, collection: exactAddress(log.args.circuits),
          circuitId: log.args.circuitId, designatedSubscriber });
      }
    }
    this.lastScanPhase = 'pool_logs';
    const poolLogs = await this._logs('pool', [...new Set([...existing, ...created.map(entry => entry.address)])], fromBlock, toBlock);
    const portfolioLogs=[],newPortfolios=[],newChildren=[];
    if (this.portfolioFactory) {
      this.lastScanPhase = 'portfolio_registration';
      const factoryEvents=portfolioFactoryLogs;
      const known=this.db.prepare('SELECT address FROM portfolios').all().map(row=>row.address);
      for (const log of factoryEvents) {
        const address=exactAddress(log.args.portfolio);
        if (known.includes(address) || newPortfolios.some(row=>row.address===address)) throw new Error('Duplicate budget project.');
        const proofBlock = await registrationBlock();
        if (!await this._call(this.portfolioFactory,'isPool',[address],proofBlock)
          || exactAddress(await this._call(address,'OFFICIAL_FACTORY',[],proofBlock))!==this.portfolioFactory
          || exactAddress(await this._call(address,'legacyFactory',[],proofBlock))!==this.factory)
          throw new Error('Budget project is not registered to the configured graph.');
        newPortfolios.push({address,createdBlock:log.blockNumber,...log.args});
      }
      this.lastScanPhase = 'portfolio_logs';
      const events=await this._logs('portfolio',[...known,...newPortfolios.map(row=>row.address)],fromBlock,toBlock);
      const corePools=new Set([...existing,...created.map(row=>row.address)]);
      for (const log of events.filter(row=>row.name==='ChildPurchased')) {
        const child=exactAddress(log.args.child);
        if (!corePools.has(child) || this.db.prepare('SELECT 1 FROM portfolio_children WHERE address=?').get(child)
          || newChildren.some(row=>row.address===child)) throw new Error('Unknown or duplicate budget child miner.');
        const raw=await this.provider.call({to:log.address,data:binding.encodeFunctionData('childInfo',[child]),blockTag:await registrationBlock()});
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
    this.lastScanPhase = 'tip_header';
    const canonicalTip = normalizeBlock(await this.provider.getBlock(toBlock));
    if (canonicalTip.number !== toBlock || canonicalTip.hash !== headers.at(-1).hash) {
      throw new Error('Chain changed before index commit.');
    }
    await this._verifyRegistrationProof(registrationProof);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insertHeader = this.db.prepare('INSERT INTO headers(number,hash,parent_hash,timestamp) VALUES(?,?,?,?)');
      const insertPool = this.db.prepare('INSERT INTO pools(address,created_block,collection,circuit_id,designated_subscriber) VALUES(?,?,?,?,?)');
      const insertLog = this.db.prepare('INSERT INTO logs(block_number,tx_index,log_index,tx_hash,address,kind,name,args) VALUES(?,?,?,?,?,?,?,?)');
      for (const header of headers) insertHeader.run(header.number, header.hash, header.parentHash, header.timestamp);
      for (const pool of created) insertPool.run(pool.address, pool.createdBlock, pool.collection, pool.circuitId,pool.designatedSubscriber);
      const insertPortfolio=this.db.prepare('INSERT INTO portfolios(address,created_block,budget,absolute_cap,unit_cap) VALUES(?,?,?,?,?)');
      for (const row of newPortfolios) insertPortfolio.run(row.address,row.createdBlock,row.budgetWei,row.absoluteCapWei,row.unitCapWei);
      const insertChild=this.db.prepare('INSERT INTO portfolio_children(address,portfolio,purchased_block,collection,token_id,cost,official) VALUES(?,?,?,?,?,?,?)');
      for (const row of newChildren) insertChild.run(row.address,row.portfolio,row.purchasedBlock,exactAddress(row.collection),row.tokenId,row.cost,row.official?1:0);
      for (const log of logs) insertLog.run(log.blockNumber, log.txIndex, log.logIndex, log.txHash, log.address, log.kind, log.name, JSON.stringify(log.args));
      this._setIndexedThrough(toBlock);
      this.db.exec('COMMIT');
      if (logs.length) this.statsGeneration++;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  async sync() {
    if (this.syncing) throw new Error('Index sync already running.');
    this.syncing = true;
    let resolveSync;
    this.syncSettled = new Promise(resolve => { resolveSync = resolve; });
    let stage = 'latest_header';
    this.lastScanPhase = null;
    try {
      if (this.db.prepare("SELECT value FROM metadata WHERE key='historyRepair'").get()?.value === 'pending') {
        stage = 'history_rebuild';
        this._restartHistoryAfterIncompleteProof();
        stage = 'latest_header';
      }
      // Save the last fully verified tip before the first RPC. If even the
      // latest-header read fails, display-only history can still be served.
      // Never use this view to authorize notifications or transactions.
      const verified = this.status();
      if (verified.complete) {
        try { await this._saveVerifiedReadView(); } catch { /* Fresh indexing remains authoritative. */ }
      }
      const latest = normalizeBlock(await this.provider.getBlock('latest'));
      const safeHead = latest.number - this.confirmations;
      if (safeHead < this.startBlock) throw new Error('Configured deployment block is not yet confirmed.');
      this.observedSafeHead = safeHead;
      // A load-balanced RPC can briefly report a shorter latest chain. That
      // alone is not proof of a reorg and must not erase committed history.
      // Reconcile by hash once the endpoint can serve the indexed tip again.
      stage = 'safe_head';
      if (this.indexedThrough > safeHead) throw new Error('RPC safe head regressed below the indexed tip.');
      stage = 'deployment';
      await this._verifyDeployment(safeHead);
      stage = 'reconcile';
      await this._reconcile();
      stage = 'reservation_backfill';
      await this._backfillPoolReservations();
      stage = 'event_topic_backfill';
      const backfillBefore = this.eventTopicBackfill;
      await this._backfillNewEventTopics();
      if (this.eventTopicBackfill) {
        this.ready = false;
        this.lastError = null;
        this.checkedAt = new Date().toISOString();
        this.lastFailureStage = null;
        return this.status();
      }
      const saved = this.db.prepare('SELECT source FROM verified_display_snapshot WHERE id = 1').get();
      if (saved && !this.snapshotTrusted) {
        const source = JSON.parse(saved.source);
        this.snapshotTrusted = source.indexedThrough <= this.indexedThrough
          && normalizeBlock(await this.provider.getBlock(source.indexedThrough)).hash === source.indexedBlockHash;
        if (this.snapshotTrusted) this.verifiedDisplaySnapshotCache = undefined;
        else {
          this.verifiedDisplaySnapshotCache = null;
          this.db.prepare('DELETE FROM verified_display_snapshot WHERE id = 1').run();
        }
      }
      const backfilled = backfillBefore ? (this.eventTopicBackfill?.nextBlock ?? backfillBefore.through+1)-backfillBefore.nextBlock : 0;
      const until = Math.min(safeHead, this.indexedThrough + this.maxBlocksPerSync-backfilled);
      stage = 'scan';
      for (let from = this.indexedThrough + 1; from <= until; from += this.scanRange) {
        await this._scanChunk(from, Math.min(until, from + this.scanRange - 1));
      }
      stage = 'canonical_tip';
      if (this.indexedThrough >= this.startBlock) {
        const stored = this._header(this.indexedThrough);
        if (stored.hash !== normalizeBlock(await this.provider.getBlock(this.indexedThrough)).hash) {
          await this._reconcile();
          throw new Error('Chain changed after index commit; retry sync.');
        }
      }
      stage = 'history_complete';
      if (this.indexedThrough === safeHead) await this._verifyHistoryComplete(safeHead);
      this.lastError = null;
      this.checkedAt = new Date().toISOString();
      this.ready = this.indexedThrough === safeHead;
      if (this.ready) this.db.prepare("DELETE FROM metadata WHERE key='historyRepair'").run();
      stage = 'snapshot';
      if (this.ready) {
        try {
          this._captureVerifiedSnapshot();
          this.lastSnapshotError = null;
        } catch {
          // This is a derived, display-only copy. A serialization or directory
          // error must not invalidate the already verified authoritative index.
          this.snapshotTrusted = false;
          this.verifiedDisplaySnapshotCache = null;
          this.lastSnapshotError = 'snapshot_failed';
          this.db.prepare('DELETE FROM verified_display_snapshot WHERE id = 1').run();
        }
      }
      this.lastFailureStage = null;
      return this.status();
    } catch (error) {
      this.lastFailureStage = stage === 'scan' && this.lastScanPhase ? `scan_${this.lastScanPhase}` : stage;
      // Status is public. Never echo provider errors, which may contain an RPC
      // URL with credentials or an upstream response body.
      this.lastError = error instanceof Error && error.message === 'RPC is not BSC mainnet (56).'
        ? 'wrong_chain' : error instanceof Error && error.message.startsWith('Event history is incomplete')
          ? 'incomplete_history' : error instanceof Error && [
            'Factory/market code or binding mismatch.', 'Portfolio deployment binding mismatch.',
            'Factory reservation capability requires a required-mode index.', 'Fresh manifest codehash mismatch.',
          ].includes(error.message)
            ? 'invalid_binding' : error instanceof Error && error.message === 'RPC safe head regressed below the indexed tip.'
              ? 'rpc_lagging' : 'sync_failed';
      if (this.lastError === 'incomplete_history' && stage === 'history_complete'
        && !this.db.prepare("SELECT value FROM metadata WHERE key='historyRepair'").get()) {
        this.db.prepare("INSERT INTO metadata(key,value) VALUES('historyRepair','pending')").run();
      }
      this.checkedAt = new Date().toISOString();
      throw error;
    } finally {
      try {
        // Transient RPC failures do not invalidate the previously verified
        // read-only tip. Reorg rollback invalidates it separately. A chain or
        // history proof failure must fail closed even for display reads.
        if (!this.lastError) this._retireVerifiedReadView();
        else if (['wrong_chain', 'incomplete_history', 'invalid_binding'].includes(this.lastError)) this._invalidateVerifiedHistory();
      }
      finally { this.syncing = false; resolveSync(); this.syncSettled = null; }
    }
  }

  _captureVerifiedSnapshot() {
    const source = this.status();
    if (!source.complete) throw new Error('Only a fully verified source can be saved.');
    const counts = this._poolCounts();
    const pools = this.db.prepare(`SELECT address,created_block AS createdBlock,collection,circuit_id AS circuitId FROM pools
      WHERE designated_subscriber = ? AND address NOT IN (SELECT address FROM portfolio_children)
      ORDER BY created_block DESC,address DESC LIMIT 501`).all(ZeroAddress.toLowerCase());
    const reserved = this._reservedChildPoolAddresses(counts.reservedChildPoolCount);
    const portfolios = this.db.prepare('SELECT address,created_block AS createdBlock,budget AS budgetWei,absolute_cap AS absoluteCapWei,unit_cap AS unitCapWei FROM portfolios ORDER BY created_block,address LIMIT 501').all()
      .map(row => ({ ...row, kind: 'portfolio', factory: this.portfolioFactory }));
    const poolsAvailable = pools.length <= 500;
    const portfoliosAvailable = portfolios.length <= 500;
    const portfolioCount = this.db.prepare('SELECT COUNT(*) AS n FROM portfolios').get().n;
    if (poolsAvailable && pools.length !== counts.standalonePoolCount) throw new Error('Verified pool directory is incomplete.');
    if (portfoliosAvailable && portfolios.length !== portfolioCount) throw new Error('Verified budget directory is incomplete.');
    const orderCount = this.db.prepare("SELECT COUNT(*) AS n FROM logs WHERE kind = 'market' AND name = 'OrderListed'").get().n;
    let orders = null;
    if (orderCount <= 500) {
      const page = this.orders({ limit: 500, allowSnapshotLimit: true });
      orders = page.items;
      if (page.nextCursor !== null || orders.length !== orderCount) throw new Error('Verified order directory is incomplete.');
    }
    // Stats are aggregated, not a serialized copy of log history. A large
    // history must not silently disable the verified /v1/stats fallback.
    const stats = this.stats();
    const snapshotSource = { ...source, readMode: 'verified_snapshot', registeredPoolCount: String(counts.registeredPoolCount),
      childPoolCount: String(counts.childPoolCount), reservedChildPoolCount: String(counts.reservedChildPoolCount),
      reservedChildPoolAddresses: reserved.addresses, reservedChildPoolAddressesComplete: reserved.complete,
      standalonePoolCount: String(counts.standalonePoolCount), portfolioCount: String(portfolioCount),
      poolsAvailable, portfoliosAvailable, ordersAvailable: orders !== null };
    const row = { source: JSON.stringify(snapshotSource), pools: JSON.stringify(poolsAvailable ? pools : null),
      stats: stats ? JSON.stringify(stats) : null, portfolios: JSON.stringify(portfoliosAvailable ? portfolios : null),
      orders: orders ? JSON.stringify(orders) : null };
    const parsed = parseDisplaySnapshot(row);
    this.db.prepare('INSERT INTO verified_display_snapshot(id,source,pools,stats,portfolios,orders) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source=excluded.source,pools=excluded.pools,stats=excluded.stats,portfolios=excluded.portfolios,orders=excluded.orders')
      .run(row.source, row.pools, row.stats, row.portfolios, row.orders);
    this.verifiedDisplaySnapshotCache = parsed;
    this.snapshotTrusted = true;
  }

  verifiedDisplaySnapshot() {
    if (!this.snapshotTrusted || ['wrong_chain', 'incomplete_history', 'invalid_binding'].includes(this.lastError)) return null;
    if (this.verifiedDisplaySnapshotCache === undefined) {
      const saved = this.db.prepare('SELECT source,pools,stats,portfolios,orders FROM verified_display_snapshot WHERE id = 1').get();
      try { this.verifiedDisplaySnapshotCache = saved ? parseDisplaySnapshot(saved) : null; }
      catch { this.verifiedDisplaySnapshotCache = null; }
    }
    const snapshot = this.verifiedDisplaySnapshotCache;
    if (!snapshot) return null;
    const { source } = snapshot;
    if (Date.now() - Date.parse(source.checkedAt) > 30 * 60 * 1000 || source.indexedThrough > this.indexedThrough) {
      this.verifiedDisplaySnapshotCache = null;
      return null;
    }
    if (!Array.isArray(source.reservedChildPoolAddresses)
      || typeof source.reservedChildPoolAddressesComplete !== 'boolean'
      || source.reservedChildPoolAddresses.length !== Math.min(Number(source.reservedChildPoolCount), 500)
      || source.reservedChildPoolAddressesComplete !== (Number(source.reservedChildPoolCount) <= 500)) {
      this.verifiedDisplaySnapshotCache = null;
      return null;
    }
    return snapshot;
  }

  verifiedDisplayPool(address, snapshot) {
    if (!snapshot?.source || !this.snapshotTrusted) throw new Error('A verified display source is required.');
    const target = exactAddress(address);
    if (Array.isArray(snapshot.pools)) return snapshot.pools.find(row => row.address === target) ?? null;
    // The all-pools snapshot intentionally has a 500-row ceiling. A deep
    // link can still read one proven pool from the same canonical index tip.
    // Never return a row created after the displayed source block.
    return this.db.prepare(`SELECT address,created_block AS createdBlock,collection,circuit_id AS circuitId FROM pools
      WHERE address = ? AND created_block <= ? AND designated_subscriber = ?
      AND address NOT IN (SELECT address FROM portfolio_children)`).get(
        target, snapshot.source.indexedThrough, ZeroAddress.toLowerCase()) ?? null;
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

  _poolCounts() {
    if (this.reservationMigrationPending) throw new Error('Pool reservations have not been verified.');
    const registeredPoolCount = this.db.prepare('SELECT COUNT(*) AS n FROM pools').get().n;
    const childPoolCount = this.db.prepare('SELECT COUNT(*) AS n FROM portfolio_children').get().n;
    const reservedChildPoolCount = this.db.prepare(`SELECT COUNT(*) AS n FROM pools p
      WHERE p.designated_subscriber != ? AND p.address NOT IN (SELECT address FROM portfolio_children)`)
      .get(ZeroAddress.toLowerCase()).n;
    const standalonePoolCount = this.db.prepare(`SELECT COUNT(*) AS n FROM pools p
      WHERE p.designated_subscriber = ? AND p.address NOT IN (SELECT address FROM portfolio_children)`)
      .get(ZeroAddress.toLowerCase()).n;
    if (registeredPoolCount !== standalonePoolCount + childPoolCount + reservedChildPoolCount)
      throw new Error('Pool reservation classification is incomplete.');
    return { registeredPoolCount, childPoolCount, reservedChildPoolCount, standalonePoolCount };
  }

  _reservedChildPoolAddresses(expectedCount) {
    const rows = this.db.prepare(`SELECT p.address FROM pools p WHERE p.designated_subscriber != ?
      AND p.address NOT IN (SELECT address FROM portfolio_children)
      ORDER BY p.created_block,p.address LIMIT 501`).all(ZeroAddress.toLowerCase());
    if (rows.length !== Math.min(expectedCount, 501))
      throw new Error('Reserved child pool directory count is inconsistent.');
    // Keep ordinary pages bounded even if the Factory eventually has more
    // than 500 unpurchased children. The count remains exact, and consumers
    // can reject an incomplete directory without disabling the whole index.
    return { addresses: rows.slice(0, 500).map(row => row.address), complete: expectedCount <= 500 };
  }

  notifications(options = {}) { return notificationPage(this, interfaces.pool, options); }

  pools({ cursor = 0, limit = 20 } = {}) {
    integer(cursor, 'cursor'); integer(limit, 'limit', 1);
    if (limit > 50) throw new Error('Page limit exceeds 50.');
    const counts = this._poolCounts();
    const reserved = this._reservedChildPoolAddresses(counts.reservedChildPoolCount);
    const rows = this.db.prepare(`SELECT address,created_block AS createdBlock,collection,circuit_id AS circuitId FROM pools
      WHERE designated_subscriber = ? AND address NOT IN (SELECT address FROM portfolio_children)
      ORDER BY created_block,address LIMIT ? OFFSET ?`).all(ZeroAddress.toLowerCase(),limit + 1, cursor);
    return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? cursor + limit : null,
      registeredPoolCount: String(counts.registeredPoolCount), childPoolCount: String(counts.childPoolCount),
      reservedChildPoolCount: String(counts.reservedChildPoolCount),
      reservedChildPoolAddresses: reserved.addresses, reservedChildPoolAddressesComplete: reserved.complete,
      standalonePoolCount: String(counts.standalonePoolCount) };
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
    const counts = this._poolCounts();
    const cacheKey = this.statsGeneration;
    if (this.cachedStats?.key === cacheKey) return this.cachedStats.value;
    const reserved = this._reservedChildPoolAddresses(counts.reservedChildPoolCount);
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
    const value = { scope: 'confirmed_indexed_history', registeredPoolCount: String(counts.registeredPoolCount),
      standalonePoolCount:String(counts.standalonePoolCount),portfolioCount:String(portfolioCount),
      childPoolCount:String(counts.childPoolCount),reservedChildPoolCount:String(counts.reservedChildPoolCount),
      reservedChildPoolAddresses: reserved.addresses, reservedChildPoolAddressesComplete: reserved.complete,
      topLevelProjectCount:String(counts.standalonePoolCount+portfolioCount),
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

  orders({ pool, seller, active, cursor, limit = 20, portfolio = false, allowSnapshotLimit = false } = {}) {
    const targetPool = pool === undefined ? null : exactAddress(pool);
    const targetSeller = seller === undefined ? null : exactAddress(seller);
    if (active !== undefined && typeof active !== 'boolean') throw new Error('Invalid active filter.');
    if (cursor !== undefined && !/^[1-9]\d*$/.test(String(cursor))) throw new Error('Invalid order cursor.');
    integer(limit, 'limit', 1); if (limit > (allowSnapshotLimit === true ? 500 : 50)) throw new Error('Page limit exceeds 50.');
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
      executable: false, // Re-read current order and pool state before a wallet signature.
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
          : event.kind==='portfolioFactory' && event.name==='PortfolioCreated' ? a.portfolio
            : ['market','portfolioMarket'].includes(event.kind) && event.name === 'SaleReviewed'
              ? a.pool : orderPools.get(orderKey) ?? null;
      if (targetPool && eventPool !== targetPool) continue;
      if (targetAccount && ![a.user, a.member, a.proposer, a.voter, a.seller, a.buyer, a.treasury, a.from, a.to,
        a.operator, orderSellers.get(orderKey)]
        .some(value => value && lower(value) === targetAccount)) continue;
      items.push({ blockNumber: event.blockNumber,
        transactionHash: event.txHash, transactionIndex: event.txIndex, logIndex: event.logIndex,
        contract: event.address, pool: eventPool, source: event.kind, event: event.name, fields: a });
    }
    items.reverse();
    // Counts belong to the entire filtered SQLite read view, not the remaining
    // cursor slice. The overview uses the same subscription merge as the UI.
    const totalCount = items.length, overviewTotalCount = summarizeOverviewActivity(items).length;
    const remaining = cursorParts ? items.filter(event => event.blockNumber < cursorParts[0]
      || event.blockNumber === cursorParts[0] && (event.transactionIndex < cursorParts[1]
        || event.transactionIndex === cursorParts[1] && event.logIndex < cursorParts[2])) : items;
    const page = remaining.slice(0, limit).map(event => {
      const header = this._header(event.blockNumber);
      return { ...event, blockHash: header.hash, timestamp: header.timestamp };
    });
    const last = page.at(-1);
    return { items: page, totalCount, overviewTotalCount,
      nextCursor: remaining.length > limit ? `${last.blockNumber}:${last.transactionIndex}:${last.logIndex}` : null };
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
