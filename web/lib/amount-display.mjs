/** Display only: round half away from zero to five places using integers.
 * Never use these strings to construct calldata, quotes or transaction values. */
export function displayAmount(value, decimals = 18, places = 5) {
  if (value === null || value === undefined) return '—';
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 80) throw new Error('Invalid display decimals');
  if (!Number.isInteger(places) || places < 1 || places > 18) throw new Error('Invalid display precision');
  const integer = BigInt(value), negative = integer < 0n, absolute = negative ? -integer : integer;
  const unit = decimals > places ? 10n ** BigInt(decimals - places) : 1n;
  const rounded = decimals > places ? (absolute + unit / 2n) / unit
    : absolute * 10n ** BigInt(places - decimals);
  if (absolute > 0n && rounded === 0n) return `${negative ? '>' : '<'}${negative ? '-' : ''}0.${'0'.repeat(places - 1)}1`;
  const scale = 10n ** BigInt(places);
  const whole = (rounded / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${whole}.${(rounded % scale).toString().padStart(places, '0')}`;
}

/** Keep small, positive subscription prices visible without changing their wei value. */
export function displayPreciseAmount(value, decimals = 18, places = 5) {
  if (value === null || value === undefined) return '—';
  const atomic = BigInt(value);
  if (atomic < 0n) throw new Error('Invalid positive amount');
  return displayAmount(atomic, decimals, places);
}

/** Round the maximum payable Gas upward, so a positive cost never displays as zero. */
export function displayGasFee(wei) {
  const value = BigInt(wei);
  if (value < 0n) throw new Error('Invalid Gas fee');
  const unit = 10n ** 13n;
  const rounded = (value + unit - 1n) / unit;
  return `${rounded / 100000n}.${(rounded % 100000n).toString().padStart(5, '0')}`;
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
