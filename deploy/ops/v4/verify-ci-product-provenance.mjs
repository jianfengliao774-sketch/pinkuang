import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'jianfengliao774-sketch/pinkuang';
const WORKFLOW = `${REPO}/.github/workflows/v4-product-release.yml`;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Verify Sigstore signatures via gh, pinned to our reviewed GitHub-hosted build. */
export function verifyCiProductProvenance(directory, sourceHead, { run = execFileSync } = {}) {
  assert(isAbsolute(directory) && realpathSync(directory) === resolve(directory),
    'Downloaded release directory must be canonical and absolute.');
  assert(/^[a-f0-9]{40}$/.test(sourceHead), 'A reviewed source commit is required.');
  const subjects = ['build-summary.json', 'frontend.tar.gz', 'backend.tar.gz'];
  const bytes = new Map();
  const proofs = {};
  for (const name of subjects) {
    const path = join(directory, name), stat = lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, `Invalid artifact ${name}.`);
    bytes.set(name, readFileSync(path));
    // Never trust a saved "verified:true" file or a caller-provided verifier.
    // gh validates the certificate, transparency log and actual file digest.
    proofs[name] = JSON.parse(run('gh', ['attestation', 'verify', path,
      '--repo', REPO, '--signer-workflow', WORKFLOW, '--signer-digest', sourceHead,
      '--source-digest', sourceHead, '--deny-self-hosted-runners', '--format', 'json'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120000 }));
    assert(Array.isArray(proofs[name]) && proofs[name].length > 0, `No verified attestation for ${name}.`);
  }
  const summary = JSON.parse(bytes.get('build-summary.json').toString('utf8'));
  assert(summary.schemaVersion === 1 && summary.kind === 'reviewed-v4-product-ci-candidate'
    && summary.sourceHead === sourceHead && summary.activationAllowed === false
    && summary.publicOrigin === 'https://bemine.cc.cd' && summary.basePath === '/bemine-v4'
    && summary.releasePair?.sourceHead === sourceHead, 'Unexpected attested build identity.');
  for (const name of subjects.slice(1)) {
    assert.equal(summary.archives?.[name]?.sha256, sha256(bytes.get(name)), `Archive mismatch: ${name}.`);
    assert.equal(summary.archives?.[name]?.bytes, bytes.get(name).length, `Archive size mismatch: ${name}.`);
  }
  return { schemaVersion: 1, kind: 'verified-v4-ci-provenance', sourceHead,
    repository: REPO, signerWorkflow: WORKFLOW, activationAllowed: false,
    summarySha256: sha256(bytes.get('build-summary.json')),
    archives: summary.archives, releasePair: summary.releasePair, proofs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(process.argv.length === 8 && process.argv[2] === '--directory'
      && process.argv[4] === '--source-head' && process.argv[6] === '--out',
    'Usage: node verify-ci-product-provenance.mjs --directory <downloaded-dir> --source-head <reviewed-commit> --out <new-evidence.json>');
    const output = process.argv[7];
    assert(isAbsolute(output) && realpathSync(dirname(output)) === resolve(dirname(output)));
    const verified = verifyCiProductProvenance(process.argv[3], process.argv[5]);
    writeFileSync(output, `${JSON.stringify(verified, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ sourceHead: verified.sourceHead, activationAllowed: false,
      summarySha256: verified.summarySha256, releasePair: verified.releasePair }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
