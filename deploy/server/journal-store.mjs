import { mkdirSync, chmodSync, existsSync, lstatSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseEther, parseUnits } from 'ethers';
import { validateFreshActivationProgress } from './fresh-activation-journal.mjs';

export class JournalConflict extends Error {}

const read = value => value === null ? null : JSON.parse(value);
const canonical = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});
const same = (a, b) => canonical(a) === canonical(b);
const productKey=record=>canonical([record.nonce,record.factory.toLowerCase(),record.target.toLowerCase(),record.data.toLowerCase(),record.value,record.submittedAt]);

/** Private, durable operation journal. A revision survives archival/deletion. */
export class JournalStore {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (statSync(dirname(path)).mode & 0o077) throw new Error('Journal database directory must be private (0700).');
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Journal database must not be a symlink.');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS challenges (nonce TEXT PRIMARY KEY, account TEXT NOT NULL, message TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS challenges_account ON challenges(account);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, account TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deployment (account TEXT PRIMARY KEY, revision INTEGER NOT NULL, record TEXT);
      CREATE TABLE IF NOT EXISTS fresh_activation (account TEXT PRIMARY KEY, revision INTEGER NOT NULL, record TEXT);
      CREATE TABLE IF NOT EXISTS deployment_archives (account TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL,
        PRIMARY KEY(account,id));
      CREATE TABLE IF NOT EXISTS market (account TEXT PRIMARY KEY, revision INTEGER NOT NULL, record TEXT);
      CREATE TABLE IF NOT EXISTS market_abandoned (account TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL, abandoned_at INTEGER NOT NULL, PRIMARY KEY(account,revision));
      CREATE TABLE IF NOT EXISTS market_signing (account TEXT PRIMARY KEY, intent_key TEXT NOT NULL, armed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS market_results (account TEXT NOT NULL, hash TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(account,hash));
      CREATE TABLE IF NOT EXISTS budget_queues (account TEXT NOT NULL, parent TEXT NOT NULL, revision INTEGER NOT NULL,
        record TEXT NOT NULL, PRIMARY KEY(account,parent));
      CREATE TABLE IF NOT EXISTS quotes (id TEXT PRIMARY KEY, account TEXT NOT NULL, record TEXT NOT NULL, created_at INTEGER NOT NULL);`);
    this.db.exec('CREATE INDEX IF NOT EXISTS quotes_account_recent ON quotes(account,created_at DESC);');
    // Existing journals predate the one-use legacy wallet envelope. Serialize
    // the schema check so two service processes cannot race the migration.
    this.transaction(() => {
      if (!this.db.prepare('PRAGMA table_info(market_signing)').all().some(column => column.name === 'legacy_issued_at'))
        this.db.exec('ALTER TABLE market_signing ADD COLUMN legacy_issued_at INTEGER');
    });
  }

  close() { this.db.close(); }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  issueChallenge(account, nonce, message, expires) {
    const now = Date.now();
    const existing = this.db.prepare('SELECT nonce,message,expires FROM challenges WHERE account=? AND expires>=? ORDER BY expires DESC LIMIT 1')
      .get(account, now);
    if (existing) return existing;
    return this.transaction(() => {
      if (!this.lastChallengePrune || now - this.lastChallengePrune >= 60_000) {
        this.db.prepare('DELETE FROM challenges WHERE expires < ?').run(now);
        this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
        this.lastChallengePrune = now;
      }
      this.db.prepare('INSERT INTO challenges(nonce,account,message,expires) VALUES(?,?,?,?)')
        .run(nonce, account, message, expires);
      return { nonce, message, expires };
    });
  }
  challenge(account, nonce) {
    return this.db.prepare('SELECT message,expires FROM challenges WHERE account=? AND nonce=?').get(account, nonce);
  }
  consumeChallenge(account, nonce, tokenHash, expires) {
    return this.transaction(() => {
      const result = this.db.prepare('DELETE FROM challenges WHERE account=? AND nonce=? AND expires>=?').run(account, nonce, Date.now());
      if (result.changes !== 1) return false;
      this.db.prepare('DELETE FROM challenges WHERE account=?').run(account);
      this.db.prepare('INSERT INTO sessions(token_hash,account,expires) VALUES(?,?,?)').run(tokenHash, account, expires);
      return true;
    });
  }
  session(tokenHash) {
    const row = this.db.prepare('SELECT account,expires FROM sessions WHERE token_hash=?').get(tokenHash);
    return row && row.expires > Date.now() ? row.account : null;
  }

  deployment(account) {
    const current = this.db.prepare('SELECT revision,record FROM deployment WHERE account=?').get(account);
    const archivePage = this.archives(account, null, 100);
    const completed = this.db.prepare(`SELECT record FROM deployment_archives
      WHERE account=? AND json_extract(record, '$.status')='complete' ORDER BY rowid DESC LIMIT 1`).get(account);
    return { record: read(current?.record ?? null), revision: current?.revision ?? 0,
      archives: archivePage.items, archiveNextCursor: archivePage.nextCursor,
      latestCompleted: read(completed?.record ?? null) };
  }
  freshActivation(account) {
    const row = this.db.prepare('SELECT revision,record FROM fresh_activation WHERE account=?').get(account);
    return { record: read(row?.record ?? null), revision: row?.revision ?? 0 };
  }
  putFreshActivation(account, record, expectedRevision) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT revision,record FROM fresh_activation WHERE account=?').get(account);
      const revision = row?.revision ?? 0;
      if (revision !== expectedRevision) throw new JournalConflict('Fresh activation revision changed.');
      const previous = read(row?.record ?? null);
      if (previous) {
        try { validateFreshActivationProgress(previous, record); }
        catch (error) { throw new JournalConflict(error.message); }
      }
      if (record.steps.some((step, i) => step.status === 'signing' && previous?.steps[i]?.status !== 'signing')
        && this.db.prepare('SELECT 1 FROM market WHERE account=? AND record IS NOT NULL').get(account))
        throw new JournalConflict('This wallet has an unresolved product or market transaction.');
      const next = revision + 1;
      this.db.prepare(`INSERT INTO fresh_activation(account,revision,record) VALUES(?,?,?)
        ON CONFLICT(account) DO UPDATE SET revision=excluded.revision,record=excluded.record`)
        .run(account, next, canonical(record));
      return next;
    });
  }
  /** The API checks the live chain nonce before this revision-guarded release. */
  releaseUnusedFreshSigning(account, expectedRevision, stepId, nonce, dataHash) {
    return this.transaction(() => {
      const current = this.db.prepare('SELECT revision,record FROM fresh_activation WHERE account=?').get(account);
      if (!current || current.revision !== expectedRevision) throw new JournalConflict('Fresh activation revision changed.');
      const record = read(current.record);
      const index = record?.steps?.findIndex(step => step.status !== 'confirmed') ?? -1;
      const step = record?.steps?.[index];
      if (record?.status !== 'paused' || step?.id !== stepId || step.status !== 'signing'
        || step.nonce !== nonce || step.dataHash !== dataHash || step.txHash || step.receipt
        || index < 0 || !record.steps.slice(0, index).every(item => item.status === 'confirmed')
        || !record.steps.slice(index + 1).every(item => item.status === 'waiting'))
        throw new JournalConflict('Only the matching hashless signing intent may be released.');
      step.status = 'rejected';
      step.rejectionKind = 'nonce-witnessed';
      step.error = '服务器与钱包 nonce 均未使用；只可人工按原交易意图重试。';
      record.error = '原签名没有交易哈希，双重 nonce 核对仍未使用。可人工按原交易意图重试；不会自动发送。';
      record.updatedAt = new Date().toISOString();
      const revision = current.revision + 1;
      this.db.prepare('UPDATE fresh_activation SET revision=?,record=? WHERE account=?')
        .run(revision, canonical(record), account);
      return { revision, record };
    });
  }
  /** Called only after the API independently verifies the canonical winner and finalized prefix roles. */
  recoverFinalizedFreshAttempt(account, expectedRevision, proof) {
    return this.transaction(() => {
      const current = this.db.prepare('SELECT revision,record FROM fresh_activation WHERE account=?').get(account);
      if (!current || current.revision !== expectedRevision)
        throw new JournalConflict('Fresh activation revision changed.');
      const record = read(current.record);
      const index = record?.steps?.findIndex(step => step.status !== 'confirmed') ?? -1;
      const step = record?.steps?.[index];
      if (record?.status !== 'aborted' || index < 0 || step?.id !== proof.stepId
        || !['failed','replaced'].includes(step.status) || step.nonce !== proof.nonce
        || (step.replacementHash ?? step.txHash)?.toLowerCase() !== proof.winnerHash.toLowerCase()
        || !step.receipt || step.receipt.blockHash !== proof.receiptBlockHash
        || step.receipt.blockNumber !== proof.receiptBlockNumber
        || !record.steps.slice(0,index).every(item => item.status === 'confirmed')
        || !record.steps.slice(index+1).every(item => item.status === 'waiting'))
        throw new JournalConflict('Finalized failed attempt or revision changed.');
      const {attempts = [], ...failedAttempt} = step;
      record.steps[index] = {id:step.id,label:step.label,status:'waiting',attempts:[...attempts,
        {...failedAttempt,recovery:{winnerHash:proof.winnerHash,
          finalizedBlockNumber:proof.finalizedBlockNumber,
          finalizedBlockHash:proof.finalizedBlockHash}}]};
      record.status = 'paused';
      record.error = '失败尝试及最终确认的同 nonce 赢家已永久保留；须再次人工确认同一动作的新 nonce。';
      record.updatedAt = new Date().toISOString();
      const revision = current.revision + 1;
      this.db.prepare('UPDATE fresh_activation SET revision=?,record=? WHERE account=?')
        .run(revision, canonical(record), account);
      return {revision,record};
    });
  }
  archives(account, cursor, limit) {
    const sql = cursor === null
      ? 'SELECT CAST(rowid AS TEXT) AS cursor,record FROM deployment_archives WHERE account=? ORDER BY rowid DESC LIMIT ?'
      : 'SELECT CAST(rowid AS TEXT) AS cursor,record FROM deployment_archives WHERE account=? AND rowid < CAST(? AS INTEGER) ORDER BY rowid DESC LIMIT ?';
    const rows = cursor === null
      ? this.db.prepare(sql).all(account, limit + 1)
      : this.db.prepare(sql).all(account, cursor, limit + 1);
    const page = rows.slice(0, limit);
    return { items: page.map(row => read(row.record)),
      nextCursor: rows.length > limit ? page.at(-1).cursor : null };
  }
  putDeployment(account, record, expectedRevision) {
    return this.transaction(() => {
      const current = this.db.prepare('SELECT revision,record FROM deployment WHERE account=?').get(account);
      const revision = current?.revision ?? 0;
      if (revision !== expectedRevision) throw new JournalConflict('Deployment revision changed.');
      const previous = read(current?.record ?? null);
      // A wallet has one signing lane across deployment and product/market pages.
      // Existing deployment progress may still be saved during reconciliation.
      if ((!previous || record.steps.some((step, i) => step.status === 'signing' && previous.steps[i]?.status !== 'signing'))
        && this.db.prepare('SELECT 1 FROM market WHERE account=? AND record IS NOT NULL').get(account))
        throw new JournalConflict('This wallet has an unresolved product or market transaction.');
      if (previous && previous.id !== record.id) throw new JournalConflict('An active deployment already exists.');
      if (!previous && this.db.prepare('SELECT 1 FROM deployment_archives WHERE account=? AND id=?').get(account, record.id))
        throw new JournalConflict('Archived deployment ID cannot be reused.');
      if (previous) validateDeploymentProgress(previous, record);
      const next = revision + 1;
      this.db.prepare(`INSERT INTO deployment(account,revision,record) VALUES(?,?,?)
        ON CONFLICT(account) DO UPDATE SET revision=excluded.revision,record=excluded.record`)
        .run(account, next, canonical(record));
      return next;
    });
  }
  /** Server-approved resolution for a known wallet envelope validation failure. */
  releaseInvalidEnvelope(account, expectedRevision, nonce) {
    return this.transaction(() => {
      const current = this.db.prepare('SELECT revision,record FROM deployment WHERE account=?').get(account);
      if (!current || current.revision !== expectedRevision) throw new JournalConflict('Deployment revision changed.');
      const record = read(current.record);
      const step = record.steps.at(-1);
      const error = 'Invalid transaction envelope type: specified type "0x4" but included a gasPrice instead of maxFeePerGas and maxPriorityFeePerGas';
      if (record.status !== 'paused' || step?.id !== 'initialize' || step.status !== 'uncertain'
        || step.nonce !== nonce || step.error !== error || step.txHash || step.receipt
        || !record.steps.slice(0, -1).every(item => item.status === 'confirmed'))
        throw new JournalConflict('Only the exact unsent initialization envelope may be released.');
      step.status = 'rejected';
      step.rejectionKind = 'pre-send';
      delete record.error;
      record.updatedAt = new Date().toISOString();
      const revision = current.revision + 1;
      this.db.prepare('UPDATE deployment SET revision=?,record=? WHERE account=?')
        .run(revision, canonical(record), account);
      return { revision, record };
    });
  }
  archiveDeployment(account, id, expectedRevision) {
    return this.transaction(() => {
      const current = this.db.prepare('SELECT revision,record FROM deployment WHERE account=?').get(account);
      if (!current || current.revision !== expectedRevision) throw new JournalConflict('Deployment revision changed.');
      const record = read(current.record);
      if (!record || record.id !== id || !['aborted','complete'].includes(record.status))
        throw new JournalConflict('Only the matching completed or aborted deployment can be archived.');
      if (record.status === 'complete' && record.steps.some(step => step.id === 'FreshPoolFactory'))
        throw new JournalConflict('Fresh genesis must remain active with its Authority activation journal.');
      this.db.prepare('INSERT INTO deployment_archives(account,id,record) VALUES(?,?,?)').run(account, id, canonical(record));
      this.db.prepare('UPDATE deployment SET revision=?,record=NULL WHERE account=?').run(current.revision + 1, account);
      const state = this.deployment(account);
      return { revision: state.revision, archives: state.archives,
        archiveNextCursor: state.archiveNextCursor, latestCompleted: state.latestCompleted };
    });
  }
  importArchive(account, record) {
    return this.transaction(() => {
      if (record.status !== 'aborted') throw new JournalConflict('Only aborted deployments can be imported as archives.');
      const active = this.db.prepare('SELECT record FROM deployment WHERE account=?').get(account);
      if (active?.record && read(active.record).id === record.id) throw new JournalConflict('Deployment is still active.');
      const existing = this.db.prepare('SELECT record FROM deployment_archives WHERE account=? AND id=?').get(account, record.id);
      if (existing) {
        if (!same(read(existing.record), record)) throw new JournalConflict('Archive ID has different contents.');
        return record.id;
      }
      this.db.prepare('INSERT INTO deployment_archives(account,id,record) VALUES(?,?,?)')
        .run(account, record.id, canonical(record));
      return record.id;
    });
  }

  market(account) {
    const row = this.db.prepare('SELECT revision,record FROM market WHERE account=?').get(account);
    return { record: read(row?.record ?? null), revision: row?.revision ?? 0 };
  }
  budgetQueue(account, parent) {
    const row = this.db.prepare('SELECT revision,record FROM budget_queues WHERE account=? AND parent=?').get(account, parent);
    return { revision: row?.revision ?? 0, record: read(row?.record ?? null) };
  }
  putBudgetQueue(account, parent, record, expectedRevision) {
    return this.transaction(() => {
      const current = this.budgetQueue(account, parent);
      if (current.revision !== expectedRevision) throw new JournalConflict('Purchase queue changed in another session. Reload it before sending.');
      if (current.record) validateBudgetQueueProgress(current.record, record);
      const next = current.revision + 1;
      this.db.prepare(`INSERT INTO budget_queues(account,parent,revision,record) VALUES(?,?,?,?)
        ON CONFLICT(account,parent) DO UPDATE SET revision=excluded.revision,record=excluded.record`)
        .run(account, parent, next, canonical(record));
      return next;
    });
  }
  marketResult(account, hash) {
    const row = this.db.prepare('SELECT result FROM market_results WHERE account=? AND hash=?').get(account, hash.toLowerCase());
    return read(row?.result ?? null);
  }
  putMarket(account, record, expectedRevision) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT revision,record FROM market WHERE account=?').get(account);
      const revision = row?.revision ?? 0;
      if (revision !== expectedRevision) throw new JournalConflict('Market revision changed.');
      const previous = read(row?.record ?? null);
      const deployment=read(this.db.prepare('SELECT record FROM deployment WHERE account=?').get(account)?.record ?? null);
      if (!previous && deployment && (deployment.status!=='complete' || deployment.steps.some(step=>step.status!=='confirmed')))
        throw new JournalConflict('Archive or reconcile this wallet\'s active deployment before another transaction.');
      if (previous) validateMarketProgress(previous, record);
      const next = revision + 1;
      this.db.prepare(`INSERT INTO market(account,revision,record) VALUES(?,?,?)
        ON CONFLICT(account) DO UPDATE SET revision=excluded.revision,record=excluded.record`)
        .run(account, next, canonical(record));
      return next;
    });
  }
  /** Save the verified intent and consume its one-use signing permission in one durable commit. */
  prepareAndArmMarket(account, record, expectedRevision) {
    return this.transaction(() => {
      const current = this.market(account);
      if (current.revision !== expectedRevision || current.record)
        throw new JournalConflict('Market revision changed.');
      const deployment=read(this.db.prepare('SELECT record FROM deployment WHERE account=?').get(account)?.record ?? null);
      if (deployment && (deployment.status!=='complete' || deployment.steps.some(step=>step.status!=='confirmed')))
        throw new JournalConflict('This wallet has an unresolved deployment.');
      const key=productKey(record);
      const prior=this.db.prepare('SELECT intent_key FROM market_signing WHERE account=?').get(account);
      if (prior?.intent_key===key)
        throw new JournalConflict('This product signing permission was already consumed. Recover the wallet hash; do not resend.');
      const next=expectedRevision+2;
      this.db.prepare(`INSERT INTO market(account,revision,record) VALUES(?,?,?)
        ON CONFLICT(account) DO UPDATE SET revision=excluded.revision,record=excluded.record`)
        .run(account,next,canonical(record));
      this.db.prepare(`INSERT INTO market_signing(account,intent_key,armed_at,legacy_issued_at) VALUES(?,?,?,NULL)
        ON CONFLICT(account) DO UPDATE SET intent_key=excluded.intent_key,armed_at=excluded.armed_at,legacy_issued_at=NULL`)
        .run(account,key,Date.now());
      return next;
    });
  }
  canRequestLegacyMarketEnvelope(account) {
    const {record}=this.market(account);
    if (!record || record.version!==2 || record.hash || record.recoveryHashes?.length || record.cancellationRequests?.length)
      return false;
    const signing=this.db.prepare('SELECT intent_key,legacy_issued_at FROM market_signing WHERE account=?').get(account);
    return signing?.intent_key===productKey(record) && signing.legacy_issued_at===null;
  }
  legacyMarketEnvelopeIssued(account) {
    const {record}=this.market(account);
    if (!record || record.version!==2) return false;
    const signing=this.db.prepare('SELECT intent_key,legacy_issued_at FROM market_signing WHERE account=?').get(account);
    return signing?.intent_key===productKey(record) && signing.legacy_issued_at!==null;
  }
  /** A second envelope keeps the already armed payload and nonce; only one can execute. */
  authorizeLegacyMarketEnvelope(account, expectedRevision) {
    return this.transaction(() => {
      const current=this.market(account);
      if (current.revision!==expectedRevision || !this.canRequestLegacyMarketEnvelope(account))
        throw new JournalConflict('Legacy wallet envelope is unavailable for this product intent.');
      const changed=this.db.prepare(`UPDATE market_signing SET legacy_issued_at=?
        WHERE account=? AND intent_key=? AND legacy_issued_at IS NULL`)
        .run(Date.now(),account,productKey(current.record));
      if (changed.changes!==1) throw new JournalConflict('Legacy wallet envelope was already issued.');
      this.db.prepare('UPDATE market SET revision=? WHERE account=?').run(expectedRevision+1,account);
      return expectedRevision+1;
    });
  }
  canAbandonMarket(account) {
    const {record}=this.market(account);
    if (!record || record.version!==2 || record.hash || record.recoveryHashes?.length || record.cancellationRequests?.length) return false;
    return this.db.prepare('SELECT intent_key FROM market_signing WHERE account=?').get(account)?.intent_key!==productKey(record);
  }
  abandonMarket(account, expectedRevision) {
    return this.transaction(()=>{
      const current=this.market(account);
      if (current.revision!==expectedRevision || !this.canAbandonMarket(account))
        throw new JournalConflict('Only a preparation that never received signing permission may be cleared.');
      this.db.prepare('INSERT INTO market_abandoned(account,revision,record,abandoned_at) VALUES(?,?,?,?)')
        .run(account,expectedRevision,canonical(current.record),Date.now());
      this.db.prepare('UPDATE market SET revision=?,record=NULL WHERE account=?').run(expectedRevision+1,account);
      return expectedRevision+1;
    });
  }
  armMarket(account, expectedRevision) {
    return this.transaction(()=>{
      const current=this.market(account);
      if (!current.record || current.record.version!==2 || current.revision!==expectedRevision)
        throw new JournalConflict('Product revision changed.');
      const deployment=read(this.db.prepare('SELECT record FROM deployment WHERE account=?').get(account)?.record ?? null);
      if (deployment && (deployment.status!=='complete' || deployment.steps.some(step=>step.status!=='confirmed')))
        throw new JournalConflict('This wallet has an unresolved deployment.');
      const record=current.record;
      const key=productKey(record);
      const prior=this.db.prepare('SELECT intent_key FROM market_signing WHERE account=?').get(account);
      if (prior?.intent_key===key) throw new JournalConflict('This product signing permission was already consumed. Recover the wallet hash; do not resend.');
      this.db.prepare(`INSERT INTO market_signing(account,intent_key,armed_at,legacy_issued_at) VALUES(?,?,?,NULL)
        ON CONFLICT(account) DO UPDATE SET intent_key=excluded.intent_key,armed_at=excluded.armed_at,legacy_issued_at=NULL`).run(account,key,Date.now());
      this.db.prepare('UPDATE market SET revision=? WHERE account=?').run(expectedRevision+1,account);
      return expectedRevision+1;
    });
  }
  deleteMarket(account, expectedRevision, result) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT revision,record FROM market WHERE account=?').get(account);
      if (!row?.record || row.revision !== expectedRevision) throw new JournalConflict('Market revision changed.');
      if (result) {
        const hash = result.transactionHash.toLowerCase();
        const existing = this.db.prepare('SELECT result FROM market_results WHERE account=? AND hash=?').get(account, hash);
        // Old browser migrations may restore an already finalized v1 intent. Reuse only the exact verified proof.
        if (existing && !same(read(existing.result), result))
          throw new JournalConflict('Finalized transaction result differs from the saved proof.');
        if (!existing) this.db.prepare('INSERT INTO market_results(account,hash,result) VALUES(?,?,?)')
          .run(account, hash, canonical(result));
      }
      this.db.prepare('UPDATE market SET revision=?,record=NULL WHERE account=?').run(row.revision + 1, account);
      return row.revision + 1;
    });
  }
  saveQuote(account, id, record) {
    const serialized = canonical(record);
    if (Buffer.byteLength(serialized) > 4096) throw new JournalConflict('Quote exceeds the saved record limit.');
    this.transaction(() => {
      this.db.prepare('INSERT INTO quotes(id,account,record,created_at) VALUES(?,?,?,?)')
        .run(id, account, serialized, Date.now());
      this.db.prepare(`DELETE FROM quotes WHERE account=? AND id NOT IN
        (SELECT id FROM quotes WHERE account=? ORDER BY created_at DESC,rowid DESC LIMIT 200)`)
        .run(account, account);
    });
  }
  quotes(account, cursor, limit) {
    const rows = this.db.prepare('SELECT id,record,created_at FROM quotes WHERE account=? ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?')
      .all(account, limit + 1, cursor);
    return { items: rows.slice(0, limit).map(row => ({ id: row.id, record: read(row.record), createdAt: row.created_at })),
      nextCursor: rows.length > limit ? cursor + limit : null };
  }
}

function validateBudgetQueueProgress(previous, next) {
  const terminal = item => ['completed','failed','skipped'].includes(item.status);
  if (previous.id !== next.id) {
    if (previous.items.some(item => !terminal(item))) throw new JournalConflict('An unresolved purchase queue cannot be replaced.');
    return;
  }
  if (next.revision !== previous.revision + 1 || previous.approvalDigest !== next.approvalDigest
    || previous.items.length !== next.items.length || previous.approved !== next.approved)
    throw new JournalConflict('Purchase queue identity or revision changed.');
  const allowed = {
    ready: ['ready','creating','skipped'], creating: ['creating','pending','created','failed','ready'],
    pending: ['pending','created','completed','failed'], created: ['created','buying','skipped'],
    buying: ['buying','pending','completed','failed','created'],
    completed: ['completed'], failed: ['failed'], skipped: ['skipped'],
  };
  for (let i = 0; i < previous.items.length; i++) {
    const old = previous.items[i], item = next.items[i];
    if (!allowed[old.status]?.includes(item.status)) throw new JournalConflict('Purchase step cannot regress.');
    if (old.child && old.child.toLowerCase() !== item.child?.toLowerCase())
      throw new JournalConflict('Confirmed child pool cannot change.');
    const startingPurchase = old.status === 'created' && item.status === 'buying'
      && old.child && old.child.toLowerCase() === item.child?.toLowerCase()
      && old.hash && old.creationHash?.toLowerCase() === old.hash.toLowerCase()
      && item.creationHash?.toLowerCase() === old.hash.toLowerCase()
      && old.lastResult?.status === 'confirmed' && old.lastResult.hash?.toLowerCase() === old.hash.toLowerCase()
      && same(old.lastResult,item.lastResult) && item.hash === undefined && item.nonce === undefined;
    if (old.creationHash && old.creationHash.toLowerCase() !== item.creationHash?.toLowerCase())
      throw new JournalConflict('Confirmed creation hash cannot change.');
    if (!startingPurchase && old.hash && old.hash.toLowerCase() !== item.hash?.toLowerCase()
      && !(item.status === 'failed' && ['replaced','cancelled'].includes(item.lastResult?.status)
        && item.previousHashes?.some(hash => hash.toLowerCase() === old.hash.toLowerCase())))
      throw new JournalConflict('Transaction hash cannot be erased.');
    if (!startingPurchase && old.nonce !== undefined && old.nonce !== item.nonce)
      throw new JournalConflict('Transaction nonce cannot change.');
    if (!startingPurchase && old.intent && !terminal(item) && item.status !== 'created' && item.status !== 'ready'
      && !same(old.intent, item.intent)) throw new JournalConflict('Purchase intent cannot change.');
    if (old.status === 'creating' && item.status === 'ready' || old.status === 'buying' && item.status === 'created') {
      if (old.hash || old.nonce !== undefined || item.hash || item.nonce !== undefined)
        throw new JournalConflict('A submitted transaction cannot be reset.');
    }
  }
}

function validateDeploymentProgress(previous, next) {
  if (previous.status === 'aborted' && next.status !== 'aborted')
    throw new JournalConflict('Aborted deployment can only be archived.');
  const { maxGasBudgetBnb: oldBudget, gasPriceCapGwei: oldGasCap, ...oldInput } = previous.input;
  const { maxGasBudgetBnb: newBudget, gasPriceCapGwei: newGasCap, ...newInput } = next.input;
  if (previous.kind !== next.kind || previous.chainId !== next.chainId || previous.account.toLowerCase() !== next.account.toLowerCase()
    || previous.artifactDigest !== next.artifactDigest || previous.sourceCommit !== next.sourceCommit
    || !same(oldInput, newInput) || !/^\d+(?:\.\d+)?$/.test(oldBudget) || !/^\d+(?:\.\d+)?$/.test(newBudget)
    || !/^\d+(?:\.\d+)?$/.test(oldGasCap) || !/^\d+(?:\.\d+)?$/.test(newGasCap)
    || parseEther(newBudget) < parseEther(oldBudget) || parseUnits(newGasCap, 'gwei') < parseUnits(oldGasCap, 'gwei')) {
    throw new JournalConflict('Deployment identity or signed input changed.');
  }
  if (previous.steps.length !== next.steps.length) throw new JournalConflict('Deployment step count changed.');
  for (let i = 0; i < previous.steps.length; i++) {
    const old = previous.steps[i], item = next.steps[i];
    if (old.id !== item.id) throw new JournalConflict('Deployment step order changed.');
    for (const field of ['nonce','dataHash','replacementHash','address','codehash']) {
      if (old[field] !== undefined && old[field] !== item[field]) throw new JournalConflict(`Deployment ${field} cannot be erased or changed.`);
    }
    if (old.status === 'confirmed' && item.status !== 'confirmed') throw new JournalConflict('Confirmed step cannot regress.');
    if (['cancelled','replaced','failed'].includes(old.status) && !['cancelled','replaced','failed'].includes(item.status))
      throw new JournalConflict('Terminal deployment step cannot become retryable.');
    const definiteNoSend = old.status === 'signing' && item.status === 'rejected'
      && ['pre-send','wallet-rejected'].includes(item.rejectionKind)
      && !old.txHash && !item.txHash && !old.receipt && !item.receipt;
    if (['signing','submitted','uncertain'].includes(old.status) && ['waiting','rejected'].includes(item.status)
      && !definiteNoSend)
      throw new JournalConflict('Unknown transaction cannot become retryable without chain proof.');
    const before = old.previousTxHashes ?? [], after = item.previousTxHashes ?? [];
    if (!Array.isArray(after) || before.some((hash, index) => after[index] !== hash))
      throw new JournalConflict('Deployment replacement hashes cannot be erased.');
    if (old.txHash && old.txHash !== item.txHash
      && (!item.txHash || !item.finalizedRecovery || !after.includes(old.txHash)))
      throw new JournalConflict('Original deployment hash must remain in replacement history.');
  }
}

function validateMarketProgress(previous, next) {
  for (const field of ['version','chainId','account','factory','market','target','targetType','nonce','data','value','gas','gasPrice','submittedAt']) {
    const a = ['account','factory','market','target'].includes(field) ? String(previous[field]).toLowerCase() : previous[field];
    const b = ['account','factory','market','target'].includes(field) ? String(next[field]).toLowerCase() : next[field];
    if (a !== b) throw new JournalConflict('Market intent identity cannot be replaced.');
  }
  if (!same(previous.action, next.action)) throw new JournalConflict('Market action cannot change.');
  if (previous.hash && previous.hash.toLowerCase() !== next.hash?.toLowerCase())
    throw new JournalConflict('Original transaction hash cannot be erased or changed.');
  const before = previous.recoveryHashes ?? [], after = next.recoveryHashes ?? [];
  if (!Array.isArray(after) || before.some((hash, index) => hash.toLowerCase() !== after[index]?.toLowerCase()))
    throw new JournalConflict('Recovery hashes cannot be erased.');
  const oldCancellations = previous.cancellationRequests ?? [], newCancellations = next.cancellationRequests ?? [];
  if (!Array.isArray(newCancellations) || oldCancellations.some((item, index) => !same(item, newCancellations[index])))
    throw new JournalConflict('Cancellation signing intents cannot be erased or changed.');
}
