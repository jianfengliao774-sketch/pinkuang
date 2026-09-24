import { readdirSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateUpgradeSafety } from '@openzeppelin/upgrades-core/dist/cli/validate/validate-upgrade-safety.js';
import prepareUpgradeBuildInfo from './prepare-upgrade-build-info.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sources = readdirSync(`${root}/contracts/src`, { recursive: true });
if (!sources.some(path => path.endsWith('.sol'))) {
  console.log('NOT APPLICABLE (T0.1): no business implementations or prior storage layout exist.');
  process.exit(0);
}
// Explicit targets prevent an empty discovery result from passing. This is the
// same validation engine used by openzeppelin-foundry-upgrades, with real references.
const buildInfo = prepareUpgradeBuildInfo(root);
const results = [];
async function validate(contract, reference, negative = false) {
  const report = await validateUpgradeSafety(buildInfo, contract, reference, { requireReference: Boolean(reference) });
  console.log(`\nValidation target: ${contract}${reference ? ` against ${reference}` : ' (initial implementation)'}`);
  console.log(report.explain(false));
  if (report.numTotal !== 1) throw new Error(`Expected exactly one report for ${contract}`);
  const detail = report.upgradeableContractReports[0];
  results.push({ contract, reference, negative, standaloneOk: detail.standaloneReport.ok,
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
await validate('src/PoolFactory.sol:PoolFactory');
await validate('src/PoolVault.sol:PoolVault');
await validate('test/unit/PoolGovernance.t.sol:PoolFactoryV2Fixture', 'src/PoolFactory.sol:PoolFactory');
await validate('test/unit/PoolGovernance.t.sol:PoolVaultV2Fixture', 'src/PoolVault.sol:PoolVault');
await validate('test/utils/InvalidVaultLayout.sol:InvalidVaultLayout', 'src/PoolVault.sol:PoolVault', true);
mkdirSync(`${root}/docs/logs/T1a`, { recursive: true });
copyFileSync(`${root}/contracts/out/upgrade-build-info-audit.json`, `${root}/docs/logs/T1a/upgrade-build-info-audit.json`);
writeFileSync(`${root}/docs/logs/T1a/upgrade-checks.json`, JSON.stringify(results, null, 2) + '\n');
console.log('Initial safety checks, both compatible upgrades, and incompatible-layout rejection completed.');
