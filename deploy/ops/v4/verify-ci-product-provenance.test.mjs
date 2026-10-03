import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyCiProductProvenance } from './verify-ci-product-provenance.mjs';

const head = 'a'.repeat(40);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ci-provenance-test-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const archives = {};
  for (const name of ['frontend.tar.gz', 'backend.tar.gz']) {
    const bytes = Buffer.from(`test fixture ${name}`);
    writeFileSync(join(directory, name), bytes);
    archives[name] = { sha256: sha(bytes), bytes: bytes.length };
  }
  const summary = { schemaVersion: 1, kind: 'reviewed-v4-product-ci-candidate',
    sourceHead: head, activationAllowed: false, publicOrigin: 'https://bemine.cc.cd',
    basePath: '/bemine-v4', releasePair: { sourceHead: head }, archives };
  const save = () => writeFileSync(join(directory, 'build-summary.json'), JSON.stringify(summary));
  save();
  return { directory, summary, save };
}
const verified = () => JSON.stringify([{ verificationResult: { testFixture: true } }]);

test('requires gh to verify every subject at the expected workflow and commit', t => {
  const { directory } = fixture(t), calls = [];
  const proof = verifyCiProductProvenance(directory, head, { run(command, args) {
    calls.push({ command, args }); return verified();
  } });
  assert.equal(calls.length, 3);
  for (const { command, args } of calls) {
    assert.equal(command, 'gh');
    for (const flag of ['--source-digest', '--signer-digest'])
      assert.equal(args[args.indexOf(flag) + 1], head);
    assert.equal(args[args.indexOf('--repo') + 1], 'jianfengliao774-sketch/pinkuang');
    assert.equal(args[args.indexOf('--signer-workflow') + 1],
      'jianfengliao774-sketch/pinkuang/.github/workflows/v4-product-release.yml');
    assert(args.includes('--deny-self-hosted-runners'));
  }
  assert.equal(proof.activationAllowed, false);
});

test('failed or empty cryptographic verification cannot produce release pins', t => {
  const { directory } = fixture(t);
  assert.throws(() => verifyCiProductProvenance(directory, head,
    { run() { throw new Error('Sigstore verification failed'); } }), /Sigstore/);
  assert.throws(() => verifyCiProductProvenance(directory, head,
    { run: () => '[]' }), /No verified attestation/);
});

test('attested but unrelated archive and summary are rejected', t => {
  const { directory } = fixture(t);
  writeFileSync(join(directory, 'frontend.tar.gz'),
    Buffer.concat([readFileSync(join(directory, 'frontend.tar.gz')), Buffer.from('tampered')]));
  assert.throws(() => verifyCiProductProvenance(directory, head, { run: verified }), /Archive mismatch/);
});

test('wrong source, domain or enabled candidate cannot be accepted', t => {
  for (const [key, value] of [['sourceHead', 'b'.repeat(40)], ['publicOrigin', 'https://tapeout.cc.cd'],
    ['activationAllowed', true]]) {
    const { directory, summary, save } = fixture(t);
    summary[key] = value; save();
    assert.throws(() => verifyCiProductProvenance(directory, head, { run: verified }), /build identity/);
  }
});
