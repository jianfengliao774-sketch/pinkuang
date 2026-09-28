/** Display only. Keep atomic integers for calculation, sorting and transactions. */
export function displayUnits(value: bigint | string | null | undefined, decimals = 18): string {
  if (value == null) return '—';
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('Invalid unit decimals');
  const amount = BigInt(value), absolute = amount < 0n ? -amount : amount;
  const rounded = decimals > 3
    ? (absolute + 10n ** BigInt(decimals - 3) / 2n) / 10n ** BigInt(decimals - 3)
    : absolute * 10n ** BigInt(3 - decimals);
  return `${amount < 0n && rounded !== 0n ? '-' : ''}${rounded / 1000n}.${(rounded % 1000n).toString().padStart(3, '0')}`;
}

export function displayDecimal(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return '—';
  return displayUnits(`${match[1]}${match[2]}${match[3] ?? ''}`, (match[3] ?? '').length);
}
