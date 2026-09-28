import {
  AbiCoder, Interface, ZeroHash, getAddress, keccak256,
} from 'ethers';
import { buildDigest, evidenceDigest } from './firsto-upgrade-proof.mjs';

export const INTEGRATED_SECURITY_UPGRADE_KIND = 'integrated-v2-security-upgrade-v1';
export const integratedUpgradeDeploymentOrder = Object.freeze([
  'PoolFunds', 'FlexiblePurchase', 'SaleSettlement', 'FirstoSale', 'SaleGovernance', 'PoolVault',
  'PoolFactory', 'ShareMarket', 'BudgetPortfolioVault', 'BudgetPortfolioFactory',
]);
const HASH = /^0x[\da-f]{64}$/i;
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const LENS_POLICY = 'legacy-readonly-ignore-governance-thresholds';
const MIN_DELAY = 172800;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const oldRuntimeNames = Object.freeze([
  'FlexiblePurchase', 'MiningOperations', 'PoolFunds', 'PurchaseValidation',
  'RewardAccounting', 'SaleGovernance', 'SaleSettlement', 'ShareCheckpoints',
  'FirstoSale', 'AtomicDeployment', 'PoolVault', 'PoolFactory', 'ShareMarket',
  'BudgetPortfolioFactory', 'BudgetPortfolioVault', 'factory', 'shareMarket',
  'lens', 'beacon', 'timelock', 'portfolioFactory', 'portfolioShareMarket', 'portfolioBeacon',
]);
const oldAlias = Object.freeze({
  factory: 'ERC1967Proxy', shareMarket: 'ERC1967Proxy', lens: 'PoolLens',
  beacon: 'PoolBeacon', timelock: 'PoolTimelock', portfolioFactory: 'ERC1967Proxy',
  portfolioShareMarket: 'ERC1967Proxy', portfolioBeacon: 'PoolBeacon',
});
const linkPolicy = Object.freeze({
  PoolFunds: [], FlexiblePurchase: ['PoolFunds', 'PurchaseValidation'],
  SaleSettlement: [], FirstoSale: ['SaleSettlement'], SaleGovernance: [],
  PoolVault: ['FirstoSale', 'FlexiblePurchase', 'MiningOperations', 'PoolFunds',
    'RewardAccounting', 'SaleGovernance', 'SaleSettlement', 'ShareCheckpoints'],
  PoolFactory: [], ShareMarket: [], BudgetPortfolioVault: [], BudgetPortfolioFactory: [],
});
const factoryAbi = new Interface(['function upgradeToAndCall(address,bytes)', 'function lens() view returns(address)',
  'function owner() view returns(address)', 'function timelock() view returns(address)',
  'function poolCount() view returns(uint256)', 'function allPools(uint256) view returns(address)',
  'function creationPaused() view returns(bool)',
  'function machineRegistryStatus() view returns(bool initialized,bool ready,uint256 cursor,uint256 cutoff)',
  'event Upgraded(address indexed implementation)']);
const portfolioFactoryAbi = new Interface(['function owner() view returns(address)',
  'function portfolioCount() view returns(uint256)', 'function portfolioAt(uint256) view returns(address)',
  'function creationPaused() view returns(bool)', 'function timelock() view returns(address)']);
const vaultAbi = new Interface(['function treasury() view returns(address)']);
const marketAbi = new Interface(['function upgradeToAndCall(address,bytes)',
  'event Upgraded(address indexed implementation)']);
const beaconAbi = new Interface(['function upgradeTo(address)', 'function implementation() view returns(address)',
  'function owner() view returns(address)', 'event Upgraded(address indexed implementation)']);
