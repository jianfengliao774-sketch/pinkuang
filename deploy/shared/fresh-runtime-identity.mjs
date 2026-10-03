import { readFileSync, lstatSync } from 'node:fs';
import { getAddress } from 'ethers';

export const FRESH_READINESS_PATH = '/internal/fresh-product-readiness';
/** v4 remains the default for existing installations; v5 has separate state and services. */
export function freshRuntimeLayout(env = process.env) {
  const version = env.BEMINE_FRESH_RUNTIME_VERSION ?? '4';
  if (!['4', '5'].includes(version)) throw new Error('Unsupported fresh runtime version.');
  const signerRoot = `/var/lib/pinkuang-v${version}-signer`;
  return Object.freeze({ version, signerRoot, keeperRoot: `${signerRoot}/keeper`,
    authorityJournal: `${signerRoot}/authority/authority.json`,
    workerRoot: `${signerRoot}/readiness`, drainPath: `/etc/pinkuang-v${version}/legacy-drain.json`,
    apiPort: version === '5' ? '4227' : '4187', indexPort: version === '5' ? '4224' : '4184',
    workerUnits: Object.freeze({purchase: `pinkuang-v${version}-purchase.service`,
      mining: `pinkuang-v${version}-mining.service`}) });
}
export const FRESH_RUNTIME = freshRuntimeLayout();
export const FRESH_WORKER_ROOT = FRESH_RUNTIME.workerRoot;
export const FRESH_LEGACY_DRAIN_PATH = FRESH_RUNTIME.drainPath;
export const FRESH_WORKER_UNITS = FRESH_RUNTIME.workerUnits;
export const HASH = /^0x[0-9a-f]{64}$/i;
export const SOURCE = /^[0-9a-f]{40}$/i;
export const need = (value, message) => { if (!value) throw new Error(message); };
export const same = (a,b) => typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();

export function freshRuntimeSource(root = new URL('../',import.meta.url)) {
  const path=new URL('public/fresh-release-manifest.json',root);
  const info=lstatSync(path);
  need(info.isFile() && !info.isSymbolicLink() && !(info.mode & 0o022),'Untrusted runtime release manifest.');
  const manifest=JSON.parse(readFileSync(path,'utf8'));
  need(manifest.chainId===56 && manifest.kind==='fresh-v4-product-backend-draft'
    && SOURCE.test(manifest.sourceHead),'An installed fresh product runtime is required.');
  return manifest.sourceHead;
}

export function freshGraphIdentity(graph) {
  need(graph?.freshFactoryVerified===true && graph.freshAuthority && HASH.test(graph.artifactDigest),
    'A fully verified fresh Authority graph is required.');
  const a=graph.addresses, f=graph.freshAuthority;
  return {chainId:56,artifactDigest:graph.artifactDigest.toLowerCase(),factory:getAddress(a.factory),
    market:getAddress(a.shareMarket),portfolioFactory:getAddress(a.portfolioFactory),
    portfolioMarket:getAddress(a.portfolioShareMarket),authority:getAddress(f.address),
    authorityCodehash:f.codehash.toLowerCase(),gasWallet:getAddress(f.gasWallet)};
}
export function assertFreshIdentity(actual, expected) {
  need(actual?.chainId===56,'Readiness chain differs.');
  for(const [key,value] of Object.entries(expected)) if(key!=='chainId')
    need(same(actual?.[key],value),`Readiness identity differs: ${key}.`);
}
export function validateFreshWorker(value,{role,sourceHead,identity,unit,now=Date.now()}) {
  need(Object.hasOwn(FRESH_WORKER_UNITS,role) && value?.schemaVersion===1 && value.role===role
    && value.ready===true && value.sendEnabled===true && value.sourceHead===sourceHead,
  'Worker readiness is missing or belongs to another release.');
  assertFreshIdentity(value.identity,identity);
  need(Number.isSafeInteger(value.checkedAt) && now-value.checkedAt>=0 && now-value.checkedAt<=90_000
    && Number.isSafeInteger(value.blockNumber) && value.blockNumber>0 && HASH.test(value.blockHash),
  'Worker readiness is stale or has no canonical block.');
  need(unit?.ActiveState==='active' && unit.SubState==='running'
    && String(value.pid)===String(unit.MainPID) && Number(value.pid)>0
    && /^[0-9a-f]{32}$/i.test(value.invocationId) && value.invocationId===unit.InvocationID,
  'Worker heartbeat does not identify the current systemd process.');
  return value;
}
