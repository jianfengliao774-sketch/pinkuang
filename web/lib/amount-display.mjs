/** Display only: round half away from zero to three places using integers.
 * Never use these strings to construct calldata, quotes or transaction values. */
export function displayAmount(value, decimals = 18) {
  if (value === null || value === undefined) return '—';
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 80) throw new Error('Invalid display decimals');
  const integer = BigInt(value), negative = integer < 0n, absolute = negative ? -integer : integer;
  const milli = decimals > 3 ? (absolute + 10n ** BigInt(decimals - 3) / 2n) / 10n ** BigInt(decimals - 3)
    : absolute * 10n ** BigInt(3 - decimals);
  const whole = (milli / 1000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative && milli !== 0n ? '-' : ''}${whole}.${(milli % 1000n).toString().padStart(3, '0')}`;
}

/** Decimal input is a presentation source only; preserve its original elsewhere. */
export function displayDecimal(value) {
  if (value === null || value === undefined || value === '') return '—';
  const match = String(value).trim().match(/^(-?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!match) return '—';
  const exponent = Number(match[4] || 0), fraction = match[3] || '';
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 80 || fraction.length > 80) return '—';
  let atomic = BigInt(`${match[1]}${match[2]}${fraction}`), decimals = fraction.length - exponent;
  if (decimals < 0) { atomic *= 10n ** BigInt(-decimals); decimals = 0; }
  if (decimals > 80) return '—';
  return displayAmount(atomic, decimals);
}