const lensAbi = new Interface(['function factory() view returns(address)']);
const timelockAbi = new Interface([
  'function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)',
  'function executeBatch(address[],uint256[],bytes[],bytes32,bytes32) payable',
  'function hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32) view returns(bytes32)',
  'function isOperation(bytes32) view returns(bool)',
  'function isOperationReady(bytes32) view returns(bool)',
  'function isOperationDone(bytes32) view returns(bool)',
  'function getTimestamp(bytes32) view returns(uint256)',
  'function getMinDelay() view returns(uint256)',
  'function hasRole(bytes32,address) view returns(bool)',
  'function PROPOSER_ROLE() view returns(bytes32)',
  'event CallScheduled(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data,bytes32 predecessor,uint256 delay)',
  'event CallExecuted(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data)',
]);
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
function requireThat(ok, reason) { if (!ok) throw new Error(reason); }
function address(value, label) {
  try { const result = getAddress(value); requireThat(result !== ZERO_ADDRESS, `${label} is zero.`); return result; }
  catch { throw new Error(`Invalid ${label} address.`); }
}
function exactKeys(value, expected, label) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...expected].sort().join(','), `Invalid ${label} keys.`);
}
function checkTrustedGenesis(genesisRecord, genesisBundle, manifest) {
  requireThat(genesisRecord?.schemaVersion === 1 && genesisRecord.kind === 'integrated-v2'
    && genesisRecord.chainId === 56 && genesisRecord.status === 'complete'
    && genesisRecord.steps?.length === 16 && genesisRecord.steps.every(step => step.status === 'confirmed'),
  'A completed integrated-v2 genesis record is required.');
  requireThat(same(buildDigest(genesisBundle),genesisRecord.artifactDigest)
    && HASH.test(genesisRecord.artifactDigest), 'Genesis artifact digest differs.');
  requireThat(manifest?.schemaVersion === 1 && manifest.kind === 'integrated-v2'
    && manifest.chainId === 56 && same(manifest.artifactDigest,genesisRecord.artifactDigest),
  'Genesis record differs from the independently trusted public manifest.');
  const mappings = {
    factory:'factory',shareMarket:'shareMarket',lens:'lens',beacon:'beacon',timelock:'timelock',
    portfolioFactory:'portfolioFactory',portfolioMarket:'portfolioShareMarket',
    portfolioBeacon:'portfolioBeacon',portfolioImplementation:'BudgetPortfolioVault',
    portfolioFactoryImplementation:'BudgetPortfolioFactory',
  };
  for (const [publicName,recordName] of Object.entries(mappings)) {
    requireThat(same(manifest[publicName],genesisRecord.addresses?.[recordName])
      && same(manifest.codehash?.[publicName],genesisRecord.verification?.code?.[recordName]?.codehash),
    `Genesis ${publicName} differs from the trusted manifest.`);
  }
  const initial = genesisRecord.steps.find(step => step.id === 'initialize');
  requireThat(same(initial?.txHash,manifest.deployment?.txHash)
    && initial?.receipt?.blockNumber === manifest.deployment?.blockNumber
    && same(initial?.receipt?.blockHash,manifest.deployment?.blockHash)
    && initial?.receipt?.status === 1, 'Genesis initialization transaction differs.');
  const old = genesisRecord.addresses;
  requireThat(oldRuntimeNames.every(name => old?.[name] && genesisRecord.verification?.code?.[name]
    && same(old[name],genesisRecord.verification.code[name].address)
    && HASH.test(genesisRecord.verification.code[name].codehash)), 'Genesis graph evidence is incomplete.');
  for (const name of oldRuntimeNames) {
    requireThat(same(keccak256(genesisRuntime(name,genesisRecord,genesisBundle)),
      genesisRecord.verification.code[name].codehash),
    `Genesis ${name} runtime is not derived from the trusted old artifact bundle.`);
  }
  return old;
}
function linksFor(artifact, property) {
  const result = [];
  for (const [source, references] of Object.entries(artifact?.[property] ?? {})) {
    for (const [name, locations] of Object.entries(references)) {
      requireThat(source === `src/libraries/${name}.sol` && Array.isArray(locations) && locations.length > 0,
        `Unexpected ${artifact.contractName} library source.`);
      result.push(name);
    }
  }
  return [...new Set(result)].sort();
}
function assertArtifacts(upgradeBundle) {
  for (const name of integratedUpgradeDeploymentOrder) {
    const artifact = upgradeBundle?.artifacts?.[name];
    requireThat(artifact?.contractName === name && artifact.bytecode?.startsWith('0x')
      && artifact.deployedBytecode?.startsWith('0x'), `Missing reviewed artifact: ${name}.`);
    for (const field of ['linkReferences', 'deployedLinkReferences']) {
      requireThat(linksFor(artifact,field).join(',') === [...linkPolicy[name]].sort().join(','),
        `Unexpected ${name} ${field} graph.`);
    }
    const fakeLinks = Object.fromEntries(linkPolicy[name].map(dep => [dep,`0x${'1'.repeat(40)}`]));
    spliceLinks(artifact.bytecode,artifact.linkReferences,fakeLinks);
    spliceLinks(artifact.deployedBytecode,artifact.deployedLinkReferences,fakeLinks);
    requireThat((artifact.deployedBytecode.length - 2) / 2 <= 24576, `${name} exceeds EIP-170 size.`);
  }
}
function checkInputs({genesisRecord,genesisBundle,trustedGenesisManifest,upgradeBundle,trustedUpgradeArtifactDigest,replacements,salt,delaySeconds}) {
  const old = checkTrustedGenesis(genesisRecord,genesisBundle,trustedGenesisManifest);
  requireThat(HASH.test(trustedUpgradeArtifactDigest) && same(buildDigest(upgradeBundle),trustedUpgradeArtifactDigest),
    'Upgrade bundle differs from the independently trusted build digest.');
  assertArtifacts(upgradeBundle);
  exactKeys(replacements,integratedUpgradeDeploymentOrder,'replacement');
  const used = new Set(Object.values(old).filter(value => typeof value === 'string').map(value => value.toLowerCase()));
  const normalized = {};
  for (const name of integratedUpgradeDeploymentOrder) {
    normalized[name] = address(replacements[name],name);
    requireThat(!used.has(normalized[name].toLowerCase()), `Replacement ${name} reuses another graph address.`);
    used.add(normalized[name].toLowerCase());
  }
  requireThat(HASH.test(salt) && BigInt(salt) !== 0n, 'A unique nonzero bytes32 salt is required.');
  requireThat(Number.isSafeInteger(delaySeconds) && delaySeconds >= MIN_DELAY,
    'Timelock delay must be at least 48 hours.');
  return { old, normalized };
}
function spliceLinks(code, references, addresses) {
  let hex = code.slice(2);
  for (const [source, libraries] of Object.entries(references ?? {})) for (const [name, locations] of Object.entries(libraries)) {
    requireThat(source === `src/libraries/${name}.sol`, `Unexpected library source for ${name}.`);
    const linked = address(addresses[name],name).slice(2).toLowerCase();
    for (const {start,length} of locations) {
      requireThat(Number.isSafeInteger(start) && start >= 0 && length === 20
        && (start+length)*2 <= hex.length, `Invalid ${name} link location.`);
      hex = hex.slice(0,start*2) + linked + hex.slice((start+length)*2);
    }
  }
  requireThat(/^[\da-f]+$/i.test(hex) && hex.length % 2 === 0, 'Unresolved library link.');
  return `0x${hex}`;
}

