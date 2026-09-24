import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate as validateCompilerOutput, solcInputOutputDecoder, getContractVersion,
  getStorageLayout, getStorageUpgradeReport } from '@openzeppelin/upgrades-core';
import { validateUpgradeSafety } from '@openzeppelin/upgrades-core/dist/cli/validate/validate-upgrade-safety.js';
import prepareUpgradeBuildInfo from './prepare-upgrade-build-info.mjs';
import auditLinkedLibraries from './audit-linked-libraries.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const task = process.env.VALIDATION_TASK ?? 'T1c';
if (!/^T\d+(?:[a-z]|\.\d+)?$/i.test(task)) throw new Error('Invalid VALIDATION_TASK');
const logRoot = resolve(process.env.VALIDATION_EVIDENCE_ROOT ?? join(root, 'docs/logs', task, 'contracts'));
mkdirSync(logRoot, { recursive: true });
const startedAt = new Date().toISOString();
const sources = readdirSync(`${root}/contracts/src`, { recursive: true });
if (!sources.some(path => path.endsWith('.sol'))) {
  console.log('NOT APPLICABLE (T0.1): no business implementations or prior storage layout exist.');
  process.exit(0);
}
// Explicit targets prevent an empty discovery result from passing. This is the
// same validation engine used by openzeppelin-foundry-upgrades, with real references.
const buildInfo = prepareUpgradeBuildInfo(root);
const results = [];
const sha256 = value => createHash('sha256').update(value).digest('hex');
async function validate(contract, reference, negative = false) {
  const report = await validateUpgradeSafety(buildInfo, contract, reference, { requireReference: Boolean(reference) });
  console.log(`\nValidation target: ${contract}${reference ? ` against ${reference}` : ' (initial implementation)'}`);
  console.log(report.explain(false));
  if (report.numTotal !== 1) throw new Error(`Expected exactly one report for ${contract}`);
  const detail = report.upgradeableContractReports[0];
  results.push({ kind: 'implementation-or-fixture', contract, reference, negative, standaloneOk: detail.standaloneReport.ok,
    storageLayoutOk: detail.storageLayoutReport?.ok, ok: report.ok });
  if (negative) {
    if (report.ok || !detail.standaloneReport.ok || detail.storageLayoutReport?.ok !== false) {
      throw new Error('The deliberately reordered ERC-7201 fixture was not rejected for storage incompatibility.');
    }
    console.log('PASS: deliberately incompatible namespace layout rejected.');
  } else if (!report.ok || (reference && detail.storageLayoutReport?.ok !== true)) {
    throw new Error(`Upgrade validation failed: ${contract}`);
  }
}

function requireNamespacedLayout(layout, name) {
  const namespace = `erc7201:tapeout.storage.${name}`;
  assert(layout && Array.isArray(layout.storage), `Missing ordinary storage layout: ${name}`);
  assert(layout.types && Object.keys(layout.types).length > 0, `Missing storage types: ${name}`);
  assert(layout.namespaces?.[namespace]?.length > 0, `Missing business namespace: ${name}`);
  for (const [key, fields] of Object.entries(layout.namespaces)) {
    assert(Array.isArray(fields) && fields.length > 0, `Empty namespace: ${key}`);
    for (const field of fields) {
      assert(typeof field.label === 'string' && field.label.length > 0, `Unlabelled field in ${key}`);
      assert(typeof field.type === 'string' && layout.types[field.type], `Missing field type in ${key}`);
    }
  }
  return layout.namespaces[namespace].length;
}

function validateDeliveredBaselines() {
  const compilations = readdirSync(buildInfo).filter(file => file.endsWith('.json')).map(file => {
    const info = JSON.parse(readFileSync(join(buildInfo, file), 'utf8'));
    return { info, data: validateCompilerOutput(info.output, solcInputOutputDecoder(info.input, info.output),
      info.solcVersion, info.input) };
  });
  for (const milestone of ['T1a', 'T1b']) for (const name of ['PoolFactory', 'PoolVault']) {
    const contract = `src/${name}.sol:${name}`;
    const baselinePath = `docs/storage/${milestone}-${name}.json`;
    const baselineBytes = readFileSync(join(root, baselinePath));
    const baseline = JSON.parse(baselineBytes.toString('utf8'));
    assert.equal(baseline.schemaVersion, 1, `Unsupported baseline schema: ${baselinePath}`);
    assert.equal(baseline.contract, contract, `Wrong baseline target: ${baselinePath}`);
    assert.equal(baseline.provenance.commit, milestone === 'T1a' ? '339c034e4bf4b504dcd4a7479d272a7f662497fc' : '6d090612c4b5ce0409b08b90a0573912aaee95f9', 'Unexpected delivered baseline commit');
    assert(/^[0-9a-f]{64}$/.test(baseline.provenance.sourceSha256), 'Missing baseline source provenance');
    const matches = compilations.filter(({ data }) => data[contract]);
    assert.equal(matches.length, 1, `Expected exactly one compiled layout for ${contract}; use a clean build`);
    const { info, data } = matches[0];
    const current = getStorageLayout(data, getContractVersion(data, contract));
    if (name === 'PoolVault') {
      assert(current.namespaces?.['erc7201:tapeout.storage.PoolRewards']?.length >= 10, 'Missing nonempty extracted reward namespace');
    }
    const previousFieldCount = requireNamespacedLayout(baseline.layout, name);
    const currentFieldCount = requireNamespacedLayout(current, name);
    const report = getStorageUpgradeReport(baseline.layout, current, {});
    results.push({ kind: `${milestone}-baseline`, contract, baselinePath, baselineCommit: baseline.provenance.commit,
      baselineFileSha256: sha256(baselineBytes), baselineSourceSha256: baseline.provenance.sourceSha256,
      currentSourceSha256: sha256(info.input.sources[`src/${name}.sol`].content),
      previousFieldCount, currentFieldCount, storageLayoutOk: report.ok, ok: report.ok });
    console.log(`\n${milestone} baseline -> current ${contract}: ${report.ok ? 'PASS' : 'FAIL'} (${previousFieldCount} -> ${currentFieldCount} business fields)`);
    if (!report.ok) {
      console.error(report.explain(false));
      throw new Error(`Storage is incompatible with the delivered ${milestone} baseline: ${contract}`);
    }
  }
}

let ok = false;
try {
  await validate('src/PoolFactory.sol:PoolFactory');
  await validate('src/PoolVault.sol:PoolVault');
  auditLinkedLibraries(root, logRoot);
  validateDeliveredBaselines();
  await validate('test/unit/PoolGovernance.t.sol:PoolFactoryV2Fixture', 'src/PoolFactory.sol:PoolFactory');
  await validate('test/unit/PoolGovernance.t.sol:PoolVaultV2Fixture', 'src/PoolVault.sol:PoolVault');
  await validate('test/utils/InvalidVaultLayout.sol:InvalidVaultLayout', 'src/PoolVault.sol:PoolVault', true);
  ok = true;
  console.log('Initial checks, delivered T1a/T1b baselines, both compatible fixtures, and incompatible-layout rejection completed.');
} finally {
  copyFileSync(join(root, 'contracts/out/upgrade-build-info-audit.json'), join(logRoot, 'upgrade-build-info-audit.json'));
  writeFileSync(join(logRoot, 'upgrade-checks.json'), JSON.stringify(results, null, 2) + '\n');
  writeFileSync(join(logRoot, 'upgrade-summary.json'), JSON.stringify({ task, startedAt,
    finishedAt: new Date().toISOString(), ok, checks: results.length }, null, 2) + '\n');
}
