import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Wallet } from 'ethers';

/** Read a systemd LoadCredential file, with the legacy process environment as a fallback. */
export function readKeeperPrivateKey(env = process.env) {
  const inline = env.KEEPER_PRIVATE_KEY;
  const directory = env.CREDENTIALS_DIRECTORY;
  if (inline && directory) throw new Error('Configure either the keeper credential or KEEPER_PRIVATE_KEY, not both.');
  let key = inline;
  if (directory) {
    if (!isAbsolute(directory)) throw new Error('Invalid systemd credentials directory.');
    const path = join(directory, 'keeper-private-key');
    let info;
    try { info = lstatSync(path); }
    catch { throw new Error('Keeper credential is unavailable.'); }
    if (!info.isFile() || info.size > 128) throw new Error('Invalid keeper credential file.');
    try { key = readFileSync(path, 'utf8').trim(); }
    catch { throw new Error('Keeper credential is unavailable.'); }
  }
  if (!/^0x[0-9a-f]{64}$/i.test(key ?? '')) throw new Error('A valid keeper private key is required for --send.');
  return key;
}

/** Derive only the public sender from a systemd credential; fail closed without it. */
export function readKeeperPublicAddress(env = process.env) {
  if (!env.CREDENTIALS_DIRECTORY || env.KEEPER_PRIVATE_KEY)
    throw new Error('A systemd Gas-wallet credential is required.');
  try { return new Wallet(readKeeperPrivateKey(env)).address; }
  catch { throw new Error('Gas-wallet credential is unavailable or invalid.'); }
}
