/** Isolated native-ask state. It contains no key and never clears a buyer's journal. */
import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getAddress } from 'ethers';

const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const same = (a, b) => getAddress(a) === getAddress(b);
const privateFile = (path, { mustExist = false } = {}) => {
  if (!isAbsolute(path ?? '')) throw new Error('Native ask state requires an absolute private path.');
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()
    || process.platform !== 'win32' && (parent.mode & 0o077)) throw new Error('Native ask state requires a real private directory.');
  if (mustExist || existsSync(path)) {
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink() || process.platform !== 'win32' && (file.mode & 0o077))
      throw new Error('Native ask state must be a private regular file.');
  }
};

/** API-owned stable-inode lock, independent from the inaccessible signer lane. */
export function acquireFirstoAskJournalLock(path) {
  privateFile(path);
  const fd = openSync(`${path}.lock`, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || typeof process.getuid === 'function' && info.uid !== process.getuid())
      throw new Error('Native ask lock must be a private regular file owned by the API.');
    const result = spawnSync('/usr/bin/flock', ['-n', '-E', '75', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
    if (result.status === 75) throw new Error('Native ask lock already exists: another API worker holds it.');
    if (result.error || result.status !== 0) throw new Error('Native ask OS lock is unavailable.');
    return () => closeSync(fd);
  } catch (error) { closeSync(fd); throw error; }
}

export function readFirstoAskJournal(path, { factory, exchange }) {
  privateFile(path);
  const blank = { schemaVersion: 1, kind: 'firsto-native-ask-publisher-v1', chainId: 56,
    factory: getAddress(factory), exchange: getAddress(exchange), pools: {} };
  if (!existsSync(path)) return blank;
  if (lstatSync(path).size > MAX_JOURNAL_BYTES) throw new Error('Native ask journal exceeds its limit.');
  const bytes = readFileSync(path);
  if (bytes.length > MAX_JOURNAL_BYTES) throw new Error('Native ask journal exceeds its limit.');
  const value = JSON.parse(bytes.toString('utf8'));
  if (value.schemaVersion !== 1 || value.kind !== blank.kind || value.chainId !== 56
    || !same(value.factory, factory) || !same(value.exchange, exchange) || !value.pools
    || typeof value.pools !== 'object' || Array.isArray(value.pools) || Object.keys(value.pools).length > 1000)
    throw new Error('Native ask journal belongs to another deployment or is malformed.');
  for (const [pool, row] of Object.entries(value.pools)) {
    if (!same(pool, row?.pool) || !/^0x[\da-f]{64}$/i.test(row.askHash ?? '')
      || !/^(?:0|[1-9]\d*)$/.test(row.nonce ?? '') || !row.envelope
      || !['prepared', 'submitting', 'published', 'pending-approval', 'ambiguous', 'rejected'].includes(row.phase))
      throw new Error('Native ask journal row is malformed.');
  }
  return value;
}

export function writeFirstoAskJournal(path, value) {
  privateFile(path);
  const text = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(text) > MAX_JOURNAL_BYTES) throw new Error('Native ask journal exceeds its limit.');
  const temporary = `${path}.${process.pid}.tmp`;
  // Exclusive creation prevents replacing a symlink left at the temporary path.
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  if (process.platform !== 'win32') {
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}

/** Active authenticated intents are conservative reservations, including unknown wallet hashes. */
export function createPendingFirstoSaleIntentReader(path, { factory }) {
  privateFile(path, { mustExist: true });
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA busy_timeout=1000');
  let hasPendingSaleIntent;
  try { hasPendingSaleIntent = pendingFirstoSaleIntentFromDatabase(db, { factory }); }
  catch (error) { db.close(); throw error; }
  let closed = false;
  return {
    hasPendingSaleIntent(pool) {
      if (closed) throw new Error('Native ask buyer-intent reader is closed.');
      return hasPendingSaleIntent(pool);
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}

/** Reuse the API-owned open database; the signer never opens or receives it. */
export function pendingFirstoSaleIntentFromDatabase(db, { factory }) {
  const query = db.prepare(`SELECT 1 FROM market WHERE record IS NOT NULL
      AND lower(json_extract(record,'$.factory'))=? AND lower(json_extract(record,'$.target'))=?
      AND json_extract(record,'$.chainId')=56 AND json_extract(record,'$.targetType')='pool'
      AND json_extract(record,'$.action.kind')='completeFirstoSale' LIMIT 1`);
  const bound = getAddress(factory).toLowerCase();
  return pool => Boolean(query.get(bound, getAddress(pool).toLowerCase()));
}

export const firstoAskMessages = {
  'upgrade-required': '完成原生 Firsto 出售合约升级后，后台自动发布卖单。',
  inactive: '当前没有可发布的原生卖单。', expired: '挂牌已到期，不再发布或购买。',
  'buyer-pending': '本站购买正在等待确认，暂不发布或更新外部卖单。',
  publishing: '正在向 Firsto 发布已批准的卖单。', published: 'Firsto 已确认卖单上架。',
  'publication-accepted': 'Firsto 已接收卖单，正在等待官方订单列表更新。',
  'pending-approval': 'Firsto 已接收卖单，正在等待批准。',
  'publication-unknown': '发布结果尚未确认，后台只查询原卖单。',
  'publication-rejected': 'Firsto 未接受卖单，需处理拒绝原因后再发布。',
  'order-conflict': '同一订单编号出现不同条款，已暂停发布。',
  'authorization-changed': '挂牌授权已变化，后台稍后读取新状态。',
  'external-awaiting-chain': 'Firsto 卖单状态已变化，等待矿池链上状态更新。',
  'read-unavailable': '矿池读取暂不可用，保留最近发布结果。',
  'source-unavailable': 'Firsto 来源暂不可用，保留最近发布结果。',
};

export function writeFirstoAskStatus(path, value) {
  const parent = lstatSync(dirname(path));
  if (!isAbsolute(path) || !parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Native ask status requires a fixed real directory.');
  const text = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(text) > MAX_JOURNAL_BYTES) throw new Error('Native ask status exceeds its limit.');
  const temporary = `${path}.${process.pid}.tmp`, fd = openSync(temporary, 'wx', 0o644);
  try { fchmodSync(fd, 0o644); writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}

export function readFirstoAskPublisherStatus(path, { factory, exchange, pool, now = Date.now }) {
  const blank = { schemaVersion: 1, chainId: 56, factory, exchange, enabled: false, updatedAt: null, stale: false,
    item: { pool: getAddress(pool), status: 'upgrade-required', verifiedInOfficialBook: false,
      message: firstoAskMessages['upgrade-required'] } };
  if (!path || !existsSync(path)) return blank;
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_JOURNAL_BYTES) throw new Error('Native ask public status is not a bounded regular file.');
  const bytes = readFileSync(path);
  if (bytes.length > MAX_JOURNAL_BYTES) throw new Error('Native ask public status exceeds its limit.');
  const value = JSON.parse(bytes.toString('utf8')), stamp = Date.parse(value.updatedAt);
  if (value.schemaVersion !== 1 || value.chainId !== 56 || !same(value.factory, factory) || !same(value.exchange, exchange)
    || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(stamp) || stamp > now() + 30_000)
    throw new Error('Native ask public status identity changed.');
  const item = value.pools?.[getAddress(pool).toLowerCase()] ?? blank.item;
  if (!same(item.pool, pool) || !Object.hasOwn(firstoAskMessages, item.status)) throw new Error('Native ask public status row changed.');
  return { ...blank, enabled: value.enabled, updatedAt: value.updatedAt, stale: now() - stamp > 90_000,
    item: { ...item, message: firstoAskMessages[item.status] } };
}
