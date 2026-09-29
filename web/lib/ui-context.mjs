/** A ticket is usable only while its pool, wallet and request generation remain current. */
export function createUiContext() {
  let generation = 0;
  return Object.freeze({
    invalidate() { generation += 1; },
    begin() { generation += 1; return generation; },
    current(ticket) { return ticket === generation; },
  });
}

export function sameUnsignedIntent(left, right) {
  if (!left || !right) return false;
  return ['from', 'to', 'data', 'chainId'].every(key => String(left[key]).toLowerCase() === String(right[key]).toLowerCase())
    && BigInt(left.value ?? 0) === BigInt(right.value ?? 0);
}
