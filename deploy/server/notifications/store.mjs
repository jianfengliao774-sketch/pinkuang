import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const address = value => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value)) throw new Error('Invalid wallet address.');
  return value.toLowerCase();
};
const digest = value => createHash('sha256').update(value).digest('hex');
const parse = value => value == null ? null : JSON.parse(value);
export const languageOf = value => /^zh(?:[-_]|$)/i.test(value ?? '') ? 'zh' : 'en';
export class NotificationConflict extends Error {}

export function notificationEncryptionKey(value) {
  let key;
  if (Buffer.isBuffer(value)) key = Buffer.from(value);
  else if (typeof value === 'string' && /^[a-f\d]{64}$/i.test(value)) key = Buffer.from(value, 'hex');
  else if (typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value)) key = Buffer.from(value, 'base64');
  if (!key || key.length !== 32) throw new Error('Notifications require an explicit 32-byte encryption key.');
  return key;
}

/** Private durable contacts, binding challenges, inbox and delivery queue. Times are epoch milliseconds. */
export class NotificationStore {
  constructor(path, { encryptionKey, now = Date.now } = {}) {
    this.key = notificationEncryptionKey(encryptionKey);
    this.now = now;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (lstatSync(dirname(path)).isSymbolicLink() || (statSync(dirname(path)).mode & 0o077))
      throw new Error('Notification database directory must be private (0700) and not a symlink.');
    let existing;
    try { existing = lstatSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && (existing.isSymbolicLink() || !existing.isFile() || (existing.mode & 0o077)))
      throw new Error('Notification database must be private (0600) and not a symlink.');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS notification_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_preferences (account TEXT PRIMARY KEY, language TEXT NOT NULL DEFAULT 'en', enabled INTEGER NOT NULL DEFAULT 1, explicit_language INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS notification_bindings (account TEXT PRIMARY KEY, peer_hash TEXT NOT NULL, contact TEXT NOT NULL, blocked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS notification_peer ON notification_bindings(peer_hash);
      CREATE TABLE IF NOT EXISTS notification_peer_preferences (peer_hash TEXT PRIMARY KEY, language TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_pending (id TEXT PRIMARY KEY, account TEXT NOT NULL UNIQUE, token_hash TEXT UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, contact TEXT, peer_hash TEXT);
      CREATE TABLE IF NOT EXISTS notification_updates (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_leases (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_bot_replies (id TEXT PRIMARY KEY, contents TEXT NOT NULL, due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_inbox (id TEXT NOT NULL, account TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER, PRIMARY KEY(account,id));
      CREATE TABLE IF NOT EXISTS notification_queue (id TEXT PRIMARY KEY, account TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, due_at INTEGER NOT NULL, expires_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', error_code TEXT, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS notification_queue_due ON notification_queue(status,due_at);`);
    if (!this.db.prepare('PRAGMA table_info(notification_pending)').all().some(column => column.name === 'telegram_confirmed'))
      this.db.exec('ALTER TABLE notification_pending ADD COLUMN telegram_confirmed INTEGER NOT NULL DEFAULT 0');
    // Detect key misconfiguration before accepting new contacts, rather than silently losing old ones.
    const marker = this.getMeta('encryption-check');
    try {
      if (marker) { if (this.open(marker, 'key-check') !== 'BEMine notifications v1') throw new Error(); }
      else this.setMeta('encryption-check', this.seal('BEMine notifications v1', 'key-check'));
    } catch { this.db.close(); throw new Error('Notification encryption key does not match this database.'); }
  }
  close() { this.db.close(); this.key.fill(0); }
  transaction(fn) {
    const nested = this.transactionDepth ?? 0, savepoint = `notification_nested_${nested}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.transactionDepth = nested + 1;
    try { const result = fn(); this.db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT'); return result; }
    catch (error) { this.db.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK'); if (nested) this.db.exec(`RELEASE SAVEPOINT ${savepoint}`); throw error; }
    finally { this.transactionDepth = nested; }
  }
  seal(value, purpose) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(purpose));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext].map(item => item.toString('base64url')).join('.');
  }
  open(value, purpose) {
    const parts = value.split('.');
    if (parts.length !== 3) throw new Error('Invalid encrypted notification contact.');
    const [iv, tag, ciphertext] = parts.map(part => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(purpose)); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  }
  peerHash(userId) { return createHmac('sha256', this.key).update(`telegram:${userId}`).digest('hex'); }
  getMeta(key) { return parse(this.db.prepare('SELECT value FROM notification_meta WHERE key=?').get(key)?.value); }
  setMeta(key, value) { this.db.prepare('INSERT INTO notification_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  preferences(account) {
    const row = this.db.prepare('SELECT language,enabled,explicit_language FROM notification_preferences WHERE account=?').get(address(account));
    return { language: row?.language ?? 'en', enabled: row ? !!row.enabled : true, explicitLanguage: !!row?.explicit_language };
  }
  upsertPreferences(account, { language, enabled, explicitLanguage = true } = {}) {
    account = address(account);
    const previous = this.preferences(account);
    const next = { language: language === undefined ? previous.language : languageOf(language), enabled: enabled === undefined ? previous.enabled : !!enabled,
      explicitLanguage: language === undefined ? previous.explicitLanguage : explicitLanguage };
    this.db.prepare(`INSERT INTO notification_preferences(account,language,enabled,explicit_language) VALUES(?,?,?,?)
      ON CONFLICT(account) DO UPDATE SET language=excluded.language,enabled=excluded.enabled,explicit_language=excluded.explicit_language`)
      .run(account, next.language, Number(next.enabled), Number(next.explicitLanguage));
    return next;
  }
  getBinding(account) {
    account = address(account);
    const row = this.db.prepare('SELECT contact,blocked,created_at FROM notification_bindings WHERE account=?').get(account);
    if (!row) return null;
    return { account, ...this.preferences(account), blocked: !!row.blocked, createdAt: row.created_at, telegram: this.open(row.contact, `binding:${account}`) };
  }
  listBindings(accounts) {
    if (accounts) return [...new Set(accounts.map(address))].map(account => this.getBinding(account)).filter(Boolean);
    return this.db.prepare('SELECT account FROM notification_bindings ORDER BY account').all().map(row => this.getBinding(row.account));
  }
  bindingsForPeer(userId) {
    return this.db.prepare('SELECT account FROM notification_bindings WHERE peer_hash=?').all(this.peerHash(userId)).map(row => this.getBinding(row.account));
  }
  peerLanguage(userId) { return this.db.prepare('SELECT language FROM notification_peer_preferences WHERE peer_hash=?').get(this.peerHash(userId))?.language ?? null; }
  setPeerLanguage(userId, language) {
    this.db.prepare('INSERT INTO notification_peer_preferences(peer_hash,language) VALUES(?,?) ON CONFLICT(peer_hash) DO UPDATE SET language=excluded.language')
      .run(this.peerHash(userId), languageOf(language));
  }
  cancelPendingForPeer(userId) { this.db.prepare('DELETE FROM notification_pending WHERE peer_hash=?').run(this.peerHash(userId)); }
  issueBinding(account, { ttlMs = 10 * 60_000 } = {}) {
    account = address(account);
    return this.transaction(() => {
      const now = this.now();
      const previous = this.db.prepare('SELECT created_at FROM notification_pending WHERE account=?').get(account);
      if (previous && now - previous.created_at < 10_000) throw new NotificationConflict('Please wait before creating another binding link.');
      this.db.prepare('DELETE FROM notification_pending WHERE account=? OR expires_at<=?').run(account, now);
      const token = randomBytes(24).toString('base64url'), id = randomUUID(), expiresAt = now + ttlMs;
      this.db.prepare('INSERT INTO notification_pending(id,account,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)').run(id, account, digest(token), now, expiresAt);
      return { id, token, expiresAt };
    });
  }
  pendingBinding(account) {
    account = address(account);
    const row = this.db.prepare('SELECT id,expires_at,contact,telegram_confirmed FROM notification_pending WHERE account=? AND expires_at>?').get(account, this.now());
    return row ? { id: row.id, expiresAt: row.expires_at, status: row.telegram_confirmed ? 'paired' : 'pending',
      telegram: row.contact ? this.open(row.contact, `pending:${row.id}:${account}`) : null } : null;
  }
  stageBinding(token, telegram) {
    if (!/^[A-Za-z\d_-]{32}$/.test(token ?? '')) return false;
    return this.transaction(() => {
      const row = this.db.prepare('SELECT id,account FROM notification_pending WHERE token_hash=? AND contact IS NULL AND expires_at>?').get(digest(token), this.now());
      if (!row) return false;
      this.db.prepare('UPDATE notification_pending SET token_hash=NULL,contact=?,peer_hash=?,telegram_confirmed=0 WHERE id=?')
        .run(this.seal(telegram, `pending:${row.id}:${row.account}`), this.peerHash(telegram.userId), row.id);
      return { id: row.id, account: row.account };
    });
  }
  confirmTelegramBinding(id, userId) {
    if (typeof id !== 'string' || !/^[\da-f-]{36}$/i.test(id)) return false;
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT account FROM notification_pending
        WHERE id=? AND peer_hash=? AND contact IS NOT NULL AND expires_at>?`).get(id, this.peerHash(userId), this.now());
      if (!row) return false;
      this.db.prepare('UPDATE notification_pending SET telegram_confirmed=1 WHERE id=?').run(id);
      return { account: row.account };
    });
  }
  confirmBinding(account, id) {
    account = address(account);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT contact,peer_hash FROM notification_pending WHERE account=? AND id=? AND contact IS NOT NULL AND telegram_confirmed=1 AND expires_at>?').get(account, id, this.now());
      if (!row) throw new NotificationConflict('Binding expired or is not ready. Create a new link and verify the Telegram account.');
      const telegram = this.open(row.contact, `pending:${id}:${account}`);
      this.db.prepare(`INSERT INTO notification_bindings(account,peer_hash,contact,blocked,created_at) VALUES(?,?,?,0,?)
        ON CONFLICT(account) DO UPDATE SET peer_hash=excluded.peer_hash,contact=excluded.contact,blocked=0,created_at=excluded.created_at`)
        .run(account, row.peer_hash, this.seal(telegram, `binding:${account}`), this.now());
      this.db.prepare('DELETE FROM notification_pending WHERE account=?').run(account);
      this.upsertPreferences(account, { enabled: true });
      return this.getBinding(account);
    });
  }
  disconnect(account) {
    account = address(account);
    this.transaction(() => {
      this.db.prepare('DELETE FROM notification_bindings WHERE account=?').run(account);
      this.db.prepare('DELETE FROM notification_pending WHERE account=?').run(account);
      this.db.prepare("UPDATE notification_queue SET status='cancelled',updated_at=? WHERE account=? AND status='pending'").run(this.now(), account);
    });
  }
  markBlocked(account) { this.db.prepare('UPDATE notification_bindings SET blocked=1 WHERE account=?').run(address(account)); }
  claimTelegramUpdate(id) {
    if (!Number.isSafeInteger(id) || id < 0) return false;
    return this.transaction(() => {
      // Retain one week of receipts; consumed binding tokens remain unreplayable independently.
      this.db.prepare('DELETE FROM notification_updates WHERE created_at<?').run(this.now() - 7 * 86400_000);
      return !!this.db.prepare('INSERT OR IGNORE INTO notification_updates(id,created_at) VALUES(?,?)').run(id, this.now()).changes;
    });
  }
  acquireLease(name, owner, ttlMs, now = this.now()) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000) throw new Error('Invalid notification lease duration.');
    return !!this.db.prepare(`INSERT INTO notification_leases(name,owner,expires_at) VALUES(?,?,?)
      ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE notification_leases.owner=excluded.owner OR notification_leases.expires_at<=?`)
      .run(name, owner, now + ttlMs, now).changes;
  }
  releaseLease(name, owner) { return !!this.db.prepare('DELETE FROM notification_leases WHERE name=? AND owner=?').run(name, owner).changes; }
  enqueueBotReply(id, contents) {
    return !!this.db.prepare('INSERT OR IGNORE INTO notification_bot_replies(id,contents,due_at,created_at) VALUES(?,?,?,?)')
      .run(String(id), this.seal(contents, `bot-reply:${id}`), this.now(), this.now()).changes;
  }
  dueBotReplies(limit = 20) {
    this.db.prepare("DELETE FROM notification_bot_replies WHERE created_at<? AND status<>'pending'").run(this.now() - 7 * 86400_000);
    return this.db.prepare("SELECT id,contents,attempts FROM notification_bot_replies WHERE status='pending' AND due_at<=? ORDER BY due_at LIMIT ?")
      .all(this.now(), Math.min(50, Math.max(1, limit))).map(row => ({ id: row.id, attempts: row.attempts, ...this.open(row.contents, `bot-reply:${row.id}`) }));
  }
  finishBotReply(id, { retryAt, failed = false } = {}) {
    if (retryAt !== undefined) this.db.prepare("UPDATE notification_bot_replies SET attempts=attempts+1,due_at=? WHERE id=? AND status='pending'").run(retryAt, id);
    else this.db.prepare("UPDATE notification_bot_replies SET status=? WHERE id=? AND status='pending'").run(failed ? 'failed' : 'sent', id);
  }
  enqueue({ id, account, kind, payload, dueAt, expiresAt = null }) {
    return !!this.db.prepare('INSERT OR IGNORE INTO notification_queue(id,account,kind,payload,due_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, address(account), kind, JSON.stringify(payload), dueAt, expiresAt, this.now()).changes;
  }
  due(now = this.now(), limit = 50) {
    this.db.prepare("UPDATE notification_queue SET status='expired',updated_at=? WHERE status='pending' AND expires_at IS NOT NULL AND expires_at<=?").run(now, now);
    return this.db.prepare("SELECT id,account,kind,payload,due_at,expires_at,attempts FROM notification_queue WHERE status='pending' AND due_at<=? ORDER BY due_at,id LIMIT ?")
      .all(now, Math.min(500, Math.max(1, limit))).map(row => ({ id: row.id, account: row.account, kind: row.kind, payload: parse(row.payload), dueAt: row.due_at, expiresAt: row.expires_at, attempts: row.attempts }));
  }
  ack(id, now = this.now(), status = 'sent') {
    if (!['sent', 'cancelled'].includes(status)) throw new Error('Invalid acknowledgement state.');
    this.db.prepare("UPDATE notification_queue SET status=?,updated_at=? WHERE id=? AND status='pending'").run(status, now, id);
  }
  retry(id, { dueAt, errorCode, countAttempt = true }) {
    this.db.prepare("UPDATE notification_queue SET due_at=?,attempts=attempts+?,error_code=?,updated_at=? WHERE id=? AND status='pending'")
      .run(dueAt, countAttempt ? 1 : 0, String(errorCode).slice(0, 80), this.now(), id);
  }
  block(id, errorCode = 'blocked') {
    this.db.prepare("UPDATE notification_queue SET status='blocked',error_code=?,updated_at=? WHERE id=? AND status='pending'").run(String(errorCode).slice(0, 80), this.now(), id);
  }
  addInbox({ id, account, kind, payload, createdAt = this.now() }) {
    return !!this.db.prepare('INSERT OR IGNORE INTO notification_inbox(id,account,kind,payload,created_at) VALUES(?,?,?,?,?)').run(id, address(account), kind, JSON.stringify(payload), createdAt).changes;
  }
  inbox(account, limit = 100) {
    return this.db.prepare('SELECT id,kind,payload,created_at,read_at FROM notification_inbox WHERE account=? ORDER BY created_at DESC,id DESC LIMIT ?')
      .all(address(account), Math.min(100, Math.max(1, limit))).map(row => ({ id: row.id, kind: row.kind, payload: parse(row.payload), createdAt: row.created_at, readAt: row.read_at }));
  }
  readInbox(account, id) { this.db.prepare('UPDATE notification_inbox SET read_at=COALESCE(read_at,?) WHERE account=? AND id=?').run(this.now(), address(account), id); }
}
