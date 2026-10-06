export const DEFAULT_PUBLIC_SHARE_ORIGIN = 'https://tapeout.cc.cd';

export function isExactHttpsOrigin(value) {
  try {
    if (typeof value !== 'string') return false;
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password;
  } catch { return false; }
}

// Next inlines this trusted build setting. Never derive trust from the current
// browser location, share-link parameters or the URL being checked.
const configuredOrigin = process.env.NEXT_PUBLIC_BEMINE_PUBLIC_ORIGIN;
export const PUBLIC_SHARE_ORIGIN = isExactHttpsOrigin(configuredOrigin)
  ? configuredOrigin : DEFAULT_PUBLIC_SHARE_ORIGIN;
export const isTrustedShareOrigin = value => value === DEFAULT_PUBLIC_SHARE_ORIGIN || value === PUBLIC_SHARE_ORIGIN;
