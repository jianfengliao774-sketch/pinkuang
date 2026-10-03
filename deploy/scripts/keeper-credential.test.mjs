import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { readKeeperPrivateKey, readKeeperPublicAddress } from './keeper-credential.mjs';

const key = `0x${'a'.repeat(64)}`;

test('keeper credentials take a fixed file and refuse ambiguous or invalid sources', t => {
  const directory = mkdtempSync(join(tmpdir(), 'bemine-credential-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(readKeeperPrivateKey({ KEEPER_PRIVATE_KEY: key }), key);
  assert.throws(() => readKeeperPrivateKey({}), /required/);
  assert.throws(() => readKeeperPrivateKey({ CREDENTIALS_DIRECTORY: directory }), /unavailable/);
  writeFileSync(join(directory, 'keeper-private-key'), `${key}\n`, { mode: 0o600 });
  assert.equal(readKeeperPrivateKey({ CREDENTIALS_DIRECTORY: directory }), key);
  assert.throws(() => readKeeperPrivateKey({ CREDENTIALS_DIRECTORY: directory, KEEPER_PRIVATE_KEY: key }), /either/);
  assert.throws(() => readKeeperPrivateKey({ CREDENTIALS_DIRECTORY: 'relative' }), /directory/);
  rmSync(join(directory, 'keeper-private-key'));
  symlinkSync('/dev/null', join(directory, 'keeper-private-key'));
  assert.throws(() => readKeeperPrivateKey({ CREDENTIALS_DIRECTORY: directory }), /credential file/);
});

test('public Gas address comes only from the systemd credential', t => {
  const directory = mkdtempSync(join(tmpdir(), 'bemine-public-credential-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => readKeeperPublicAddress({ KEEPER_PRIVATE_KEY: key }), /systemd/);
  assert.throws(() => readKeeperPublicAddress({ CREDENTIALS_DIRECTORY: directory }), /unavailable/);
  writeFileSync(join(directory, 'keeper-private-key'), `${key}\n`, { mode: 0o600 });
  assert.equal(readKeeperPublicAddress({ CREDENTIALS_DIRECTORY: directory }), new Wallet(key).address);
  assert.throws(() => readKeeperPublicAddress({ CREDENTIALS_DIRECTORY: directory, KEEPER_PRIVATE_KEY: key }), /systemd/);
});

test('keeper locks can live outside a protected home directory', () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    "import { KEEPER_STATE_ROOT } from './scripts/purchase-keeper.mjs'; console.log(KEEPER_STATE_ROOT)"],
  { cwd: new URL('..', import.meta.url), env: { ...process.env, PINKUANG_KEEPER_STATE_ROOT: '/var/lib/pinkuang-keeper/state' }, encoding: 'utf8' });
  assert.equal(output.trim(), '/var/lib/pinkuang-keeper/state');
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e',
    "import './scripts/purchase-keeper.mjs'"],
  { cwd: new URL('..', import.meta.url), env: { ...process.env, PINKUANG_KEEPER_STATE_ROOT: 'relative' }, stdio: 'pipe' }));
});