/** Linked constructor calldata, suitable for wallet deployment after a pinned graph preflight. */
export function integratedUpgradeDeploymentData(name, upgradeBundle, addresses) {
  requireThat(integratedUpgradeDeploymentOrder.includes(name), 'Unknown upgrade deployment.');
  const artifact = upgradeBundle?.artifacts?.[name];
  requireThat(artifact?.contractName === name, `Missing ${name} artifact.`);
  const constructorArgs = name === 'PoolVault' ? [address(addresses.factory,'factory')]
    : name === 'BudgetPortfolioVault' ? [address(addresses.portfolioFactory,'portfolioFactory')] : [];
  return spliceLinks(artifact.bytecode,artifact.linkReferences,addresses)
    + new Interface(artifact.abi).encodeDeploy(constructorArgs).slice(2);
}

/** Fixed six-call Timelock batch. No wallet, signer or RPC appears in this function. */
export function buildIntegratedUpgradePlan(input) {
  const {genesisRecord,genesisBundle,upgradeBundle,replacements,salt,delaySeconds} = input;
  const {old,normalized} = checkInputs(input);
  const targets = [old.shareMarket,old.portfolioShareMarket,old.factory,old.beacon,old.portfolioFactory,old.portfolioBeacon]
    .map((value,index) => address(value,`batch target ${index}`));
  const implementations = [normalized.ShareMarket,normalized.ShareMarket,normalized.PoolFactory,
    normalized.PoolVault,normalized.BudgetPortfolioFactory,normalized.BudgetPortfolioVault];
  const names = ['Legacy ShareMarket','Portfolio ShareMarket','PoolFactory','Pool Beacon',
    'BudgetPortfolioFactory','Portfolio Beacon'];
  const payloads = [marketAbi,marketAbi,factoryAbi,beaconAbi,factoryAbi,beaconAbi]
    .map((abi,index) => index === 3 || index === 5
      ? abi.encodeFunctionData('upgradeTo',[implementations[index]])
      : abi.encodeFunctionData('upgradeToAndCall',[implementations[index],'0x']));
  const values = targets.map(() => '0');
  const encodedArgs = [targets,values.map(BigInt),payloads,ZeroHash,salt];
  const operationId = keccak256(AbiCoder.defaultAbiCoder().encode(
    ['address[]','uint256[]','bytes[]','bytes32','bytes32'],encodedArgs));
  return {
    kind:INTEGRATED_SECURITY_UPGRADE_KIND,
    genesisRecordDigest:evidenceDigest(genesisRecord),
    genesisArtifactDigest:buildDigest(genesisBundle),
    upgradeArtifactDigest:buildDigest(upgradeBundle),
    replacements:normalized,
    lensPolicy:LENS_POLICY,
    lensAddress:address(old.lens,'legacy lens'),
    lensCodehash:genesisRecord.verification.code.lens.codehash,
    predecessor:ZeroHash,salt,delaySeconds,
    steps:targets.map((target,index) => ({name:names[index],target,
      implementation:implementations[index],data:payloads[index],value:'0'})),
    targets,values,payloads,operationId,
    scheduleData:timelockAbi.encodeFunctionData('scheduleBatch',[...encodedArgs,delaySeconds]),
    executeData:timelockAbi.encodeFunctionData('executeBatch',encodedArgs),
  };
}

