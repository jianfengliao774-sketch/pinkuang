import { insist } from './live-config.mjs';

const atomic = (value, field) => {
  insist(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value),
    'invalid_data', `${field} 不是精确非负整数字符串。`);
  return BigInt(value);
};

/** Public mining totals are materialized by the server; no wallet or RPC reads. */
export function readMiningOverviewStats(data) {
  const coverage = data?.miningOverview;
  const values = Object.fromEntries(['currentlyActivePoolCount', 'estimatedDailyBemAtomic']
    .map(field => [field, data?.[field] == null ? null : atomic(data[field], field)]));
  if (coverage == null) return values;
  insist(coverage.basis === 'gross_estimated_output'
    && typeof coverage.minerCountComplete === 'boolean'
    && typeof coverage.dailyOutputComplete === 'boolean',
  'invalid_data', '管理矿机与日产统计口径无效。');
  const parsed = { ...coverage };
  for (const field of ['quotedMinerCount', 'missingMinerCount', 'staleQuoteMinerCount'])
    parsed[field] = atomic(coverage[field], field);
  insist(coverage.observedAt === null || typeof coverage.observedAt === 'string'
    && Number.isFinite(Date.parse(coverage.observedAt)), 'invalid_data', '日产更新时间无效。');
  insist(parsed.staleQuoteMinerCount <= parsed.quotedMinerCount,
    'invalid_data', '日产缓存报价统计不一致。');
  if (coverage.minerCountComplete) {
    insist(values.currentlyActivePoolCount !== null
      && parsed.quotedMinerCount + parsed.missingMinerCount === values.currentlyActivePoolCount,
    'invalid_data', '管理矿机统计覆盖不完整。');
  } else values.currentlyActivePoolCount = null;
  if (coverage.dailyOutputComplete) {
    insist(coverage.minerCountComplete && parsed.missingMinerCount === 0n
      && values.estimatedDailyBemAtomic !== null, 'invalid_data', '日产统计覆盖不完整。');
  } else values.estimatedDailyBemAtomic = null;
  return { ...values, miningOverview: Object.freeze(parsed) };
}
