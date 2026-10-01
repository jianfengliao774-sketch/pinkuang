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
    assert.ok(!html.includes('minlength="66"'));
    assert.ok(!html.includes('pattern="0x'));
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
    }, body: new URLSearchParams({ formToken: token, key: ` \n${SAMPLE_KEY.slice(2)}\t ` }) });
    assert.equal(accepted.status, 200);
    const response = await accepted.text();
    assert.match(response, new RegExp(new Wallet(SAMPLE_KEY).address, 'i'));
    assert.ok(!response.includes(SAMPLE_KEY));
    assert.ok(!response.includes(SAMPLE_KEY.slice(2)));
    assert.deepEqual(saved, [SAMPLE_KEY]);

    const second = await fetch(setup.url);
    assert.equal(second.status, 200);
    assert.equal(await second.text(), response);
    const repeated = await fetch(setup.url, { method: 'POST', body: 'ignored' });
    assert.equal(repeated.status, 200);
    assert.equal(await repeated.text(), response);
    assert.deepEqual(saved, [SAMPLE_KEY]);
  } finally { setup.close(); }
});

test('duplicate requests during saving show progress and then the public receipt', async () => {
  let finishSave, signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const pending = new Promise(resolve => { finishSave = resolve; });
  const saved = [];
  const setup = await createSetupServer({ saveCredential: async key => {
    saved.push(key);
    signalStarted();
    await pending;
  } });
  try {
    const html = await (await fetch(setup.url)).text();
    const token = html.match(/name="formToken" value="([0-9a-f]{64})"/)[1];
    const first = fetch(setup.url, { method: 'POST',
      body: new URLSearchParams({ formToken: token, key: SAMPLE_KEY }) });
    await started;
    for (const options of [{}, { method: 'POST', body: 'ignored' }]) {
      const duplicate = await fetch(setup.url, options);
      assert.equal(duplicate.status, 202);
      const progress = await duplicate.text();
      assert.match(progress, /正在保存/);
      assert.match(progress, /http-equiv="refresh"/);
      assert.ok(!progress.includes(SAMPLE_KEY.slice(2)));
    }
    finishSave();
    assert.equal((await first).status, 200);
    const receipt = await fetch(setup.url);
    assert.equal(receipt.status, 200);
    assert.match(await receipt.text(), /已安全保存/);
    assert.deepEqual(saved, [SAMPLE_KEY]);
  } finally { finishSave(); setup.close(); }
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
  await saveCredentialViaSsh(` \t${SAMPLE_KEY.replace('0x', '0X')}\n`, { spawnImpl, sshKey: '/tmp/test-key' });
  assert.equal(stdin, `${SAMPLE_KEY}\n`);
  assert.equal(argv[0], 'ssh');
  assert.ok(!argv.join(' ').includes(SAMPLE_KEY));
});