function expectedRuntime(artifact, addresses, ownAddress, immutableAddress) {
  let hex = spliceLinks(artifact.deployedBytecode,artifact.deployedLinkReferences,addresses).slice(2).toLowerCase();
  // Solidity external libraries use a self-address prefix in their runtime.
  if (['PoolFunds','FlexiblePurchase','FirstoSale','SaleGovernance','SaleSettlement',
    'MiningOperations','PurchaseValidation','RewardAccounting','ShareCheckpoints'].includes(artifact.contractName)
    && hex.startsWith(`73${'0'.repeat(40)}`)) hex = `73${ownAddress.slice(2).toLowerCase()}${hex.slice(42)}`;
  const locations = Object.values(artifact.immutableReferences ?? {}).flat();
  if (locations.length) requireThat(immutableAddress, `${artifact.contractName} immutable binding is unspecified.`);
  for (const {start,length} of locations) {
    requireThat(Number.isSafeInteger(start) && start >= 0 && length === 32
      && (start+length)*2 <= hex.length, `Unexpected ${artifact.contractName} immutable reference.`);
    hex = hex.slice(0,start*2) + immutableAddress.slice(2).toLowerCase().padStart(64,'0')
      + hex.slice((start+length)*2);
  }
  return `0x${hex}`;
}
function genesisRuntime(name,record,bundle) {
  const old = record.addresses, artifact = bundle?.artifacts?.[oldAlias[name] ?? name];
  requireThat(artifact && artifact.deployedBytecode,`Missing trusted genesis artifact: ${name}.`);
  const immutable = ({AtomicDeployment:record.account,PoolVault:old.factory,
    BudgetPortfolioVault:old.portfolioFactory,PoolFactory:old.PoolFactory,
    ShareMarket:old.ShareMarket,BudgetPortfolioFactory:old.BudgetPortfolioFactory,
    lens:old.factory,beacon:old.factory,portfolioBeacon:old.portfolioFactory,
  })[name] ?? null;
  return expectedRuntime(artifact,old,old[name],immutable && address(immutable,`${name} immutable`));
}
function slotAddress(raw) {
  requireThat(/^0x0{24}[\da-f]{40}$/i.test(raw), 'Invalid implementation slot encoding.');
  return getAddress(`0x${raw.slice(-40)}`);
}
async function call(provider,to,iface,method,args,tag) {
  const result = await provider.send('eth_call',[{to,data:iface.encodeFunctionData(method,args)},tag]);
  return iface.decodeFunctionResult(method,result)[0];
}
async function historicalTreasuries(provider,old,poolCount,portfolioCount,tag) {
  const count = Number(poolCount), portfolios = Number(portfolioCount);
  requireThat(Number.isSafeInteger(count) && Number.isSafeInteger(portfolios)
    && count + portfolios <= 10000, 'Historical vault set exceeds the bounded full-graph preflight.');
  const list = [];
  for (const [kind,total,factory,abi,method] of [
    ['pool',count,old.factory,factoryAbi,'allPools'],
    ['portfolio',portfolios,old.portfolioFactory,portfolioFactoryAbi,'portfolioAt'],
  ]) for (let index = 0;index < total;index++) {
    const vault = address(await call(provider,factory,abi,method,[index],tag),`${kind} ${index}`);
    const treasury = address(await call(provider,vault,vaultAbi,'treasury',[],tag),`${kind} treasury ${index}`);
    list.push({kind,index,address:vault,treasury});
  }
  requireThat(new Set(list.map(item => item.address.toLowerCase())).size === list.length,
    'Historical vault registry contains a duplicate.');
  return list;
}

async function genesisAt(provider,{genesisRecord,genesisBundle,trustedGenesisManifest},block) {
  const old = checkTrustedGenesis(genesisRecord,genesisBundle,trustedGenesisManifest);
  const tag = `0x${block.number.toString(16)}`, checks = [];
  const checked = (condition,label) => { requireThat(condition,label); checks.push({label,passed:true}); };
  const deployed = await provider.getBlock(trustedGenesisManifest.deployment.blockNumber);
  checked(same(deployed?.hash,trustedGenesisManifest.deployment.blockHash)
    && deployed?.number === trustedGenesisManifest.deployment.blockNumber,
  'Genesis initialization block is no longer canonical.');
  for (const name of oldRuntimeNames) {
    const observed = await provider.getCode(old[name],block.number);
    checked(observed !== '0x' && same(observed,genesisRuntime(name,genesisRecord,genesisBundle)),
      `Genesis runtime changed: ${name}.`);
  }
  for (const [proxy,implementation] of [
    ['factory','PoolFactory'],['shareMarket','ShareMarket'],['portfolioFactory','BudgetPortfolioFactory'],
    ['portfolioShareMarket','ShareMarket'],
  ]) {
    const slot = await provider.getStorage(old[proxy],IMPLEMENTATION_SLOT,block.number);
    checked(same(slotAddress(slot),old[implementation]),`Current ${proxy} implementation differs from genesis.`);
  }
  for (const [beacon,implementation] of [['beacon','PoolVault'],['portfolioBeacon','BudgetPortfolioVault']]) {
    const [owner,current] = await Promise.all([
      call(provider,old[beacon],beaconAbi,'owner',[],tag),
      call(provider,old[beacon],beaconAbi,'implementation',[],tag),
    ]);
    checked(same(owner,old.timelock) && same(current,old[implementation]),`${beacon} owner or implementation changed.`);
  }
  checked(same(await call(provider,old.factory,factoryAbi,'lens',[],tag),old.lens),
    'Factory Lens binding changed.');
  checked(same(await call(provider,old.lens,lensAbi,'factory',[],tag),old.factory),
    'Legacy Lens factory binding changed.');
  const [factoryOwner,portfolioOwner,factoryTimelock,portfolioTimelock,minDelay,registry,poolCount,portfolioCount,
    corePaused,budgetPaused] = await Promise.all([
    call(provider,old.factory,factoryAbi,'owner',[],tag),
    call(provider,old.portfolioFactory,portfolioFactoryAbi,'owner',[],tag),
    call(provider,old.factory,factoryAbi,'timelock',[],tag),
    call(provider,old.portfolioFactory,portfolioFactoryAbi,'timelock',[],tag),
    call(provider,old.timelock,timelockAbi,'getMinDelay',[],tag),
    provider.send('eth_call',[{to:old.factory,data:factoryAbi.encodeFunctionData('machineRegistryStatus')},tag]),
    call(provider,old.factory,factoryAbi,'poolCount',[],tag),
    call(provider,old.portfolioFactory,portfolioFactoryAbi,'portfolioCount',[],tag),
    call(provider,old.factory,factoryAbi,'creationPaused',[],tag),
    call(provider,old.portfolioFactory,portfolioFactoryAbi,'creationPaused',[],tag),
  ]);
  const [initialized,ready,cursor,cutoff] = factoryAbi.decodeFunctionResult('machineRegistryStatus',registry);
  checked(same(factoryOwner,genesisRecord.input.ownerMultisig)
    && same(portfolioOwner,genesisRecord.input.ownerMultisig)
    && same(factoryTimelock,old.timelock) && same(portfolioTimelock,old.timelock),
  'Genesis owner or Timelock binding changed.');
  checked(minDelay >= BigInt(MIN_DELAY),'Timelock minimum delay is below 48 hours.');
  checked(initialized === true && ready === true && cursor === cutoff,
    'Machine registry is not ready for an integrated upgrade.');
  checked(corePaused === true && budgetPaused === true,
    'Both factories must be paused by the current owner before the upgrade preflight.');
  const historical = await historicalTreasuries(provider,old,poolCount,portfolioCount,tag);
  checks.push({label:`All ${historical.length} historical vault addresses and fee recipients pinned`,passed:true});
  return {checks,registry:{initialized,ready,cursor:cursor.toString(),cutoff:cutoff.toString()},
    poolCount:poolCount.toString(),portfolioCount:portfolioCount.toString(),historical};
}

