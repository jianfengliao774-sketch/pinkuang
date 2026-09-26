import type { DeploymentSnapshot } from './deployment';
import type { ServerJournal } from './server-journal';

export const LEGACY_DEPLOYMENT_KEY = 'pinkuang.deployment.v1';
export const LEGACY_ARCHIVE_PREFIX = 'pinkuang.deployment.archive.v1.';
export const LEGACY_QUOTE_KEY = 'pinkuang.quote-plan.v1';

type LegacyStorage = Pick<Storage, 'getItem' | 'removeItem' | 'length' | 'key'>;
type ImportJournal = Pick<ServerJournal, 'account' | 'readLatestDeployment' | 'saveDeployment' | 'importAbortedArchive' | 'saveQuote'>;
const stableJson = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

/** One-time migration. Never remove a legacy transaction before a server ACK and readback. */
export async function migrateLegacyDeployment(journal: ImportJournal, storage: LegacyStorage): Promise<void> {
  let raw: string | null;
  try { raw = storage.getItem(LEGACY_DEPLOYMENT_KEY); } catch { return; }
  if (raw) {
    let legacy: DeploymentSnapshot;
    try { legacy = JSON.parse(raw) as DeploymentSnapshot; }
    catch { throw new Error('旧浏览器部署记录损坏。请先导出浏览器数据并人工核对，不能开始新部署。'); }
    if (legacy.chainId !== 56 || !Array.isArray(legacy.steps) || !legacy.id || !legacy.account) throw new Error('旧浏览器部署记录格式异常，不能开始新部署。');
    if (legacy.account.toLowerCase() === journal.account.toLowerCase()) {
      const current = await journal.readLatestDeployment();
      if (!current) await journal.saveDeployment(legacy);
      else if (stableJson(current) !== stableJson(legacy)) throw new Error('服务器与旧浏览器有不同部署进度。请保留浏览器数据并核对交易，不能自动覆盖。');
      const verified = await journal.readLatestDeployment();
      if (stableJson(verified) !== stableJson(legacy)) throw new Error('旧部署上传后服务器读回不一致，浏览器记录已保留。');
      try { storage.removeItem(LEGACY_DEPLOYMENT_KEY); } catch { /* Server remains authoritative. */ }
    }
  }
  for (let index = storage.length - 1; index >= 0; index--) {
    const key = storage.key(index);
    if (!key?.startsWith(LEGACY_ARCHIVE_PREFIX)) continue;
    const rawArchive = storage.getItem(key);
    if (!rawArchive) continue;
    let record: DeploymentSnapshot;
    try { record = JSON.parse(rawArchive) as DeploymentSnapshot; }
    catch { throw new Error('旧浏览器归档记录损坏，已保留原始数据。'); }
    if (!record.account || record.chainId !== 56 || record.status !== 'aborted') throw new Error('旧浏览器归档格式异常，已保留原始数据。');
    if (record.account.toLowerCase() !== journal.account.toLowerCase()) continue;
    await journal.importAbortedArchive(record);
    try { storage.removeItem(key); } catch { /* Import is idempotent on reconnect. */ }
  }
  let oldQuote: string | null;
  try { oldQuote = storage.getItem(LEGACY_QUOTE_KEY); } catch { return; }
  if (oldQuote) {
    let record: unknown;
    try { record = JSON.parse(oldQuote); }
    catch { return; } // An old optional quote cannot block transaction recovery.
    if (!record || typeof record !== 'object' || Array.isArray(record)) return;
    await journal.saveQuote(record);
    try { storage.removeItem(LEGACY_QUOTE_KEY); } catch { /* Server copy is durable. */ }
  }
}
