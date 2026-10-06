import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Wallet } from 'ethers';
import { createSetupServer, saveCredentialViaSsh } from './local-keeper-setup.mjs';

const SAMPLE_KEY = `0x${'11'.repeat(32)}`;

test('local setup page requires its form token and writes a valid key once', async () => {
  const saved = [];
  const setup = await createSetupServer({ saveCredential: async key => saved.push(key) });
  try {
    const form = await fetch(setup.url);
    assert.equal(form.status, 200);
    const html = await form.text();
    assert.match(html, /录入专用 Gas 钱包/);
    const token = html.match(/name="formToken" value="([0-9a-f]{64})"/)?.[1];
    assert.ok(token);

    const blocked = await fetch(setup.url, { method: 'POST', headers: {
      origin: 'https://attacker.example', 'content-type': 'application/x-www-form-urlencoded',
    }, body: new URLSearchParams({ key: SAMPLE_KEY }) });
    assert.equal(blocked.status, 403);
    assert.deepEqual(saved, []);

    const invalid = await fetch(setup.url, { method: 'POST', headers: {
      'content-type': 'application/x-www-form-urlencoded',
    }, body: new URLSearchParams({ formToken: token, key: 'not-a-private-key' }) });
    assert.equal(invalid.status, 400);
    assert.deepEqual(saved, []);

    const accepted = await fetch(setup.url, { method: 'POST', headers: {
      origin: 'null', 'content-type': 'application/x-www-form-urlencoded',
    }, body: new URLSearchParams({ formToken: token, key: SAMPLE_KEY }) });
    assert.equal(accepted.status, 200);
    const response = await accepted.text();
    assert.match(response, new RegExp(new Wallet(SAMPLE_KEY).address, 'i'));
    assert.ok(!response.includes(SAMPLE_KEY));
    assert.deepEqual(saved, [SAMPLE_KEY]);

    const second = await fetch(setup.url);
    assert.equal(second.status, 410);
  } finally { setup.close(); }
});

test('SSH command transmits the key only on stdin', async () => {
  let argv, stdin = '';
  const spawnImpl = (command, args) => {
    argv = [command, ...args];
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin.on('data', chunk => { stdin += chunk.toString(); });
    child.stdin.on('end', () => { child.stdout.write('saved\n'); child.emit('close', 0); });
    return child;
  };
  await saveCredentialViaSsh(SAMPLE_KEY, { spawnImpl, sshKey: '/tmp/test-key' });
  assert.equal(stdin, `${SAMPLE_KEY}\n`);
  assert.equal(argv[0], 'ssh');
  assert.ok(!argv.join(' ').includes(SAMPLE_KEY));
});
