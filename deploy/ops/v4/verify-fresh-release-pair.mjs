import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { servedArtifactDigest } from '../../server/artifact-digest.mjs';
import { createFreshIndexManifest, freshIndexManifestBytes,
  freshIndexManifestSha256 } from '../../server/chain-index/fresh-manifest.mjs';
import { PRODUCT_BACKEND_MODULES } from '../../scripts/package-fresh-console.mjs';
import { prepareFreshCutover } from './prepare-fresh-cutover.mjs';
import { freshManifestDigest, validateFreshManifest } from '../../../web/lib/fresh-product-config.mjs';

const HEX_64 = /^[\da-f]{64}$/i;
const COMMIT = /^[\da-f]{40}$/i;
const REPOSITORY = fileURLToPath(new URL('../../../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string'
  && a.toLowerCase() === b.toLowerCase();

function regularTree(directory) {
  assert(typeof directory === 'string' && isAbsolute(directory), 'Release directory must be absolute.');
  const root = resolve(directory), stat = lstatSync(root);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(root) === root,
    'Release root must be a canonical regular directory.');
  const files = new Map();
  const walk = folder => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name), info = lstatSync(path);
      assert(!info.isSymbolicLink(), `Release contains a symlink: ${path}`);
      if (info.isDirectory()) { walk(path); continue; }
      assert(info.isFile(), `Release contains a non-file entry: ${path}`);
      const name = relative(root, path).split(sep).join('/');
      assert(name && !name.startsWith('../') && !name.includes('\\'), 'Unsafe release path.');
      files.set(name, readFileSync(path));
    }
  };
  walk(root);
  return files;
}

function jsonFile(files, name, maxBytes = 1024 * 1024) {
  const bytes = files.get(name);
  assert(bytes && bytes.length > 0 && bytes.length <= maxBytes, `Missing or oversized ${name}.`);
  return JSON.parse(bytes.toString('utf8'));
}

function checkFrontend(files, expectedGenesisSourceCommit, expectedSourceHead,
  expectedContentSha256) {
  const release = jsonFile(files, 'fresh-product-release.json', 65536);
  assert(release.schemaVersion === 1 && release.kind === 'fresh-v4-product-static-candidate'
    && release.chainId === 56 && release.basePath === '/bemine-v4'
    && release.productFamily === 'fresh-v4' && release.activationAllowed === false
    && release.legacyManifestIncluded === false, 'Not a disabled fresh v4 static release.');
  assert(!files.has('data/frontend-manifest.json'), 'Legacy frontend manifest must not be shipped.');
  assert(files.has('index.html'), 'Fresh frontend index.html is missing.');
  const names = [...files.keys()].filter(name => name !== 'fresh-product-release.json').sort();
  const contentSha256 = sha256(names.map(name => `${name}\0${sha256(files.get(name))}\n`).join(''));
  assert(HEX_64.test(release.contentSha256) && contentSha256 === release.contentSha256.toLowerCase()
    && release.fileCount === names.length, 'Fresh frontend file inventory differs from the release digest.');
  assert(contentSha256 === expectedContentSha256.toLowerCase(),
    'Fresh frontend content differs from the independently reviewed digest.');
  assert(COMMIT.test(release.frontendSourceHead) && same(release.frontendSourceHead, expectedSourceHead),
    'Frontend build source HEAD differs from the reviewed commit.');
  const manifest = jsonFile(files, 'data/frontend-manifest.v4.json', 65536);
  const checked = validateFreshManifest(manifest, release.manifestSha256);
  assert(same(manifest.sourceCommit, expectedGenesisSourceCommit)
    && same(release.sourceCommit, expectedGenesisSourceCommit),
  'Frontend genesis source commit differs from the reviewed deployment record.');
  for (const key of ['artifactDigest', 'factory', 'portfolioFactory', 'authority', 'gasWallet'])
    assert(same(release[key], checked[key]), `Frontend release ${key} differs from its manifest.`);
  assert.deepEqual(release.deployment, checked.deployment,
    'Frontend release deployment differs from its manifest.');
  return { release, manifest, checked, contentSha256,
    releaseSha256: sha256(files.get('fresh-product-release.json')), fileCount: names.length };
}

