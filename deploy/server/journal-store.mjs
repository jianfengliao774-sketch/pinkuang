import { mkdirSync, chmodSync, existsSync, lstatSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseEther, parseUnits } from 'ethers';

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
      CREATE TABLE IF NOT EXISTS deployment_archives (account TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL,
        PRIMARY KEY(account,id));
      CREATE TABLE IF NOT EXISTS market (account TEXT PRIMARY KEY, revision INTEGER NOT NULL, record TEXT);
      CREATE TABLE IF NOT EXISTS market_abandoned (account TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL, abandoned_at INTEGER NOT NULL, PRIMARY KEY(account,revision));
      CREATE TABLE IF NOT EXISTS market_signing (account TEXT PRIMARY KEY, intent_key TEXT NOT NULL, armed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS market_results (account TEXT NOT NULL, hash TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(account,hash));
      CREATE TABLE IF NOT EXISTS quotes (id TEXT PRIMARY KEY, account TEXT NOT NULL, record TEXT NOT NULL, created_at INTEGER NOT NULL);`);
  }

  close() { this.db.close(); }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  issueChallenge(account, nonce, message, expires) {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM challenges WHERE expires < ?').run(Date.now());
      this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
      const active = this.db.prepare('SELECT nonce,message,expires FROM challenges WHERE account=? AND expires>=? ORDER BY expires DESC LIMIT 1')
        .get(account, Date.now());
      if (active) return active;
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
  archiveDeployment(account, id, expectedRevision) {
    return this.transaction(() => {
      const current = this.db.prepare('SELECT revision,record FROM deployment WHERE account=?').get(account);
      if (!current || current.revision !== expectedRevision) throw new JournalConflict('Deployment revision changed.');
      const record = read(current.record);
      if (!record || record.id !== id || !['aborted','complete'].includes(record.status))
        throw new JournalConflict('Only the matching completed or aborted deployment can be archived.');
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
      this.db.prepare(`INSERT INTO market_signing(account,intent_key,armed_at) VALUES(?,?,?)
        ON CONFLICT(account) DO UPDATE SET intent_key=excluded.intent_key,armed_at=excluded.armed_at`).run(account,key,Date.now());
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
    this.db.prepare('INSERT INTO quotes(id,account,record,created_at) VALUES(?,?,?,?)')
      .run(id, account, canonical(record), Date.now());
  }
  quotes(account, cursor, limit) {
    const rows = this.db.prepare('SELECT id,record,created_at FROM quotes WHERE account=? ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?')
      .all(account, limit + 1, cursor);
    return { items: rows.slice(0, limit).map(row => ({ id: row.id, record: read(row.record), createdAt: row.created_at })),
      nextCursor: rows.length > limit ? cursor + limit : null };
  }
}

function validateDeploymentProgress(previous, next) {
  if (previous.status === 'aborted' && next.status !== 'aborted')
    throw new JournalConflict('Aborted deployment can only be archived.');
  const { maxGasBudgetBnb: oldBudget, gasPriceCapGwei: oldGasCap, ...oldInput } = previous.input;
  const { maxGasBudgetBnb: newBudget, gasPriceCapGwei: newGasCap, ...newInput } = next.input;
  if (previous.chainId !== next.chainId || previous.account.toLowerCase() !== next.account.toLowerCase()
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
    if (['signing','submitted','uncertain'].includes(old.status) && ['waiting','rejected'].includes(item.status))
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