/** Checks the trusted old graph before the first deployment consumes Gas. */
export async function validateIntegratedUpgradeGenesisAgainstChain(provider,input) {
  const [chain,block] = await Promise.all([provider.send('eth_chainId',[]),provider.getBlock('finalized')]);
  requireThat(BigInt(chain) === 56n && Number.isSafeInteger(block?.number) && HASH.test(block?.hash),
    'A finalized BSC block is required.');
  const result = await genesisAt(provider,input,block);
  const [again,againChain] = await Promise.all([provider.getBlock(block.number),provider.send('eth_chainId',[])]);
  requireThat(again?.number === block.number && same(again.hash,block.hash) && BigInt(againChain) === 56n,
    'Finalized block changed during genesis preflight.');
  return {checkedAt:new Date().toISOString(),blockNumber:block.number,blockHash:block.hash,
    ...result,checks:[{label:'Finalized BSC chain',passed:true},...result.checks]};
}

/** Proves the exact deployed dependency prefix before linking the next library. */
export async function validateIntegratedUpgradePartialReplacementsAgainstChain(provider,input) {
  const {genesisRecord,genesisBundle,trustedGenesisManifest,upgradeBundle,
    trustedUpgradeArtifactDigest,deployments} = input;
  const old = checkTrustedGenesis(genesisRecord,genesisBundle,trustedGenesisManifest);
  requireThat(HASH.test(trustedUpgradeArtifactDigest)
    && same(buildDigest(upgradeBundle),trustedUpgradeArtifactDigest),
  'Upgrade bundle differs from the independently trusted build digest.');
  assertArtifacts(upgradeBundle);
  requireThat(deployments && typeof deployments === 'object' && !Array.isArray(deployments),
    'A deployment prefix is required.');
  const names = integratedUpgradeDeploymentOrder.slice(0,Object.keys(deployments).length);
  exactKeys(deployments,names,'deployment prefix');
  const [chain,block] = await Promise.all([provider.send('eth_chainId',[]),provider.getBlock('finalized')]);
  requireThat(BigInt(chain) === 56n && Number.isSafeInteger(block?.number) && HASH.test(block?.hash),
    'A finalized BSC block is required.');
  const genesis = await genesisAt(provider,{genesisRecord,genesisBundle,trustedGenesisManifest},block);
  const used = new Set(Object.values(old).filter(value => typeof value === 'string')
    .map(value => value.toLowerCase()));
  const replacements = {},checks = [...genesis.checks];
  for (const name of names) {
    const deployed = address(deployments[name],name);
    requireThat(!used.has(deployed.toLowerCase()),`${name} reuses a deployed graph address.`);
    used.add(deployed.toLowerCase());
    replacements[name] = deployed;
    const observed = await provider.getCode(deployed,block.number);
    requireThat(observed !== '0x' && same(observed,expectedRuntime(upgradeBundle.artifacts[name],
      {...old,...replacements},deployed,
      name === 'PoolVault' ? old.factory : name === 'BudgetPortfolioVault' ? old.portfolioFactory : null)),
    `Replacement runtime differs: ${name}.`);
    checks.push({label:`Replacement runtime matches reviewed artifact: ${name}`,passed:true});
  }
  const again = await provider.getBlock(block.number);
  requireThat(same(again?.hash,block.hash),'Finalized block changed during deployment-prefix proof.');
  return {checkedAt:new Date().toISOString(),blockNumber:block.number,blockHash:block.hash,
    replacements,checks,registry:genesis.registry,poolCount:genesis.poolCount,
    portfolioCount:genesis.portfolioCount,historical:genesis.historical};
}