function checkBackend(files, backendDir, expectedSourceHead, expectedReleaseSha256) {
  const release = jsonFile(files, 'public/fresh-release-manifest.json');
  assert(sha256(files.get('public/fresh-release-manifest.json')) === expectedReleaseSha256.toLowerCase(),
    'Backend release differs from the independently reviewed manifest digest.');
  assert(release.schemaVersion === 1 && release.kind === 'fresh-v4-product-backend-draft'
    && release.chainId === 56, 'Not a fresh v4 product backend release.');
  assert(COMMIT.test(release.sourceCommit) && COMMIT.test(release.sourceHead)
    && same(release.sourceHead, expectedSourceHead),
  'Backend build source commit differs from the reviewed release commit.');
  assert.deepEqual(release.runtimeModules, PRODUCT_BACKEND_MODULES,
    'Backend runtime module inventory differs from the reviewed v4 package.');
  const listed = release.files;
  assert(listed && typeof listed === 'object' && !Array.isArray(listed),
    'Backend per-file inventory is missing.');
  const manifestName = 'public/fresh-release-manifest.json';
  const actualNames = [...files.keys()].filter(name => name !== manifestName).sort();
  const listedNames = Object.keys(listed).sort();
  assert.deepEqual(actualNames, listedNames, 'Backend contains missing or unlisted files.');
  for (const name of actualNames) {
    const claim = listed[name], bytes = files.get(name);
    assert(claim && HEX_64.test(claim.sha256) && Number.isSafeInteger(claim.bytes)
      && claim.bytes === bytes.length && claim.sha256.toLowerCase() === sha256(bytes),
    `Backend file SHA256 or size differs: ${name}`);
  }
  assert(PRODUCT_BACKEND_MODULES.every(name => listed[name]),
    'Backend product API or index module is missing.');
  const artifactName = 'public/deployment-artifacts.json';
  const artifact = jsonFile(files, artifactName, 10 * 1024 * 1024);
  assert(files.get('dist/deployment-artifacts.json')?.equals(files.get(artifactName)),
    'Backend browser artifact differs from the packaged deployment artifact.');
  assert(same(artifact.sourceCommit, release.sourceCommit)
    && same(release.artifactSha256, sha256(files.get(artifactName)))
    && same(release.artifactDigest, servedArtifactDigest(join(backendDir, artifactName))),
  'Backend deployment artifact differs from its release provenance or digest.');
  const indexName = 'public/fresh-product-manifest.json';
  const index = jsonFile(files, indexName, 8192);
  assert(files.get(indexName).equals(freshIndexManifestBytes(index))
    && HEX_64.test(release.indexManifestSha256)
    && release.indexManifestSha256.toLowerCase() === sha256(files.get(indexName)),
  'Backend fresh index manifest is not canonical or SHA-pinned.');
  return { release, index,
    indexSha256: release.indexManifestSha256.toLowerCase(),
    releaseSha256: sha256(files.get(manifestName)), fileCount: actualNames.length + 1 };
}

export function verifyGitProvenance(files, expectedSourceHead, repositoryDir) {
  const repository = realpathSync(repositoryDir);
  const git = (...args) => execFileSync('git', args, { cwd: repository, maxBuffer: 20 * 1024 * 1024 });
  assert(same(git('rev-parse', 'HEAD').toString('utf8').trim(), expectedSourceHead),
    'Reviewed release source HEAD differs from the verifier checkout.');
  assert.equal(git('status', '--porcelain', '--untracked-files=all').toString('utf8').trim(), '',
    'The verifier checkout must be clean at the reviewed release commit.');
  for (const name of [...PRODUCT_BACKEND_MODULES, 'package.json', 'package-lock.json',
    'public/deployment-artifacts.json']) {
    const packaged = files.get(name);
    assert(packaged && packaged.equals(git('show', `${expectedSourceHead}:deploy/${name}`)),
      `Backend package differs from reviewed Git source: ${name}`);
  }
}

