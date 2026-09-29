import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFreshProduct } from '../../../web/scripts/build-fresh-product.mjs';
import { packageFreshProductBackend } from '../../scripts/package-fresh-console.mjs';
import { fixture } from './fresh-cutover-fixture.mjs';
import { verifyFreshReleasePair } from './verify-fresh-release-pair.mjs';

const deploy = fileURLToPath(new URL('../../', import.meta.url));
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** CI-only synthetic graph: exercises the real static build, backend package and pair gate. */
export async function validateReleaseCi(output) {
  assert(isAbsolute(output), 'CI evidence output must be absolute.');
  assert(realpathSync(dirname(output)) === resolve(dirname(output)),
    'CI evidence parent must be canonical.');
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'bemine-v4-release-ci-')));
  try {
    const input = fixture();
    const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'],
      { cwd: repository, encoding: 'utf8' }).trim();
    const manifestPath = join(temporary, 'synthetic-manifest.json');
    const activationPath = join(temporary, 'synthetic-activation.json');
    writeFileSync(manifestPath, `${JSON.stringify(input.manifest, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(activationPath, `${JSON.stringify(input.activation, null, 2)}\n`, { mode: 0o600 });
    const frontendDir = join(temporary, 'frontend');
    const frontendRelease = buildFreshProduct(manifestPath, activationPath, { outputDir: frontendDir });
    const backendDir = join(temporary, 'backend');
    await packageFreshProductBackend({ deployDir: deploy, outDir: backendDir,
      sourceHead, cutoverInput: input });
    const backendReleaseBytes = readFileSync(join(backendDir, 'public/fresh-release-manifest.json'));
    const backendReleaseSha256 = sha256(backendReleaseBytes);
    const plan = verifyFreshReleasePair({ frontendDir, backendDir, cutoverInput: input,
      expectedSourceCommit: input.record.sourceCommit, expectedSourceHead: sourceHead,
      expectedFrontendContentSha256: frontendRelease.contentSha256,
      expectedBackendReleaseSha256: backendReleaseSha256 });
    assert.equal(plan.activationAllowed, false);
    const config = { ...input };
    for (const key of ['record', 'bundle', 'activation', 'manifest']) {
      config[`${key}Path`] = join(temporary, `${key}.json`);
      writeFileSync(config[`${key}Path`], `${JSON.stringify(config[key])}\n`, { mode: 0o600 });
      delete config[key];
    }
    const inputPath = join(temporary, 'input.json'), planPath = join(temporary, 'bound-plan.json');
    writeFileSync(inputPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    const cli = spawnSync(process.execPath, [join(deploy, 'ops/v4/verify-fresh-release-pair.mjs'),
      '--frontend', frontendDir, '--backend', backendDir, '--input', inputPath,
      '--source-commit', input.record.sourceCommit, '--source-head', sourceHead,
      '--frontend-content-sha256', frontendRelease.contentSha256,
      '--backend-release-sha256', backendReleaseSha256, '--out', planPath],
    { cwd: deploy, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr || cli.error?.message);
    assert.deepEqual(JSON.parse(readFileSync(planPath, 'utf8')).releasePair, plan.releasePair);
    mkdirSync(output);
    const evidence = { schemaVersion: 1, kind: 'synthetic-v4-release-ci',
      sourceHead, genesisSourceCommit: input.record.sourceCommit,
      frontendContentSha256: frontendRelease.contentSha256,
      backendReleaseSha256,
      indexManifestSha256: plan.releasePair.indexManifestSha256,
      artifactDigest: plan.releasePair.artifactDigest,
      activationAllowed: false,
      caveat: 'Synthetic graph only; these hashes do not authorize a production release.' };
    writeFileSync(join(output, 'summary.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
    writeFileSync(join(output, 'frontend-release.json'),
      readFileSync(join(frontendDir, 'fresh-product-release.json')), { flag: 'wx' });
    writeFileSync(join(output, 'backend-release.json'), backendReleaseBytes, { flag: 'wx' });
    return evidence;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(process.argv.length === 4 && process.argv[2] === '--out',
      'Usage: node ops/v4/validate-release-ci.mjs --out <new-absolute-evidence-dir>');
    console.log(JSON.stringify(await validateReleaseCi(process.argv[3]), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