/** Read-only preflight at one finalized block; throws closed on any mismatch. */
async function validatePlanAtChain(provider,plan,input,phase) {
  const {genesisRecord,genesisBundle,trustedGenesisManifest,upgradeBundle,trustedUpgradeArtifactDigest,proposer} = input;
  const regenerated = buildIntegratedUpgradePlan({genesisRecord,genesisBundle,upgradeBundle,
    trustedGenesisManifest,trustedUpgradeArtifactDigest,replacements:plan?.replacements,salt:plan?.salt,delaySeconds:plan?.delaySeconds});
  requireThat(same(evidenceDigest(plan),evidenceDigest(regenerated)), 'Upgrade plan differs from fixed reviewed calldata.');
  const signer = address(proposer,'proposer');
  const [chain,block] = await Promise.all([provider.send('eth_chainId',[]),provider.getBlock('finalized')]);
  requireThat(BigInt(chain) === 56n && Number.isSafeInteger(block?.number) && HASH.test(block?.hash),
    'A finalized BSC block is required.');
  const tag = `0x${block.number.toString(16)}`, old = genesisRecord.addresses;
  const addresses = {...old,...plan.replacements};
  const checks = [];
  const checked = (condition,label) => { requireThat(condition,label); checks.push({label,passed:true}); };
  checked(true,'Finalized BSC chain');
  // This includes the immutable legacy Lens, never relabelled as the rebuilt Lens.
  const genesis = await genesisAt(provider,{genesisRecord,genesisBundle,trustedGenesisManifest},block);
  checks.push(...genesis.checks);
  const replacementCodehash = {};
  for (const name of integratedUpgradeDeploymentOrder) {
    const observed = await provider.getCode(plan.replacements[name],block.number);
    const expected = expectedRuntime(upgradeBundle.artifacts[name],addresses,plan.replacements[name],
      name === 'PoolVault' ? old.factory : name === 'BudgetPortfolioVault' ? old.portfolioFactory : null);
    checked(observed !== '0x' && same(observed,expected), `Replacement runtime differs: ${name}.`);
    replacementCodehash[name] = keccak256(observed);
  }
  const [minDelay,proposerRole,chainOperationId,isOperation,isReady,isDone,readyAt] = await Promise.all([
    call(provider,old.timelock,timelockAbi,'getMinDelay',[],tag),
    call(provider,old.timelock,timelockAbi,'PROPOSER_ROLE',[],tag),
    call(provider,old.timelock,timelockAbi,'hashOperationBatch',[
      plan.targets,plan.values.map(BigInt),plan.payloads,plan.predecessor,plan.salt],tag),
    call(provider,old.timelock,timelockAbi,'isOperation',[plan.operationId],tag),
    call(provider,old.timelock,timelockAbi,'isOperationReady',[plan.operationId],tag),
    call(provider,old.timelock,timelockAbi,'isOperationDone',[plan.operationId],tag),
    call(provider,old.timelock,timelockAbi,'getTimestamp',[plan.operationId],tag),
  ]);
  checked(minDelay >= BigInt(MIN_DELAY) && BigInt(plan.delaySeconds) >= minDelay,
    'Timelock delay changed or planned delay is insufficient.');
  checked(same(chainOperationId,plan.operationId), 'Timelock operation id changed.');
  if (phase === 'unscheduled') {
    checked(isOperation === false && isReady === false && isDone === false && readyAt === 0n,
      'Timelock salt is already scheduled.');
  } else {
    checked(isOperation === true && isReady === true && isDone === false
      && readyAt !== 0n && readyAt <= BigInt(block.timestamp),
    'Timelock operation is not scheduled and ready for execution.');
  }
  checked(await call(provider,old.timelock,timelockAbi,'hasRole',[proposerRole,signer],tag) === true,
    'Connected wallet is not a Timelock proposer.');
  const [again,againChain] = await Promise.all([provider.getBlock(block.number),provider.send('eth_chainId',[])]);
  checked(again?.number === block.number && same(again.hash,block.hash) && BigInt(againChain) === 56n,
    'Finalized block changed during preflight.');
  return {phase,operationId:plan.operationId,readyAt:readyAt.toString(),checkedAt:new Date().toISOString(),
    blockNumber:block.number,blockHash:block.hash,checks,
    replacementCodehash,registry:genesis.registry,poolCount:genesis.poolCount,
    portfolioCount:genesis.portfolioCount,historical:genesis.historical};
}
export async function validateIntegratedUpgradePlanAgainstChain(provider,plan,input) {
  return validatePlanAtChain(provider,plan,input,'unscheduled');
}
/** Called immediately before the hardware wallet signs executeBatch. */
export async function validateIntegratedUpgradeScheduledAgainstChain(provider,plan,input) {
  return validatePlanAtChain(provider,plan,input,'scheduled');
}

