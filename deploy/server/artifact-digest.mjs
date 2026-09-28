import { readFileSync } from 'node:fs';
import { keccak256, toUtf8Bytes } from 'ethers';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

/** Digest of the artifact JSON this HTTP server actually serves to browsers. */
export function servedArtifactDigest(path) {
  const { sourceCommit: _commit, ...content } = JSON.parse(readFileSync(path, 'utf8'));
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(content))));
}