/** Read two actual release directories and emit a disabled, content-bound cutover draft. */
export function verifyFreshReleasePair({ frontendDir, backendDir, cutoverInput,
  expectedSourceCommit, expectedSourceHead, expectedFrontendContentSha256,
  expectedBackendReleaseSha256, verifyGit = true, repositoryDir = REPOSITORY }) {
  assert(COMMIT.test(expectedSourceCommit ?? '') && COMMIT.test(expectedSourceHead ?? ''),
    'Two reviewed 40-hex commits are required: genesis source and release source HEAD.');
  assert(HEX_64.test(expectedFrontendContentSha256 ?? '')
    && HEX_64.test(expectedBackendReleaseSha256 ?? ''),
  'Independent frontend content and backend release SHA256 pins are required.');
  assert(cutoverInput?.manifest, 'Reviewed fresh cutover input is required.');
  assert(same(cutoverInput.record?.sourceCommit, expectedSourceCommit),
    'Reviewed genesis source commit differs from the deployment record.');
  const frontend = checkFrontend(regularTree(frontendDir), expectedSourceCommit,
    expectedSourceHead, expectedFrontendContentSha256);
  const backendFiles = regularTree(backendDir);
  const backend = checkBackend(backendFiles, backendDir,
    expectedSourceHead, expectedBackendReleaseSha256);
  if (verifyGit) verifyGitProvenance(backendFiles, expectedSourceHead, repositoryDir);
  const draft = prepareFreshCutover(cutoverInput);
  assert(draft.activationAllowed === false, 'The fresh cutover draft must remain disabled.');
  assert(freshManifestDigest(cutoverInput.manifest) === frontend.release.manifestSha256,
    'Frontend static manifest differs from the reviewed cutover input.');
  const expectedIndex = createFreshIndexManifest(frontend.manifest);
  assert(backend.indexSha256 === freshIndexManifestSha256(expectedIndex)
    && backend.indexSha256 === draft.indexManifestSha256
    && freshIndexManifestBytes(backend.index).equals(freshIndexManifestBytes(expectedIndex)),
  'Frontend contract graph, backend index and cutover draft differ.');
  assert(same(frontend.checked.artifactDigest, backend.release.artifactDigest)
    && same(frontend.checked.factory, backend.index.factory)
    && same(frontend.checked.portfolioFactory, backend.index.portfolioFactory)
    && same(frontend.checked.authority, backend.index.authority)
    && same(frontend.checked.gasWallet, backend.index.gasWallet)
    && same(frontend.checked.gasWallet, cutoverInput.expectedGasWallet),
  'Fresh frontend and backend identities differ.');
  return Object.freeze({ ...draft, kind: 'fresh-v4-bound-cutover-draft', activationAllowed: false,
    releasePair: Object.freeze({ productFamily: 'fresh-v4', sourceCommit: expectedSourceCommit.toLowerCase(),
      backendArtifactSourceCommit: backend.release.sourceCommit.toLowerCase(),
      sourceHead: expectedSourceHead.toLowerCase(), frontendManifestSha256: frontend.release.manifestSha256,
      frontendContentSha256: frontend.contentSha256, frontendReleaseSha256: frontend.releaseSha256,
      frontendFileCount: frontend.fileCount, backendReleaseSha256: backend.releaseSha256,
      backendFileCount: backend.fileCount, indexManifestSha256: backend.indexSha256,
      artifactDigest: frontend.checked.artifactDigest, factory: frontend.checked.factory,
      portfolioFactory: frontend.checked.portfolioFactory, authority: frontend.checked.authority,
      gasWallet: frontend.checked.gasWallet }),
  });
}

function loadReviewedInput(path) {
  assert(isAbsolute(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),
    'Reviewed input must be a regular absolute JSON file.');
  const input = JSON.parse(readFileSync(path, 'utf8'));
  for (const key of ['record', 'bundle', 'activation', 'manifest']) {
    const child = input[`${key}Path`];
    assert(typeof child === 'string' && isAbsolute(child)
      && lstatSync(child).isFile() && !lstatSync(child).isSymbolicLink(),
    `Reviewed ${key} must be a regular absolute JSON file.`);
    input[key] = JSON.parse(readFileSync(child, 'utf8'));
  }
  return input;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), names = ['--frontend', '--backend', '--input',
      '--source-commit', '--source-head', '--frontend-content-sha256',
      '--backend-release-sha256', '--out'];
    assert(args.length === names.length * 2 && names.every(name =>
      args.filter(value => value === name).length === 1),
    'Usage: node verify-fresh-release-pair.mjs --frontend <absolute-dir> --backend <absolute-dir> --input <reviewed-input.json> --source-commit <genesis-commit> --source-head <release-commit> --frontend-content-sha256 <reviewed-sha256> --backend-release-sha256 <reviewed-sha256> --out <new-absolute-plan.json>');
    const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) =>
      [args[2 * i], args[2 * i + 1]]));
    const output = options['--out'];
    assert(isAbsolute(output) && realpathSync(dirname(output)) === resolve(dirname(output)),
      'Plan output needs a new absolute path with a canonical parent.');
    const plan = verifyFreshReleasePair({ frontendDir: options['--frontend'],
      backendDir: options['--backend'], cutoverInput: loadReviewedInput(options['--input']),
      expectedSourceCommit: options['--source-commit'], expectedSourceHead: options['--source-head'],
      expectedFrontendContentSha256: options['--frontend-content-sha256'],
      expectedBackendReleaseSha256: options['--backend-release-sha256'] });
    writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ plan: output, activationAllowed: false,
      releasePair: plan.releasePair }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