async function finalizedTransaction(provider,hash,finalized) {
  requireThat(HASH.test(hash), 'Missing transaction hash.');
  const [tx,receipt] = await Promise.all([provider.getTransaction(hash),provider.getTransactionReceipt(hash)]);
  requireThat(tx && receipt && same(tx.hash,hash) && same(receipt.hash ?? receipt.transactionHash,hash)
    && receipt.status === 1 && receipt.blockNumber <= finalized.number
    && tx.blockNumber === receipt.blockNumber && same(tx.blockHash,receipt.blockHash),
  'Upgrade transaction is not a successful finalized inclusion.');
  const block = await provider.getBlock(receipt.blockNumber);
  requireThat(block?.number === receipt.blockNumber && same(block.hash,receipt.blockHash)
    && Number.isSafeInteger(receipt.index) && receipt.index >= 0
    && tx.index === receipt.index && same(block.transactions?.[receipt.index],hash),
  'Upgrade transaction index is not canonical.');
  return {tx,receipt,block};
}
function logsOf(proof,addressToMatch,iface,name) {
  return (proof.receipt.logs ?? []).filter(log => !log.removed && same(log.address,addressToMatch)
    && same(log.transactionHash,proof.tx.hash) && same(log.blockHash,proof.receipt.blockHash)).flatMap(log => {
    try { const parsed = iface.parseLog(log); return parsed?.name === name ? [parsed] : []; }
    catch { return []; }
  });
}

