import { formatEther, parseEther } from 'ethers';

const BEM_ATOMIC = 100_000_000n;
const integer = value => typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? BigInt(value) : 0n;

/** A conservative BNB/H conversion from a current, verified Firsto sample. */
export function portfolioDailyCapSample(rows, now = Date.now(), quoteIssue = () => null) {
  let lowest = null;
  for (const row of rows ?? []) {
    if (row.status !== 'verified' || row.unverifiedWeight !== '0' || quoteIssue(row, now)) continue;
    const weight = integer(row.verifiedWeight), output = integer(row.estimated24hAtomic);
    if (weight === 0n || output === 0n) continue;
    if (!lowest || output * lowest.weight < lowest.output * weight)
      lowest = { output, weight, observedAt: row.source?.observedAt };
  }
  return lowest;
}

export function dailyCapToWeightCap(dailyCap, sample) {
  if (typeof dailyCap !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(dailyCap.trim()))
    throw new Error('日产能价上限请输入精确 BNB / (BEM / 天)，最多 18 位小数。');
  const dailyWei = parseEther(dailyCap.trim());
  if (dailyWei <= 0n) throw new Error('日产能价上限必须大于 0。');
  if (!sample || sample.output <= 0n || sample.weight <= 0n || !Number.isFinite(sample.observedAt)
    || sample.observedAt > Date.now() + 30_000 || Date.now() - sample.observedAt > 120_000)
    throw new Error('Firsto 产能样本缺失或已过期，请刷新后再建池。');
  const perWeightWei = dailyWei * sample.output / (sample.weight * BEM_ATOMIC);
  if (perWeightWei === 0n) throw new Error('日产能价折算后的链上每 H 限价为 0，请提高上限。');
  return formatEther(perWeightWei);
}
