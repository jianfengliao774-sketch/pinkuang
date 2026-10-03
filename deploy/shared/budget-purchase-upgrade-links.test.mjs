import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { buildDigest } from './firsto-upgrade-proof.mjs';
import { buildIntegratedUpgradePlan, integratedUpgradeDeploymentOrder } from './integrated-upgrade-plan.mjs';
import { buildFreshActiveUpgradePlan, freshUpgradeDeploymentData, freshUpgradeDeploymentOrder } from './fresh-active-upgrade-plan.mjs';

const json = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const genesisRecord = json('../public/upgrade-genesis/genesis-record.json');
const genesisBundle = json('../public/upgrade-genesis/genesis-artifacts.json');
const trustedGenesisManifest = json('../../web/public/data/frontend-manifest.json');
const candidate = json('../public/deployment-artifacts.json');
const source = name => `src/libraries/${name}.sol`;
const names = (artifact, field) => Object.values(artifact[field]).flatMap(refs => Object.keys(refs)).sort();
const implementations = order => Object.fromEntries(order.map((name, index) => [name,
  getAddress(`0x${(0x432100 + index).toString(16).padStart(40, '0')}`)]));
const salt = keccak256(toUtf8Bytes('reviewed budget purchase helper link graph'));

function buildBoth(upgradeBundle) {
  const input = { genesisRecord, genesisBundle, trustedGenesisManifest, upgradeBundle,
    trustedUpgradeArtifactDigest: buildDigest(upgradeBundle), salt, delaySeconds: 172800 };
  return [
    buildIntegratedUpgradePlan({ ...input, replacements: implementations(integratedUpgradeDeploymentOrder) }),
    buildFreshActiveUpgradePlan({ ...input, replacements: implementations(freshUpgradeDeploymentOrder) }),
  ];
}

// This isolated graph fixture exercises the historical policy without changing
// any pinned genesis/manifest bytes. Concrete slots replace removed placeholders.
function legacyGraph() {
  const legacy = structuredClone(candidate);
  legacy.artifacts.FlexiblePurchase.abi = legacy.artifacts.FlexiblePurchase.abi
    .filter(entry => !['unwrapBudgetFirsto', 'buyBudgetFirsto'].includes(entry.name));
  const vault = legacy.artifacts.BudgetPortfolioVault;
  for (const [code, field] of [['bytecode', 'linkReferences'], ['deployedBytecode', 'deployedLinkReferences']]) {
    for (const { start, length } of vault[field][source('FlexiblePurchase')].FlexiblePurchase) {
      vault[code] = vault[code].slice(0, 2 + start * 2) + '0'.repeat(length * 2)
        + vault[code].slice(2 + (start + length) * 2);
    }
    delete vault[field][source('FlexiblePurchase')];
  }
  return legacy;
}

test('legacy and envelope-capable BudgetVault candidates retain their exact reviewed dependency graphs', () => {
  const legacy = legacyGraph();
  for (const field of ['linkReferences', 'deployedLinkReferences']) {
    assert.deepEqual(names(legacy.artifacts.BudgetPortfolioVault, field), ['SaleGovernance']);
    assert.deepEqual(names(candidate.artifacts.BudgetPortfolioVault, field), ['FlexiblePurchase', 'SaleGovernance']);
  }
  assert.doesNotThrow(() => buildBoth(legacy));
  assert.doesNotThrow(() => buildBoth(candidate));
  const addresses = { ...genesisRecord.addresses, ...implementations(freshUpgradeDeploymentOrder) };
  const data = freshUpgradeDeploymentData('BudgetPortfolioVault', candidate, addresses);
  for (const { start, length } of candidate.artifacts.BudgetPortfolioVault.linkReferences[source('FlexiblePurchase')].FlexiblePurchase) {
    assert.equal(data.slice(2 + start * 2, 2 + (start + length) * 2), addresses.FlexiblePurchase.slice(2).toLowerCase());
    assert.notEqual(addresses.FlexiblePurchase.toLowerCase(), genesisRecord.addresses.FlexiblePurchase.toLowerCase());
  }
});

test('both planners reject missing, extra, and legacy-incompatible BudgetVault links in creation and runtime', () => {
  for (const field of ['linkReferences', 'deployedLinkReferences']) {
    const missing = structuredClone(candidate);
    delete missing.artifacts.BudgetPortfolioVault[field][source('FlexiblePurchase')];
    const extra = structuredClone(candidate);
    extra.artifacts.BudgetPortfolioVault[field][source('PurchaseValidation')] = {
      PurchaseValidation: structuredClone(extra.artifacts.BudgetPortfolioVault[field][source('SaleGovernance')].SaleGovernance),
    };
    const oldWithNewLink = legacyGraph();
    oldWithNewLink.artifacts.BudgetPortfolioVault[field][source('FlexiblePurchase')] =
      structuredClone(candidate.artifacts.BudgetPortfolioVault[field][source('FlexiblePurchase')]);
    for (const broken of [missing, extra, oldWithNewLink]) {
      const input = { genesisRecord, genesisBundle, trustedGenesisManifest, upgradeBundle: broken,
        trustedUpgradeArtifactDigest: buildDigest(broken), salt, delaySeconds: 172800 };
      assert.throws(() => buildIntegratedUpgradePlan({ ...input,
        replacements: implementations(integratedUpgradeDeploymentOrder) }), /Unexpected BudgetPortfolioVault/);
      assert.throws(() => buildFreshActiveUpgradePlan({ ...input,
        replacements: implementations(freshUpgradeDeploymentOrder) }), /Unexpected BudgetPortfolioVault/);
    }
  }
});