/** Exact Timelock event and post-state proof. A completed batch is not role migration. */
export async function validateIntegratedUpgradeResultAgainstChain(provider,plan,input) {
  const {genesisRecord,genesisBundle,trustedGenesisManifest,upgradeBundle,trustedUpgradeArtifactDigest,
    preExecutionPreflight,scheduleTxHash,executeTxHash} = input;
  const regenerated = buildIntegratedUpgradePlan({genesisRecord,genesisBundle,trustedGenesisManifest,
    upgradeBundle,trustedUpgradeArtifactDigest,replacements:plan?.replacements,
    salt:plan?.salt,delaySeconds:plan?.delaySeconds});
  requireThat(same(evidenceDigest(plan),evidenceDigest(regenerated)), 'Upgrade plan differs from fixed reviewed calldata.');
  requireThat(HASH.test(scheduleTxHash) && HASH.test(executeTxHash) && !same(scheduleTxHash,executeTxHash),
    'Distinct schedule and execute hashes are required.');
  requireThat(preExecutionPreflight?.phase === 'scheduled'
    && preExecutionPreflight?.operationId === plan.operationId
    && HASH.test(preExecutionPreflight.blockHash) && Number.isSafeInteger(preExecutionPreflight.blockNumber)
    && /^\d+$/.test(preExecutionPreflight.poolCount ?? '')
    && /^\d+$/.test(preExecutionPreflight.portfolioCount ?? '')
    && preExecutionPreflight.registry?.ready === true
    && Array.isArray(preExecutionPreflight.historical),
  'A pinned pre-execution graph snapshot is required.');
  const [chain,finalized,previous] = await Promise.all([
    provider.send('eth_chainId',[]),provider.getBlock('finalized'),
    provider.getBlock(preExecutionPreflight.blockNumber),
  ]);
  requireThat(BigInt(chain) === 56n && Number.isSafeInteger(finalized?.number) && HASH.test(finalized?.hash)
    && same(previous?.hash,preExecutionPreflight.blockHash), 'BSC finality or pre-execution anchor changed.');
  const [scheduled,executed] = await Promise.all([
    finalizedTransaction(provider,scheduleTxHash,finalized),
    finalizedTransaction(provider,executeTxHash,finalized),
  ]);
  requireThat(executed.receipt.blockNumber > scheduled.receipt.blockNumber
    && executed.receipt.blockNumber > preExecutionPreflight.blockNumber
    && scheduled.receipt.blockNumber <= preExecutionPreflight.blockNumber
    && BigInt(executed.block.timestamp) >= BigInt(scheduled.block.timestamp) + BigInt(plan.delaySeconds),
  'Timelock delay or pre-execution ordering differs.');
  // EIP-7702 / hardware-wallet wrappers may put a different outer target in
  // tx.to. Timelock emitted events are the authoritative inner-call evidence.
  for (const [proof,event] of [[scheduled,'CallScheduled'],[executed,'CallExecuted']]) {
    const events = logsOf(proof,genesisRecord.addresses.timelock,timelockAbi,event);
    requireThat(events.length === plan.steps.length, `Wrong ${event} count.`);
    for (let index = 0;index < events.length;index++) {
      const args = events[index].args;
      requireThat(same(args.id,plan.operationId) && args.index === BigInt(index)
        && same(args.target,plan.targets[index]) && args.value === 0n
        && same(args.data,plan.payloads[index])
        && (event !== 'CallScheduled' || args.predecessor === ZeroHash && args.delay === BigInt(plan.delaySeconds)),
      `${event} ${index} differs from reviewed plan.`);
    }
  }
  for (const [index,iface] of [marketAbi,marketAbi,factoryAbi,beaconAbi,factoryAbi,beaconAbi].entries()) {
    const events = logsOf(executed,plan.targets[index],iface,'Upgraded');
    requireThat(events.length === 1 && same(events[0].args.implementation,plan.steps[index].implementation),
      `Missing exact Upgraded event for ${plan.steps[index].name}.`);
  }
  const old = genesisRecord.addresses, tag = `0x${finalized.number.toString(16)}`;
  const addresses = {...old,...plan.replacements}, checks = [];
  const checked = (condition,label) => { requireThat(condition,label); checks.push({label,passed:true}); };
  const historicalAnchor = await genesisAt(provider,{genesisRecord,genesisBundle,trustedGenesisManifest},previous);
  checked(historicalAnchor.poolCount === preExecutionPreflight.poolCount
    && historicalAnchor.portfolioCount === preExecutionPreflight.portfolioCount
    && evidenceDigest(historicalAnchor.historical) === evidenceDigest(preExecutionPreflight.historical)
    && evidenceDigest(historicalAnchor.registry) === evidenceDigest(preExecutionPreflight.registry),
  'Persisted pre-execution snapshot differs from its canonical historical block.');
  checked(await call(provider,old.timelock,timelockAbi,'isOperation',[plan.operationId],tag) === true,
    'Timelock operation disappeared.');
  const doneAbi = new Interface(['function isOperationDone(bytes32) view returns(bool)']);
  checked(await call(provider,old.timelock,doneAbi,'isOperationDone',[plan.operationId],tag) === true,
    'Timelock operation is not done.');
  for (const [proxy,implementation] of [
    ['factory','PoolFactory'],['shareMarket','ShareMarket'],['portfolioFactory','BudgetPortfolioFactory'],
    ['portfolioShareMarket','ShareMarket'],
  ]) {
    const slot = await provider.getStorage(old[proxy],IMPLEMENTATION_SLOT,finalized.number);
    checked(same(slotAddress(slot),plan.replacements[implementation]),
      `Upgraded ${proxy} implementation slot differs.`);
  }
  for (const [beacon,implementation] of [['beacon','PoolVault'],['portfolioBeacon','BudgetPortfolioVault']]) {
    const current = await call(provider,old[beacon],beaconAbi,'implementation',[],tag);
    checked(same(current,plan.replacements[implementation]),`${beacon} implementation differs.`);
  }
  for (const name of integratedUpgradeDeploymentOrder) {
    const code = await provider.getCode(plan.replacements[name],finalized.number);
    checked(code !== '0x' && same(code,expectedRuntime(upgradeBundle.artifacts[name],addresses,
      plan.replacements[name],name === 'PoolVault' ? old.factory
        : name === 'BudgetPortfolioVault' ? old.portfolioFactory : null)),
    `Replacement runtime changed after execution: ${name}.`);
  }
  const genesisBlock = await provider.getBlock(trustedGenesisManifest.deployment.blockNumber);
  checked(same(genesisBlock?.hash,trustedGenesisManifest.deployment.blockHash),
    'Genesis block changed after upgrade.');
  for (const name of oldRuntimeNames) {
    const code = await provider.getCode(old[name],finalized.number);
    checked(code !== '0x' && same(keccak256(code),genesisRecord.verification.code[name].codehash),
      `Preserved genesis runtime changed: ${name}.`);
  }
  checked(same(await call(provider,old.factory,factoryAbi,'lens',[],tag),old.lens)
    && same(await call(provider,old.lens,lensAbi,'factory',[],tag),old.factory),
  'Legacy Lens binding changed after upgrade.');
  const [registryRaw,poolCount,portfolioCount] = await Promise.all([
    provider.send('eth_call',[{to:old.factory,data:factoryAbi.encodeFunctionData('machineRegistryStatus')},tag]),
    call(provider,old.factory,factoryAbi,'poolCount',[],tag),
    call(provider,old.portfolioFactory,portfolioFactoryAbi,'portfolioCount',[],tag),
  ]);
  const [initialized,ready,cursor,cutoff] = factoryAbi.decodeFunctionResult('machineRegistryStatus',registryRaw);
  checked(initialized === true && ready === true
    && cursor.toString() === preExecutionPreflight.registry.cursor
    && cutoff.toString() === preExecutionPreflight.registry.cutoff,
  'Machine registry state changed during upgrade.');
  checked(poolCount.toString() === preExecutionPreflight.poolCount
    && portfolioCount.toString() === preExecutionPreflight.portfolioCount,
  'Pool or portfolio count changed across paused upgrade.');
  const historical = await historicalTreasuries(provider,old,poolCount,portfolioCount,tag);
  checked(evidenceDigest(historical) === evidenceDigest(preExecutionPreflight.historical),
    'Historical vault addresses or fee recipients changed across upgrade.');
  // Factory treasury setters are forward-only. Every existing vault remains on
  // its pinned treasury until a separately reviewed vault-level migration exists.
  const legacyTreasuryResidual = historical;
  const [again,againChain] = await Promise.all([provider.getBlock(finalized.number),provider.send('eth_chainId',[])]);
  checked(same(again?.hash,finalized.hash) && BigInt(againChain) === 56n,
    'Finalized block changed during result proof.');
  return {codeUpgradeComplete:true,roleMigrationComplete:false,operationId:plan.operationId,
    checkedAt:new Date().toISOString(),blockNumber:finalized.number,blockHash:finalized.hash,
    scheduleTxHash,executeTxHash,poolCount:poolCount.toString(),portfolioCount:portfolioCount.toString(),
    historical,legacyTreasuryResidual,checks};
}
