import { SHARE_ARTWORKS } from './share-artwork.mjs';
import { SHARE_MOTTO_COUNT } from './share-copy.mjs';

export const SHARE_VARIATION_STORAGE_KEY = 'bemine.share.variation.v11';
export const SHARE_VARIATION_COUNT = SHARE_ARTWORKS.length * SHARE_MOTTO_COUNT;

function validVariation(value) {
  if (!value || !SHARE_ARTWORKS.some(artwork => artwork.id === value.posterId)
    || !Number.isInteger(value.mottoIndex) || value.mottoIndex < 0 || value.mottoIndex >= SHARE_MOTTO_COUNT) return null;
  return { posterId: value.posterId, mottoIndex: value.mottoIndex };
}

/** Cosmetic randomness only; no wallet or transaction identifiers enter this module. */
export function shareRandom(cryptoSource = globalThis.crypto, fallback = Math.random) {
  try {
    if (typeof cryptoSource?.getRandomValues === 'function') {
      const value = new Uint32Array(1);
      cryptoSource.getRandomValues(value);
      return value[0] / 0x100000000;
    }
  } catch { /* Sandboxed browsers can expose an unusable crypto object. */ }
  try { return fallback(); } catch { return 0; }
}

/** Select uniformly from all combinations except the previous one. RNG is injectable for tests. */
export function selectShareVariation(previous, random = shareRandom) {
  const safePrevious = validVariation(previous);
  const previousIndex = safePrevious ? SHARE_ARTWORKS.findIndex(artwork => artwork.id === safePrevious.posterId)
    * SHARE_MOTTO_COUNT + safePrevious.mottoIndex : -1;
  let unit;
  try { unit = random(); } catch { unit = 0; }
  unit = Number.isFinite(unit) ? Math.min(1 - Number.EPSILON, Math.max(0, unit)) : 0;
  const possibilities = SHARE_VARIATION_COUNT - (safePrevious ? 1 : 0);
  let index = Math.floor(unit * possibilities);
  if (previousIndex >= 0 && index >= previousIndex) index++;
  return { posterId: SHARE_ARTWORKS[Math.floor(index / SHARE_MOTTO_COUNT)].id, mottoIndex: index % SHARE_MOTTO_COUNT };
}

function readPrevious(storage) {
  try { return validVariation(JSON.parse(storage?.getItem(SHARE_VARIATION_STORAGE_KEY) || 'null')); }
  catch { return null; }
}

/** Keeps only a poster id and phrase index. In-memory fallback also works with storage blocked. */
export function createShareVariationSession({ random = shareRandom } = {}) {
  let latest = null;
  const choose = (previous, storage) => {
    latest = selectShareVariation(previous, random);
    try { storage?.setItem(SHARE_VARIATION_STORAGE_KEY, JSON.stringify(latest)); } catch { /* Optional session preference. */ }
    return { ...latest };
  };
  return {
    open(storage) { return choose(latest || readPrevious(storage), storage); },
    change(current, storage) { return choose(validVariation(current) || latest || readPrevious(storage), storage); },
  };
}
