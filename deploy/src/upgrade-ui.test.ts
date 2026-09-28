import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artifactDigest, type ArtifactBundle, type DeploymentSnapshot } from './deployment';
import { deploymentManifest } from './manifest';
import { assertTrustedGenesis, deploymentPlanReady } from './upgrade-ui';

const bundle = {schemaVersion:1,compilerVersion:'0.8.24',sourceCommit:'a'.repeat(40),settings:{},sourceHashes:{},artifacts:{}} as ArtifactBundle;
const names = ['factory','shareMarket','lens','beacon','timelock','portfolioFactory','portfolioShareMarket',
  'portfolioBeacon','portfolioVaultImplementation','portfolioFactoryImplementation'];
const addresses = Object.fromEntries(names.map((name,index) => [name,`0x${(index+1).toString(16).padStart(40,'0')}`]));
const portfolioChecks = ['PortfolioFactory.legacyFactory','PortfolioFactory.timelock','PortfolioFactory.beacon',
  'PortfolioFactory.shareMarket','PortfolioBeacon.owner','PortfolioBeacon.implementation','PortfolioBeacon.OFFICIAL_FACTORY',
  'PortfolioVault.OFFICIAL_FACTORY','PortfolioMarket.factory','PortfolioMarket.timelock','PortfolioMarket.feeBps',
  'PortfolioMarket.buyerFeeBps','PortfolioFactory UUPS 实现槽','PortfolioMarket UUPS 实现槽'];

function complete(): DeploymentSnapshot {
  const digest = artifactDigest(bundle);
  return {schemaVersion:1,kind:'integrated-v2',id:'test',chainId:56,account:addresses.factory,
    createdAt:'2026-09-29T00:00:00Z',updatedAt:'2026-09-29T00:00:00Z',artifactDigest:digest,sourceCommit:bundle.sourceCommit,
    input:{governanceMode:'single',ownerMultisig:addresses.factory,operator:addresses.factory,treasury:addresses.factory,
      maxGasBudgetBnb:'1',gasPriceCapGwei:'1',governanceReviewed:true,protocolReviewed:true},
    status:'complete',spentWei:'0',addresses,
    preflight:{chainId:56,account:addresses.factory,balanceWei:'0',gasPriceWei:'1',artifactDigest:digest,
      owner:{address:addresses.factory,codehash:`0x${'1'.repeat(64)}`,codeBytes:1},
      treasury:{address:addresses.factory,codehash:`0x${'1'.repeat(64)}`,codeBytes:1},
      protocols:{},libraryOrder:[],transactionCount:1,warnings:[],checkedAt:'2026-09-29T00:00:00Z'},
    steps:[{id:'initialize',label:'initialize',status:'confirmed',txHash:`0x${'a'.repeat(64)}`,
      receipt:{blockNumber:100,blockHash:`0x${'b'.repeat(64)}`,status:1,gasUsed:'1',gasPrice:'1',feeWei:'1'}}],
    verification:{checkedAt:'2026-09-29T00:00:00Z',blockNumber:101,
      checks:['Factory.lens','Lens.factory','Market.factory','Market.timelock','Beacon.owner',...portfolioChecks,
        ...names.map(name => `${name} 运行代码匹配`)].map(label => ({label,passed:true,actual:'true',expected:'true'})),
      code:Object.fromEntries(names.map(name => [name,{address:addresses[name],codehash:`0x${'c'.repeat(64)}`,codeBytes:20}]))},
  };
}

test('published manifest anchors the old transaction, address and runtime hash', () => {
  const record = complete();
  const published = deploymentManifest(record,bundle);
  assert.deepEqual(assertTrustedGenesis(record,bundle,published),published);
  assert.throws(() => assertTrustedGenesis({...record,sourceCommit:'f'.repeat(40)},bundle,published),/源码版本/);
  assert.throws(() => assertTrustedGenesis(record,bundle,{...published,codehash:{...published.codehash,portfolioBeacon:`0x${'d'.repeat(64)}`}}),/portfolioBeacon/);
  assert.throws(() => assertTrustedGenesis(record,bundle,{...published,deployment:{...published.deployment,blockNumber:99}}),/部署交易/);
});

test('a missing verification or an unknown submission locks signing', () => {
  const all = {trustedGenesis:true,trustedUpgradeBundle:true,chainVerified:true,walletOnBsc:true,
    proposer:true,unknownTransaction:false,operationDone:false};
  assert.equal(deploymentPlanReady(all),true);
  assert.equal(deploymentPlanReady({...all,chainVerified:false}),false);
  assert.equal(deploymentPlanReady({...all,unknownTransaction:true}),false);
});
