import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, keccak256 } from 'ethers';

// Keeper locks remain fail-closed during ordinary operation. This separate
// command is the only recovery path, and an operator must invoke it manually.
export function authorityLockPath(resourcePath, lockRoot) {
  const identity = keccak256(new TextEncoder().encode(resolve(resourcePath))).slice(2);
  return resolve(lockRoot, `${identity}.lock`);
}

export function clearStaleAuthorityLock(resourcePath, lockRoot, minimumAgeMs = 60_000) {
  const root = lstatSync(lockRoot);
  if (!root.isDirectory() || (root.mode & 0o077) !== 0)
    throw new Error('Lock directory must be a real private 0700 directory.');
  const lock = authorityLockPath(resourcePath, lockRoot);
  // Only one recovery process may inspect/remove this lock. A live keeper does
  // not use the recovery marker but cannot replace its still-existing lock.
  const guard = `${lock}.recovery`;
  const guardFd = openSync(guard, 'wx', 0o600);
  try {
    const fd = openSync(lock, constants.O_RDONLY | constants.O_NOFOLLOW);
    let details, info;
    try {
      info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0)
        throw new Error('Lock must be a private regular file.');
      details = JSON.parse(readFileSync(fd, 'utf8'));
    } finally { closeSync(fd); }
    const created = Date.parse(details.createdAt);
    if (!Number.isSafeInteger(details.pid) || details.pid <= 0
      || details.resource !== resolve(resourcePath) || !Number.isFinite(created)
      || Date.now() - Math.max(created, info.mtimeMs) < minimumAgeMs)
      throw new Error('Lock identity or minimum age is not verified; retain it for manual investigation.');
    try { process.kill(details.pid, 0); }
    catch (error) {
      if (error.code !== 'ESRCH') throw new Error('Lock owner liveness is uncertain; retain the lock.');
      const latest = lstatSync(lock);
      if (latest.dev !== info.dev || latest.ino !== info.ino)
        throw new Error('Lock changed during recovery; retain it.');
      unlinkSync(lock);
      return { status: 'stale-lock-cleared', resource: resolve(resourcePath), pid: details.pid };
    }
    throw new Error('Lock owner is still alive; retain the lock.');
  } finally { closeSync(guardFd); unlinkSync(guard); }
}

export function authorityWalletLockResource(address, stateRoot) {
  return resolve(stateRoot, 'wallets', `56-${getAddress(address).toLowerCase()}.json`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [mode, value] = process.argv.slice(2);
  const root = process.env.PINKUANG_KEEPER_STATE_ROOT;
  if (root !== '/var/lib/pinkuang-v4-signer/keeper')
    throw new Error('Manual lock recovery is restricted to the distinct v4 signer state root.');
  if (!value || process.argv.length !== 4 || !['--journal', '--wallet'].includes(mode))
    throw new Error('Usage: node scripts/authority-relay-lock-recovery.mjs --journal /private/authority.json OR --wallet 0xAddress');
  if (mode === '--journal' && resolve(value) !== '/var/lib/pinkuang-v4-signer/authority/authority.json')
    throw new Error('Manual lock recovery is restricted to the v4 Authority journal.');
  const resource = mode === '--journal' ? resolve(value) : authorityWalletLockResource(value, root);
  const lockRoot = mode === '--journal' ? resolve(root, 'locks') : resolve(root, 'wallets', 'locks');
  console.log(JSON.stringify(clearStaleAuthorityLock(resource, lockRoot)));
}
