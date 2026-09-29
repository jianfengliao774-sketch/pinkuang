import { spawnSync } from 'node:child_process';
import { constants, closeSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readFileSync, writeSync } from 'node:fs';
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
  if (!root.isDirectory() || (root.mode & 0o077) !== 0 || root.uid !== process.getuid())
    throw new Error('Lock directory must be a real private 0700 directory.');
  const lock = authorityLockPath(resourcePath, lockRoot);
  // Preserve the inode. Unlinking it can let two signers lock different files
  // for the same wallet when one has already opened the old inode.
  const fd = openSync(lock, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.uid !== process.getuid())
      throw new Error('Lock must be a private regular file owned by this process.');
    const result = process.platform === 'darwin'
      ? spawnSync('python3', ['-c', 'import fcntl,sys\ntry: fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(75)'],
        { stdio: ['ignore', 'ignore', 'ignore', fd] })
      : spawnSync('/usr/bin/flock', ['-n', '-E', '75', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
    if (result.status === 75) throw new Error('Another process holds this lock; retain it.');
    if (result.error || result.status !== 0) throw new Error('OS file-lock helper failed; retain the lock.');
    const current = lstatSync(lock);
    if (current.dev !== info.dev || current.ino !== info.ino)
      throw new Error('Lock changed during recovery; retain it.');
    let details;
    try { details = JSON.parse(readFileSync(fd, 'utf8')); } catch { /* A torn diagnostic record can be rebuilt manually. */ }
    if (details?.lockProtocol === 'flock-v1') {
      if (details.resource !== resolve(resourcePath)) throw new Error('Lock identity is invalid; retain it.');
      return { status: 'stable-lock-reusable', resource: resolve(resourcePath) };
    }
    if (Date.now() - info.mtimeMs < minimumAgeMs)
      throw new Error('Lock minimum age is not verified; retain it for manual investigation.');
    if (details) {
      const created = Date.parse(details.createdAt);
      if (!Number.isSafeInteger(details.pid) || details.pid <= 0
        || details.resource !== resolve(resourcePath) || !Number.isFinite(created)
        || Date.now() - created < minimumAgeMs)
        throw new Error('Lock identity or minimum age is not verified; retain it for manual investigation.');
      let dead = false;
      try { process.kill(details.pid, 0); }
      catch (error) {
        if (error.code !== 'ESRCH') throw new Error('Lock owner liveness is uncertain; retain the lock.');
        dead = true;
      }
      if (!dead) throw new Error('Lock owner is still alive; retain the lock.');
    }
    ftruncateSync(fd, 0);
    writeSync(fd, `${JSON.stringify({ lockProtocol: 'flock-v1', pid: process.pid,
      resource: resolve(resourcePath), createdAt: new Date().toISOString(), recovered: true })}\n`, 0, 'utf8');
    fsyncSync(fd);
    return { status: 'stale-lock-reinitialized', resource: resolve(resourcePath) };
  } finally { closeSync(fd); }
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
