import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { getAddress } from 'ethers';

const HASH = /^0x[\da-f]{64}$/i;
const ADDRESS_FIELDS = ['factory', 'shareMarket', 'lens', 'beacon', 'timelock',
  'portfolioFactory', 'portfolioMarket', 'portfolioBeacon', 'portfolioImplementation',
  'portfolioFactoryImplementation'];
const check = (valid, message) => { if (!valid) throw new Error(message); };
const address = (value, name) => {
  check(typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value), `Invalid fresh ${name} address.`);
  const result = getAddress(value);
  check(result !== '0x0000000000000000000000000000000000000000', `Zero fresh ${name} address.`);
  return result;
};
const hash = (value, name) => {
  check(typeof value === 'string' && HASH.test(value), `Invalid fresh ${name} hash.`);
  return value.toLowerCase();
};

function normalized(value) {
  check(value?.schemaVersion === 1 && value.chainId === 56, 'Invalid fresh index manifest identity.');
  const addresses = Object.fromEntries(ADDRESS_FIELDS.map(name => [name, address(value[name], name)]));
  check(new Set(Object.values(addresses).map(value => value.toLowerCase())).size === ADDRESS_FIELDS.length,
    'Fresh graph addresses must be distinct.');
  const codehash = Object.fromEntries(ADDRESS_FIELDS.map(name => [name, hash(value.codehash?.[name], `${name} code`)]));
  const authority = address(value.authority, 'Authority');
  const gasWallet = address(value.gasWallet, 'Gas wallet');
  const proof = value.freshAuthority;
  check(proof && address(proof.address, 'Authority proof') === authority
    && address(proof.gasWallet, 'Gas wallet proof') === gasWallet,
  'Fresh Authority manifest identity differs.');
  check(!Object.values(addresses).includes(authority) && !Object.values(addresses).includes(gasWallet)
    && authority !== gasWallet,
    'Fresh Authority and Gas wallet must be separate from the contract graph.');
  const deployment = value.deployment;
  check(Number.isSafeInteger(deployment?.blockNumber) && deployment.blockNumber > 0
    && Number.isSafeInteger(value.verifiedBlockNumber)
    && value.verifiedBlockNumber >= deployment.blockNumber,
  'Fresh deployment and verified block numbers are invalid.');
  const administratorOne=address(proof.administratorOne, 'first administrator');
  const administratorTwo=address(proof.administratorTwo, 'second administrator');
  check(administratorOne !== administratorTwo && administratorOne !== authority
    && administratorTwo !== authority && administratorOne !== gasWallet && administratorTwo !== gasWallet,
  'Fresh administrators must be distinct from Authority and Gas wallet.');
  return {
    schemaVersion: 1, kind: 'fresh-v4-index', chainId: 56,
    artifactDigest: hash(value.artifactDigest, 'artifact digest'),
    deployment: { txHash: hash(deployment.txHash, 'deployment transaction'),
      blockNumber: deployment.blockNumber, blockHash: hash(deployment.blockHash, 'deployment block') },
    verifiedBlockNumber: value.verifiedBlockNumber,
    verifiedBlockHash: hash(value.verifiedBlockHash, 'verified block'),
    ...addresses, codehash, authority, gasWallet,
    freshAuthority: {
      address: authority, codehash: hash(proof.codehash, 'Authority code'),
      deploymentTxHash: hash(proof.deploymentTxHash, 'Authority deployment transaction'),
      administratorOne, administratorTwo,
      gasWallet,
    },
  };
}

/** This projects an already reviewed product-graph manifest into the index's fixed address input. */
export function createFreshIndexManifest(reviewedManifest) {
  check(reviewedManifest?.kind === 'integrated-v2', 'A reviewed fresh integrated manifest is required.');
  return normalized(reviewedManifest);
}

export function freshIndexManifestBytes(value) {
  check(value?.kind === 'fresh-v4-index', 'A fresh v4 index manifest is required.');
  return Buffer.from(`${JSON.stringify(normalized(value), null, 2)}\n`);
}

export function freshIndexManifestSha256(value) {
  return createHash('sha256').update(freshIndexManifestBytes(value)).digest('hex');
}

/** Refuse a substituted or edited manifest before opening an index database or making an RPC call. */
export function loadFreshIndexManifest(path, expectedSha256) {
  check(typeof path === 'string' && path.startsWith('/'), 'An absolute fresh index manifest path is required.');
  check(typeof expectedSha256 === 'string' && /^[\da-f]{64}$/i.test(expectedSha256),
    'A pinned fresh index manifest SHA256 is required.');
  const stat = lstatSync(path);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 8192,
    'Fresh index manifest must be a small regular file.');
  const bytes = readFileSync(path);
  check(createHash('sha256').update(bytes).digest('hex') === expectedSha256.toLowerCase(),
    'Fresh index manifest SHA256 differs from the reviewed release.');
  const parsed = JSON.parse(bytes.toString('utf8'));
  check(parsed?.kind === 'fresh-v4-index' && bytes.equals(freshIndexManifestBytes(parsed)),
    'Fresh index manifest must use the canonical reviewed format.');
  return normalized(parsed);
}
