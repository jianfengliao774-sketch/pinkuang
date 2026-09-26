import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DeploymentSnapshot } from './deployment';
import { LEGACY_ARCHIVE_PREFIX, LEGACY_DEPLOYMENT_KEY, LEGACY_QUOTE_KEY, migrateLegacyDeployment } from './legacy-deployment';
import type { ServerJournal } from './server-journal';

const account = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const record = (owner = account, id = 'old'): DeploymentSnapshot => ({
  schemaVersion: 1, chainId: 56, account: owner, id, status: 'paused',
  steps: [{ id: 'PoolVault', label: 'PoolVault', status: 'submitted', nonce: 7, txHash: `0x${'aa'.repeat(32)}` }],
  input: { governanceMode: 'single', ownerMultisig: owner, operator: owner, treasury: owner,
    maxGasBudgetBnb: '0.05', gasPriceCapGwei: '1', governanceReviewed: true, protocolReviewed: true },
  addresses: {}, spentWei: '0', artifactDigest: `0x${'bb'.repeat(32)}`, sourceCommit: 'a'.repeat(40),
  createdAt: '2026-09-26T00:00:00Z', updatedAt: '2026-09-26T00:00:00Z', preflight: {} as DeploymentSnapshot['preflight'],
});
const canonical = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)) as T;

function fixture(entries: Record<string, string>, options: { failSave?: boolean; initial?: DeploymentSnapshot | null } = {}) {
  const values = new Map(Object.entries(entries));
  const removed: string[] = [];
  const storage = {
    get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => { removed.push(key); values.delete(key); },
  } as Pick<Storage, 'getItem' | 'removeItem' | 'length' | 'key'>;
  let saved = options.initial ?? null;
  const archives: DeploymentSnapshot[] = [], quotes: unknown[] = [];
  const journal = {
    account, readLatestDeployment: async () => saved,
    saveDeployment: async (next: DeploymentSnapshot) => {
      if (options.failSave) throw new Error('server unavailable');
      saved = canonical(next);
    },
    importAbortedArchive: async (next: DeploymentSnapshot) => { archives.push(next); },
    saveQuote: async (next: unknown) => { quotes.push(next); },
  } as unknown as ServerJournal;
  return { storage, journal, removed, values, archives, quotes, current: () => saved };
}

test('old active deployment is removed only after durable server ACK and canonical readback', async () => {
  const old = record();
  const f = fixture({ [LEGACY_DEPLOYMENT_KEY]: JSON.stringify(old) });
  await migrateLegacyDeployment(f.journal, f.storage);
  assert.deepEqual(f.current(), canonical(old));
  assert.equal(f.values.has(LEGACY_DEPLOYMENT_KEY), false);
  assert.deepEqual(f.removed, [LEGACY_DEPLOYMENT_KEY]);
});

test('failed upload, different wallet and conflicting server history preserve the old intent', async () => {
  const old = record();
  const failed = fixture({ [LEGACY_DEPLOYMENT_KEY]: JSON.stringify(old) }, { failSave: true });
  await assert.rejects(migrateLegacyDeployment(failed.journal, failed.storage), /server unavailable/);
  assert.equal(failed.values.get(LEGACY_DEPLOYMENT_KEY), JSON.stringify(old));
  const otherWallet = fixture({ [LEGACY_DEPLOYMENT_KEY]: JSON.stringify(record(other)) });
  await migrateLegacyDeployment(otherWallet.journal, otherWallet.storage);
  assert.equal(otherWallet.values.has(LEGACY_DEPLOYMENT_KEY), true);
  const conflict = fixture({ [LEGACY_DEPLOYMENT_KEY]: JSON.stringify(old) }, { initial: record(account, 'newer') });
  await assert.rejects(migrateLegacyDeployment(conflict.journal, conflict.storage), /不同部署进度/);
  assert.equal(conflict.values.has(LEGACY_DEPLOYMENT_KEY), true);
});

test('old aborted archives and quote plan transfer without erasing another wallet archive', async () => {
  const oldArchive = { ...record(), status: 'aborted' as const };
  const foreignArchive = { ...record(other, 'foreign'), status: 'aborted' as const };
  const f = fixture({
    [`${LEGACY_ARCHIVE_PREFIX}old`]: JSON.stringify(oldArchive),
    [`${LEGACY_ARCHIVE_PREFIX}foreign`]: JSON.stringify(foreignArchive),
    [LEGACY_QUOTE_KEY]: JSON.stringify({ plan: { targetRaiseWei: '100' } }),
  });
  await migrateLegacyDeployment(f.journal, f.storage);
  assert.deepEqual(f.archives, [oldArchive]);
  assert.equal(f.values.has(`${LEGACY_ARCHIVE_PREFIX}old`), false);
  assert.equal(f.values.has(`${LEGACY_ARCHIVE_PREFIX}foreign`), true);
  assert.deepEqual(f.quotes, [{ plan: { targetRaiseWei: '100' } }]);
  assert.equal(f.values.has(LEGACY_QUOTE_KEY), false);
});
