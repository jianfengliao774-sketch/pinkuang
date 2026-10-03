/** Display only. Keep atomic integers for calculation, sorting and transactions. */
const DISPLAY_PLACES = 5;
const DISPLAY_SCALE = 10n ** BigInt(DISPLAY_PLACES);
export function displayUnits(value: bigint | string | null | undefined, decimals = 18): string {
  if (value == null) return '—';
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('Invalid unit decimals');
  const amount = BigInt(value), absolute = amount < 0n ? -amount : amount;
  const rounded = decimals > DISPLAY_PLACES
    ? (absolute + 10n ** BigInt(decimals - DISPLAY_PLACES) / 2n) / 10n ** BigInt(decimals - DISPLAY_PLACES)
    : absolute * 10n ** BigInt(DISPLAY_PLACES - decimals);
  return `${amount < 0n && rounded !== 0n ? '-' : ''}${rounded / DISPLAY_SCALE}.${(rounded % DISPLAY_SCALE).toString().padStart(DISPLAY_PLACES, '0')}`;
}

export function displayDecimal(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return '—';
  return displayUnits(`${match[1]}${match[2]}${match[3] ?? ''}`, (match[3] ?? '').length);
}
