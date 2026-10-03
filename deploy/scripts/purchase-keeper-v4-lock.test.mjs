import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const moduleUrl = new URL('./purchase-keeper.mjs', import.meta.url).href;

function fixture(t) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'v4-keeper-lock-'));
  const state = join(directory, 'state'), root = join(state, 'locks');
  const resource = join(directory, 'purchase.json');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env, PINKUANG_KEEPER_STATE_ROOT: state };
  const call = `import { acquireKeeperLock } from ${JSON.stringify(moduleUrl)};
    const release = acquireKeeperLock(${JSON.stringify(resource)}, ${JSON.stringify(root)},
      { v4StateRoot: ${JSON.stringify(state)} });`;
  const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', `${call} release();`],
    { env, encoding: 'utf8' });
  const paths = () => {
    const lock = join(root, readdirSync(root).find(name => name.endsWith('.lock')));
    return { lock, sidecar: `${lock}.meta` };
  };
  return { state, root, resource, env, call, run, paths };
}

test('v4 sidecar makes a torn diagnostic record recoverable without replacing its flock inode', t => {
  const f = fixture(t);
  { const first = f.run(); assert.equal(first.status, 0, first.stderr); }
  const { lock, sidecar } = f.paths(), inode = statSync(lock).ino;
  const prior = JSON.parse(readFileSync(sidecar, 'utf8'));
  assert.equal(prior.lockProtocol, 'flock-v1-sidecar');
  assert.equal(prior.lockIno, String(inode));
  assert.equal(statSync(sidecar).mode & 0o777, 0o600);
  writeFileSync(lock, '{"lockProtocol":');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(lock).ino, inode, 'the lock inode must remain stable');
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).lockProtocol, 'flock-v1');
  assert.equal(JSON.parse(readFileSync(sidecar, 'utf8')).lockIno, String(inode));
});

test('v4 adopts a valid older flock record before its first protected restart', t => {
  const f = fixture(t);
  const normalCall = `import { acquireKeeperLock } from ${JSON.stringify(moduleUrl)};
    acquireKeeperLock(${JSON.stringify(f.resource)}, ${JSON.stringify(f.root)})();`;
  const legacy = spawnSync(process.execPath, ['--input-type=module', '-e', normalCall],
    { env: f.env, encoding: 'utf8' });
  assert.equal(legacy.status, 0, legacy.stderr);
  const { lock, sidecar } = f.paths(), inode = statSync(lock).ino;
  assert.equal(readdirSync(f.root).length, 1, 'older flock records have no sidecar');
  const adopted = f.run();
  assert.equal(adopted.status, 0, adopted.stderr);
  assert.equal(statSync(lock).ino, inode);
  assert.equal(JSON.parse(readFileSync(sidecar, 'utf8')).resource, f.resource);
});

test('v4 torn lock without a validated sidecar stays locked for manual review', t => {
  const f = fixture(t);
  { const first = f.run(); assert.equal(first.status, 0, first.stderr); }
  const { lock, sidecar } = f.paths();
  unlinkSync(sidecar);
  writeFileSync(lock, '{');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no readable owner/);
  assert.equal(readFileSync(lock, 'utf8'), '{');
});

test('an existing lock with a scalar JSON owner is never adopted or rewritten', t => {
  const f = fixture(t);
  { const first = f.run(); assert.equal(first.status, 0, first.stderr); }
  const { lock, sidecar } = f.paths();
  unlinkSync(sidecar);
  for (const value of ['null', 'false', '0', '""']) {
    writeFileSync(lock, value);
    const attempt = f.run();
    assert.notEqual(attempt.status, 0);
    assert.match(attempt.stderr, /no valid owner record/);
    assert.equal(readFileSync(lock, 'utf8'), value);
  }
});

test('v4 torn lock rejects a sidecar with wrong inode or a still-running owner', t => {
  const f = fixture(t);
  { const first = f.run(); assert.equal(first.status, 0, first.stderr); }
  const { lock, sidecar } = f.paths();
  const prior = JSON.parse(readFileSync(sidecar, 'utf8'));
  writeFileSync(lock, '{');
  writeFileSync(sidecar, `${JSON.stringify({ ...prior, lockIno: '0' })}\n`);
  const wrongInode = f.run();
  assert.notEqual(wrongInode.status, 0);
  assert.match(wrongInode.stderr, /metadata identity is invalid/);
  writeFileSync(sidecar, `${JSON.stringify({ ...prior, pid: process.pid })}\n`);
  const liveOwner = f.run();
  assert.notEqual(liveOwner.status, 0);
  assert.match(liveOwner.stderr, /owner is still running/);
  assert.equal(readFileSync(lock, 'utf8'), '{');
});

test('v4 sidecar cannot be a symlink, including a dangling symlink', t => {
  const f = fixture(t);
  { const first = f.run(); assert.equal(first.status, 0, first.stderr); }
  const { sidecar } = f.paths();
  unlinkSync(sidecar);
  symlinkSync(join(f.root, 'missing'), sidecar);
  const result = f.run();
  assert.notEqual(result.status, 0);
});

test('live flock excludes a second v4 signer even if the diagnostic record is torn', async t => {
  const f = fixture(t);
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `${f.call}
    process.stdout.write('READY\\n');
    process.stdin.once('data', () => { release(); process.exit(0); });`],
  { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => holder.kill());
  const [ready] = await once(holder.stdout, 'data');
  assert.match(String(ready), /READY/);
  const { lock } = f.paths();
  writeFileSync(lock, '{');
  const contender = f.run();
  assert.notEqual(contender.status, 0);
  assert.match(contender.stderr, /already exists/);
  assert.equal(readFileSync(lock, 'utf8'), '{');
  holder.stdin.write('release\n');
  assert.equal((await once(holder, 'exit'))[0], 0);
});
