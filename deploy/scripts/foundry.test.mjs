import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { forgeToolchain } from '../../scripts/foundry.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('native npm distribution precedes a shim on PATH, including nested tool calls', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'pinkuang-forge-select-'));
  try {
    const binary = join(fixture, 'deploy/node_modules/@foundry-rs/forge-linux-amd64/bin/forge');
    mkdirSync(dirname(binary), { recursive: true }); writeFileSync(binary, 'native fixture');
    const original = { PATH: '/npm/shims:/usr/bin', CHECK: 'preserved' };
    const selected = forgeToolchain(fixture, { platform: 'linux', arch: 'x64', env: original });
    assert.equal(selected.executable, binary);
    assert.equal(selected.env.PATH, dirname(binary) + delimiter + original.PATH);
    assert.equal(selected.env.CHECK, original.CHECK);
    assert.equal(original.PATH, '/npm/shims:/usr/bin');
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('CI without the npm distribution preserves the native PATH toolchain', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'pinkuang-forge-path-'));
  try {
    assert.deepEqual(forgeToolchain(fixture, { env: { PATH: '/foundry/bin:/usr/bin' } }),
      { executable: 'forge', env: { PATH: '/foundry/bin:/usr/bin' } });
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('validation launcher preserves native Forge failure instead of npm wrapper success', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'pinkuang-forge-failure-'));
  try {
    // An explicitly nonexistent compiler gives a deterministic native failure,
    // without fetching a compiler or making any RPC request in CI.
    mkdirSync(join(fixture, 'src'));
    writeFileSync(join(fixture, 'src/Fail.sol'), 'pragma solidity 0.8.24; contract Fail {}\n');
    const result = spawnSync(process.execPath,
      [join(root, 'scripts/run-forge.mjs'), 'build', '--root', fixture, '--use', join(fixture, 'missing-solc'), '--offline'],
      { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr + result.stdout, /solc|compiler/i);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
