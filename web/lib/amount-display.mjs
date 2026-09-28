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

/** Keep small, positive subscription prices visible without changing their wei value. */
export function displayPreciseAmount(value, decimals = 18, places = 5) {
  if (value === null || value === undefined) return '—';
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 80 ||
      !Number.isInteger(places) || places < 1 || places > 18) throw new Error('Invalid display precision');
  const atomic = BigInt(value);
  if (atomic < 0n) throw new Error('Invalid positive amount');
  const scale = 10n ** BigInt(decimals);
  const whole = atomic / scale;
  const fraction = atomic % scale;
  if (fraction === 0n) return `${whole}.${'0'.repeat(places)}`;
  if (decimals <= places) return `${whole}.${fraction.toString().padStart(decimals, '0').padEnd(places, '0')}`;
  const unit = 10n ** BigInt(decimals - places);
  const rounded = (atomic + unit / 2n) / unit;
  if (rounded === 0n) return `<0.${'0'.repeat(places - 1)}1`;
  const displayScale = 10n ** BigInt(places);
  const roundedFraction = rounded % displayScale;
  return `${rounded / displayScale}.${roundedFraction.toString().padStart(places, '0')}`;
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
function decimalSource(value) {
  if (value === null || value === undefined || value === '') return '—';
  const match = String(value).trim().match(/^(-?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!match) return '—';
  const exponent = Number(match[4] || 0), fraction = match[3] || '';
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 80 || fraction.length > 80) return '—';
  let atomic = BigInt(`${match[1]}${match[2]}${fraction}`), decimals = fraction.length - exponent;
  if (decimals < 0) { atomic *= 10n ** BigInt(-decimals); decimals = 0; }
  if (decimals > 80) return '—';
  return { atomic, decimals };
}

export function displayDecimal(value) {
  const source = decimalSource(value);
  return typeof source === 'object' ? displayAmount(source.atomic, source.decimals) : source;
}

/** BNB display only. Preserve exact wei separately for every transaction. */
export function displayBnb(wei) {
  return displayPreciseAmount(wei, 18, 5);
}

/** Format a decimal BNB quote without a floating-point round trip. */
export function displayBnbDecimal(value) {
  const source = decimalSource(value);
  return typeof source === 'object' && source.atomic >= 0n
    ? displayPreciseAmount(source.atomic, source.decimals, 5) : '—';
}


/** USDT price has its own fixed three-place display, independent of BNB formatting. */
export function displayUsdt(value) {
  const source = decimalSource(value);
  return typeof source === 'object' && source.atomic >= 0n
    ? displayAmount(source.atomic, source.decimals) : '—';
}
