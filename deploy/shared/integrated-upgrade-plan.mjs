import {
  AbiCoder, Interface, ZeroHash, getAddress, keccak256, toUtf8Bytes,
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
  'function operator() view returns(address)', 'function treasury() view returns(address)',
  'function setOperator(address)', 'function setTreasury(address)', 'function transferOwnership(address)',
  'function poolCount() view returns(uint256)', 'function allPools(uint256) view returns(address)',
  'function creationPaused() view returns(bool)', 'function pauseCreation(bool)',
  'function machineRegistryStatus() view returns(bool initialized,bool ready,uint256 cursor,uint256 cutoff)',
  'event Upgraded(address indexed implementation)']);
const portfolioFactoryAbi = new Interface(['function owner() view returns(address)',
  'function portfolioCount() view returns(uint256)', 'function portfolioAt(uint256) view returns(address)',
  'function creationPaused() view returns(bool)', 'function pauseCreation(bool)',
  'function timelock() view returns(address)',
  'function operator() view returns(address)', 'function treasury() view returns(address)',
  'function setOperator(address)', 'function setTreasury(address)', 'function transferOwnership(address)']);
const vaultAbi = new Interface(['function treasury() view returns(address)',
  'function bnbOwed(address) view returns(uint256)', 'function bemOwed(address) view returns(uint256)',
  'function state() view returns(uint8)',
  'event TreasuryMigrated(address indexed previous,address indexed next)']);
const marketAbi = new Interface(['function upgradeToAndCall(address,bytes)',
  'event Upgraded(address indexed implementation)']);
const beaconAbi = new Interface(['function upgradeTo(address)', 'function implementation() view returns(address)',
  'function owner() view returns(address)', 'event Upgraded(address indexed implementation)']);
const lensAbi = new Interface(['function factory() view returns(address)']);
const timelockAbi = new Interface([
  'function schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
  'function execute(address,uint256,bytes,bytes32,bytes32) payable',
  'function hashOperation(address,uint256,bytes,bytes32,bytes32) view returns(bytes32)',
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
  'function CANCELLER_ROLE() view returns(bytes32)',
  'function EXECUTOR_ROLE() view returns(bytes32)',
  'function grantRole(bytes32,address)', 'function revokeRole(bytes32,address)',
  'event CallScheduled(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data,bytes32 predecessor,uint256 delay)',
  'event CallExecuted(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data)',
]);
const migrationAbi = new Interface(['function migrateTreasury(address expectedOld,address next)']);
const authorityAbi = new Interface([
  'function owner() view returns(address)', 'function coreFactory() view returns(address)',
  'function budgetFactory() view returns(address)',
  'function administratorOne() view returns(address)', 'function administratorTwo() view returns(address)',
  'function gasWallet() view returns(address)',
  'function eip712Domain() view returns(bytes1 fields,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt,uint256[] extensions)',
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
function upgradeImmutable(name,old,deployed) {
  return name === 'PoolVault' ? old.factory
    : name === 'BudgetPortfolioVault' ? old.portfolioFactory
      : ['PoolFactory','ShareMarket','BudgetPortfolioFactory'].includes(name) ? deployed : null;
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

async function genesisAt(provider,{genesisRecord,genesisBundle,trustedGenesisManifest},block,requirePaused=true) {
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
  if (requirePaused) checked(corePaused === true && budgetPaused === true,
    'Both factories must be paused by the current owner before the upgrade preflight.');
  const historical = await historicalTreasuries(provider,old,poolCount,portfolioCount,tag);
  checks.push({label:`All ${historical.length} historical vault addresses and fee recipients pinned`,passed:true});
  return {checks,registry:{initialized,ready,cursor:cursor.toString(),cutoff:cutoff.toString()},
    poolCount:poolCount.toString(),portfolioCount:portfolioCount.toString(),historical,
    creationPaused:{core:corePaused,budget:budgetPaused}};
}

/** Complete old-graph proof before either old-owner pauseCreation transaction. */
export async function validateIntegratedUpgradePreparationAgainstChain(provider,input) {
  const [chain,block]=await Promise.all([provider.send('eth_chainId',[]),provider.getBlock('finalized')]);
  requireThat(BigInt(chain)===56n && Number.isSafeInteger(block?.number) && HASH.test(block?.hash),
    'A finalized BSC block is required.');
  const result=await genesisAt(provider,input,block,false);
  const signer=address(input.signer,'connected old-owner wallet');
  requireThat(same(signer,input.genesisRecord.input.ownerMultisig),
    'Only the verified current owner may pause creation.');
  const next=input.nextPause;
  requireThat(next==='core' || next==='budget','A core or budget pause target is required.');
  requireThat(result.creationPaused[next]===false,
    `${next} factory creation is already paused.`);
  const again=await provider.getBlock(block.number);
  requireThat(same(again?.hash,block.hash),'Preparation proof block changed.');
  const target=next==='core'?input.genesisRecord.addresses.factory
    :input.genesisRecord.addresses.portfolioFactory;
  const data=(next==='core'?factoryAbi:portfolioFactoryAbi).encodeFunctionData('pauseCreation',[true]);
  return {checkedAt:new Date().toISOString(),blockNumber:block.number,blockHash:block.hash,
    ...result,signer,target,data,checks:[{label:'Finalized BSC chain',passed:true},...result.checks]};
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
      {...old,...replacements},deployed,upgradeImmutable(name,old,deployed))),
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
  const {genesisRecord,genesisBundle,trustedGenesisManifest,upgradeBundle,
    trustedUpgradeArtifactDigest,proposer,bootstrapPlan} = input;
  const rebuiltBootstrap=buildIntegratedProposerBootstrapPlan({...input,
    hardwareWallet:bootstrapPlan?.hardwareWallet,salt:bootstrapPlan?.salt,
    delaySeconds:bootstrapPlan?.delaySeconds});
  requireThat(same(evidenceDigest(rebuiltBootstrap),evidenceDigest(bootstrapPlan))
    && same(proposer,bootstrapPlan.hardwareWallet),
  'Only the bootstrapped hardware wallet may sign the code-upgrade batch.');
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
      upgradeImmutable(name,old,plan.replacements[name]));
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
  checked(await call(provider,old.timelock,timelockAbi,'isOperationDone',
    [bootstrapPlan.operationId],tag)===true,
  'Hardware-wallet proposer bootstrap is not complete.');
  if (phase === 'scheduled') {
    const executorRole = await call(provider,old.timelock,timelockAbi,'EXECUTOR_ROLE',[],tag);
    const [direct,open] = await Promise.all([
      call(provider,old.timelock,timelockAbi,'hasRole',[executorRole,signer],tag),
      call(provider,old.timelock,timelockAbi,'hasRole',[executorRole,ZERO_ADDRESS],tag),
    ]);
    checked(direct === true || open === true,
      'Connected wallet cannot execute the ready Timelock operation.');
  }
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
      plan.replacements[name],upgradeImmutable(name,old,plan.replacements[name]))),
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

function authorityDeploymentData(input) {
  const {genesisRecord,genesisBundle,trustedGenesisManifest,upgradeBundle,
    trustedUpgradeArtifactDigest,administratorOne,administratorTwo,gasWallet} = input;
  const old = checkTrustedGenesis(genesisRecord,genesisBundle,trustedGenesisManifest);
  requireThat(HASH.test(trustedUpgradeArtifactDigest)
    && same(buildDigest(upgradeBundle),trustedUpgradeArtifactDigest),
  'Authority build differs from the independently trusted upgrade artifact digest.');
  const artifact = upgradeBundle?.artifacts?.PlatformAuthority;
  requireThat(artifact?.contractName === 'PlatformAuthority'
    && /^0x[\da-f]+$/i.test(artifact.bytecode)
    && /^0x[\da-f]+$/i.test(artifact.deployedBytecode)
    && Object.keys(artifact.linkReferences ?? {}).length === 0
    && Object.keys(artifact.deployedLinkReferences ?? {}).length === 0,
  'The reviewed PlatformAuthority artifact is missing or unexpectedly linked.');
  const first = address(administratorOne,'first administrator');
  const second = address(administratorTwo,'second administrator');
  const gas = address(gasWallet,'public Gas wallet');
  requireThat(!same(first,second) && !same(first,gas) && !same(second,gas),
    'The two administrators and public Gas wallet must be distinct.');
  const constructorArgs = [address(old.factory,'core factory'),address(old.portfolioFactory,'budget factory'),
    first,second,gas];
  return {constructorArgs,creationData:artifact.bytecode
    + new Interface(artifact.abi).encodeDeploy(constructorArgs).slice(2)};
}

/** Exact creation calldata for a hardware-wallet deployment; the Gas wallet is only a public address here. */
export function integratedAuthorityDeploymentData(input) {
  return authorityDeploymentData(input).creationData;
}

async function boundedReads(items,read,limit=6) {
  const values=[];
  for (let index=0;index<items.length;index+=limit) {
    const outcomes=await Promise.allSettled(items.slice(index,index+limit).map(read));
    for (const outcome of outcomes) {
      if (outcome.status==='rejected') throw outcome.reason;
      values.push(outcome.value);
    }
  }
  return values;
}

async function postCodeGraphAt(provider,codePlan,input,block,expectedPaused=true) {
  const {genesisRecord,genesisBundle,trustedGenesisManifest,upgradeBundle,trustedUpgradeArtifactDigest} = input;
  const rebuilt = buildIntegratedUpgradePlan({...input,replacements:codePlan?.replacements,
    salt:codePlan?.salt,delaySeconds:codePlan?.delaySeconds});
  requireThat(same(evidenceDigest(rebuilt),evidenceDigest(codePlan)),
    'Post-code graph plan differs from reviewed calldata.');
  requireThat(HASH.test(trustedUpgradeArtifactDigest)
    && same(buildDigest(upgradeBundle),trustedUpgradeArtifactDigest),
  'Post-code bundle differs from independently trusted digest.');
  const old=genesisRecord.addresses, tag=`0x${block.number.toString(16)}`;
  const checks=[];
  const checked=(condition,label)=>{requireThat(condition,label);checks.push({label,passed:true});};
  const oldRuntimes=await boundedReads(oldRuntimeNames,name=>provider.getCode(old[name],block.number));
  for (const [index,name] of oldRuntimeNames.entries()) {
    const observed=oldRuntimes[index];
    checked(observed!=='0x' && same(observed,genesisRuntime(name,genesisRecord,genesisBundle)),
      `Preserved genesis runtime changed: ${name}.`);
  }
  const addresses={...old,...codePlan.replacements};
  const replacements=await boundedReads(integratedUpgradeDeploymentOrder,
    name=>provider.getCode(codePlan.replacements[name],block.number));
  for (const [index,name] of integratedUpgradeDeploymentOrder.entries()) {
    const observed=replacements[index];
    checked(observed!=='0x' && same(observed,expectedRuntime(upgradeBundle.artifacts[name],addresses,
      codePlan.replacements[name],upgradeImmutable(name,old,codePlan.replacements[name]))),
    `Reviewed replacement runtime changed: ${name}.`);
  }
  for (const [proxy,name] of [
    ['factory','PoolFactory'],['shareMarket','ShareMarket'],['portfolioFactory','BudgetPortfolioFactory'],
    ['portfolioShareMarket','ShareMarket'],
  ]) checked(same(slotAddress(await provider.getStorage(old[proxy],IMPLEMENTATION_SLOT,block.number)),
    codePlan.replacements[name]),`Current ${proxy} implementation differs from completed batch.`);
  for (const [beacon,name] of [['beacon','PoolVault'],['portfolioBeacon','BudgetPortfolioVault']]) {
    checked(same(await call(provider,old[beacon],beaconAbi,'implementation',[],tag),codePlan.replacements[name]),
      `Current ${beacon} implementation differs from completed batch.`);
  }
  checked(await call(provider,old.timelock,timelockAbi,'isOperationDone',[codePlan.operationId],tag)===true,
    'Code-upgrade Timelock batch is not complete.');
  checked(same(await call(provider,old.factory,factoryAbi,'lens',[],tag),old.lens)
    && same(await call(provider,old.lens,lensAbi,'factory',[],tag),old.factory),
  'Legacy Lens binding changed.');
  const [corePaused,budgetPaused,poolCount,portfolioCount,registryRaw] = await Promise.all([
    call(provider,old.factory,factoryAbi,'creationPaused',[],tag),
    call(provider,old.portfolioFactory,portfolioFactoryAbi,'creationPaused',[],tag),
    call(provider,old.factory,factoryAbi,'poolCount',[],tag),
    call(provider,old.portfolioFactory,portfolioFactoryAbi,'portfolioCount',[],tag),
    provider.send('eth_call',[{to:old.factory,data:factoryAbi.encodeFunctionData('machineRegistryStatus')},tag]),
  ]);
  const [initialized,ready,cursor,cutoff]=factoryAbi.decodeFunctionResult('machineRegistryStatus',registryRaw);
  checked(corePaused===expectedPaused && budgetPaused===expectedPaused,
    expectedPaused?'Both factories must remain paused during role and historical-pool migration.'
      :'Both factories must be resumed by the reviewed Timelock batch.');
  checked(initialized===true && ready===true && cursor===cutoff,
    'Machine registry is not fully ready.');
  const historical=await historicalTreasuries(provider,old,poolCount,portfolioCount,tag);
  return {checks,poolCount:poolCount.toString(),portfolioCount:portfolioCount.toString(),
    registry:{initialized,ready,cursor:cursor.toString(),cutoff:cutoff.toString()},historical};
}

/** Rechecks the complete upgraded code graph without assuming old vault treasuries are unchanged. */
export async function validateIntegratedPostCodeGraphAgainstChain(provider,codePlan,input) {
  const [chain,block]=await Promise.all([provider.send('eth_chainId',[]),provider.getBlock('finalized')]);
  requireThat(BigInt(chain)===56n && Number.isSafeInteger(block?.number) && HASH.test(block?.hash),
    'A finalized BSC block is required.');
  const result=await postCodeGraphAt(provider,codePlan,input,block);
  const again=await provider.getBlock(block.number);
  requireThat(same(again?.hash,block.hash),'Post-code graph finalized block changed.');
  return {codeUpgradeComplete:true,roleMigrationComplete:false,operationId:codePlan.operationId,
    blockNumber:block.number,blockHash:block.hash,checkedAt:new Date().toISOString(),...result};
}

function authorityRuntimeShape(artifact,observed) {
  requireThat(/^0x[\da-f]+$/i.test(observed)
    && observed.length===artifact.deployedBytecode.length,
  'PlatformAuthority runtime length differs from the reviewed artifact.');
  let expected=artifact.deployedBytecode.slice(2).toLowerCase();
  const actual=observed.slice(2).toLowerCase();
  for (const locations of Object.values(artifact.immutableReferences ?? {})) {
    for (const {start,length} of locations) {
      requireThat(Number.isSafeInteger(start) && start>=0 && Number.isSafeInteger(length)
        && length>0 && (start+length)*2<=expected.length,
      'PlatformAuthority immutable reference is malformed.');
      expected=expected.slice(0,start*2)+actual.slice(start*2,(start+length)*2)
        +expected.slice((start+length)*2);
    }
  }
  requireThat(expected===actual,
    'PlatformAuthority runtime differs outside compiler-declared constructor immutables.');
}

async function authorityAt(provider,input,graph,block) {
  const {codePlan,genesisRecord,upgradeBundle,authorityAddress,deploymentTxHash,
    administratorOne,administratorTwo,gasWallet} = input;
  const authority=address(authorityAddress,'PlatformAuthority');
  const {constructorArgs,creationData}=authorityDeploymentData(input);
  requireThat(!Object.values(genesisRecord.addresses).some(value=>same(value,authority))
    && !Object.values(codePlan.replacements).some(value=>same(value,authority)),
  'PlatformAuthority reuses a genesis or replacement address.');
  const deployment=await finalizedTransaction(provider,deploymentTxHash,block);
  requireThat(deployment.tx.to===null && same(deployment.tx.data,creationData)
    && same(deployment.receipt.contractAddress,authority),
  'PlatformAuthority creation transaction differs from reviewed constructor calldata.');
  const code=await provider.getCode(authority,block.number);
  authorityRuntimeShape(upgradeBundle.artifacts.PlatformAuthority,code);
  const tag=`0x${block.number.toString(16)}`;
  const [owner,core,budget,first,second,gas,domain]=await Promise.all([
    call(provider,authority,authorityAbi,'owner',[],tag),
    call(provider,authority,authorityAbi,'coreFactory',[],tag),
    call(provider,authority,authorityAbi,'budgetFactory',[],tag),
    call(provider,authority,authorityAbi,'administratorOne',[],tag),
    call(provider,authority,authorityAbi,'administratorTwo',[],tag),
    call(provider,authority,authorityAbi,'gasWallet',[],tag),
    provider.send('eth_call',[{to:authority,data:authorityAbi.encodeFunctionData('eip712Domain')},tag]),
  ]);
  const eip712=authorityAbi.decodeFunctionResult('eip712Domain',domain);
  requireThat(same(owner,genesisRecord.addresses.timelock)
    && same(core,constructorArgs[0]) && same(budget,constructorArgs[1])
    && same(first,constructorArgs[2]) && same(second,constructorArgs[3])
    && same(gas,constructorArgs[4])
    && eip712.name==='BEMine Platform Authority' && eip712.version==='1'
    && eip712.chainId===56n && same(eip712.verifyingContract,authority),
  'PlatformAuthority owner, constructor state or signing domain differs.');
  return {...graph,authorityAddress:authority,authorityCodehash:keccak256(code),deploymentTxHash,
    administratorOne:first,administratorTwo:second,gasWallet:gas,
    checks:[...graph.checks,{label:'Exact direct PlatformAuthority creation transaction',passed:true},
      {label:'Authority runtime and EIP-712 domain',passed:true}]};
}

/** Proves the direct creation transaction, runtime shape, immutable getters and EIP-712 domain. */
export async function validateIntegratedAuthorityAgainstChain(provider,input) {
  const graph=await validateIntegratedPostCodeGraphAgainstChain(provider,input.codePlan,input);
  const block=await provider.getBlock(graph.blockNumber);
  const result=await authorityAt(provider,input,graph,block);
  const again=await provider.getBlock(block.number);
  requireThat(same(again?.hash,block.hash),'PlatformAuthority proof block changed.');
  return result;
}

/** Stage zero: the old proposer schedules hardware-wallet proposer and canceller grants. */
export function buildIntegratedProposerBootstrapPlan(input) {
  const {genesisRecord,genesisBundle,trustedGenesisManifest,hardwareWallet,salt,delaySeconds}=input;
  const old=checkTrustedGenesis(genesisRecord,genesisBundle,trustedGenesisManifest);
  const hardware=address(hardwareWallet,'hardware wallet');
  const previous=address(genesisRecord.input.ownerMultisig,'old proposer');
  requireThat(!same(hardware,previous) && HASH.test(salt) && BigInt(salt)!==0n
    && Number.isSafeInteger(delaySeconds) && delaySeconds>=MIN_DELAY,
  'Stage-zero hardware address, salt or delay is invalid.');
  const proposerRole=keccak256(toUtf8Bytes('PROPOSER_ROLE'));
  const cancellerRole=keccak256(toUtf8Bytes('CANCELLER_ROLE'));
  const targets=[address(old.timelock,'Timelock'),address(old.timelock,'Timelock')];
  const values=['0','0'];
  const payloads=[timelockAbi.encodeFunctionData('grantRole',[proposerRole,hardware]),
    timelockAbi.encodeFunctionData('grantRole',[cancellerRole,hardware])];
  const args=[targets,values.map(BigInt),payloads,ZeroHash,salt];
  const operationId=keccak256(AbiCoder.defaultAbiCoder().encode(
    ['address[]','uint256[]','bytes[]','bytes32','bytes32'],args));
  return {kind:'integrated-v2-proposer-bootstrap-v1',timelock:targets[0],oldProposer:previous,
    hardwareWallet:hardware,targets,values,payloads,predecessor:ZeroHash,salt,delaySeconds,
    operationId,scheduleData:timelockAbi.encodeFunctionData('scheduleBatch',[...args,delaySeconds]),
    executeData:timelockAbi.encodeFunctionData('executeBatch',args)};
}

/** Stage-zero unscheduled/ready/done proof; `ready` is checked just before execute. */
export async function validateIntegratedProposerBootstrapAgainstChain(provider,plan,input) {
  const phase=input.phase;
  requireThat(['unscheduled','ready','done'].includes(phase),'Unknown proposer-bootstrap phase.');
  const rebuilt=buildIntegratedProposerBootstrapPlan({...input,hardwareWallet:plan?.hardwareWallet,
    salt:plan?.salt,delaySeconds:plan?.delaySeconds});
  requireThat(same(evidenceDigest(rebuilt),evidenceDigest(plan)),
    'Proposer bootstrap differs from reviewed Timelock calldata.');
  const [chain,block]=await Promise.all([provider.send('eth_chainId',[]),provider.getBlock('finalized')]);
  requireThat(BigInt(chain)===56n && Number.isSafeInteger(block?.number) && HASH.test(block?.hash),
    'A finalized BSC block is required.');
  const genesis=await genesisAt(provider,input,block);
  const tag=`0x${block.number.toString(16)}`,to=plan.timelock;
  const [minimum,operation,isReady,isDone,readyAt,chainHash,proposerRole,cancellerRole,executorRole]
    =await Promise.all([
      call(provider,to,timelockAbi,'getMinDelay',[],tag),
      call(provider,to,timelockAbi,'isOperation',[plan.operationId],tag),
      call(provider,to,timelockAbi,'isOperationReady',[plan.operationId],tag),
      call(provider,to,timelockAbi,'isOperationDone',[plan.operationId],tag),
      call(provider,to,timelockAbi,'getTimestamp',[plan.operationId],tag),
      call(provider,to,timelockAbi,'hashOperationBatch',[
        plan.targets,plan.values.map(BigInt),plan.payloads,plan.predecessor,plan.salt],tag),
      call(provider,to,timelockAbi,'PROPOSER_ROLE',[],tag),
      call(provider,to,timelockAbi,'CANCELLER_ROLE',[],tag),
      call(provider,to,timelockAbi,'EXECUTOR_ROLE',[],tag),
    ]);
  requireThat(minimum>=BigInt(MIN_DELAY) && BigInt(plan.delaySeconds)>=minimum
    && same(chainHash,plan.operationId)
    && same(proposerRole,keccak256(toUtf8Bytes('PROPOSER_ROLE')))
    && same(cancellerRole,keccak256(toUtf8Bytes('CANCELLER_ROLE'))),
  'Stage-zero Timelock roles, operation hash or minimum delay changed.');
  const [oldProposer,oldCanceller,newProposer,newCanceller,executorOpen]=await Promise.all([
    call(provider,to,timelockAbi,'hasRole',[proposerRole,plan.oldProposer],tag),
    call(provider,to,timelockAbi,'hasRole',[cancellerRole,plan.oldProposer],tag),
    call(provider,to,timelockAbi,'hasRole',[proposerRole,plan.hardwareWallet],tag),
    call(provider,to,timelockAbi,'hasRole',[cancellerRole,plan.hardwareWallet],tag),
    call(provider,to,timelockAbi,'hasRole',[executorRole,ZERO_ADDRESS],tag),
  ]);
  requireThat(oldProposer && oldCanceller && executorOpen,
    'The old proposer/canceller or open executor role is missing.');
  if (phase==='unscheduled') requireThat(!operation && !isReady && !isDone && readyAt===0n
    && !newProposer && !newCanceller,'Stage-zero salt is already used or hardware roles changed.');
  if (phase==='ready') requireThat(operation && isReady && !isDone
    && readyAt>0n && readyAt<=BigInt(block.timestamp) && !newProposer && !newCanceller,
  'Stage-zero operation is not ready for execution.');
  if (phase==='done') requireThat(operation && isDone && newProposer && newCanceller,
    'Stage-zero hardware proposer/canceller grant has not completed.');
  if (phase==='unscheduled' || phase==='ready') {
    const signer=address(input.signer,'connected signing wallet');
    requireThat(phase==='unscheduled' ? same(signer,plan.oldProposer)
      : executorOpen || await call(provider,to,timelockAbi,'hasRole',[executorRole,signer],tag),
    'Connected wallet cannot sign this stage-zero Timelock action.');
  }
  const again=await provider.getBlock(block.number);
  requireThat(same(again?.hash,block.hash),'Stage-zero finalized block changed.');
  return {phase,operationId:plan.operationId,blockNumber:block.number,blockHash:block.hash,
    readyAt:readyAt.toString(),hardwareWallet:plan.hardwareWallet,
    proposerBootstrapped:phase==='done',oldProposerRetained:true,
    historical:genesis.historical,registry:genesis.registry,
    checks:[...genesis.checks,{label:`Stage-zero Timelock ${phase}`,passed:true}]};
}

/** Four old-owner setters, one self-administered 48-hour revocation batch, then transfer both Factory owners to Timelock. */
export function buildIntegratedRoleMigrationPlan(input) {
  const {genesisRecord,codePlan,authorityAddress,hardwareWallet,salt,delaySeconds,bootstrapPlan} = input;
  const old=genesisRecord?.addresses;
  requireThat(codePlan?.kind===INTEGRATED_SECURITY_UPGRADE_KIND
    && HASH.test(codePlan.operationId) && old?.factory && old?.portfolioFactory && old?.timelock,
  'A code-upgrade plan and both genesis factories are required.');
  const owner=address(genesisRecord.input?.ownerMultisig,'old owner');
  const authority=address(authorityAddress,'PlatformAuthority');
  const hardware=address(hardwareWallet,'hardware wallet');
  requireThat(bootstrapPlan?.kind==='integrated-v2-proposer-bootstrap-v1'
    && same(bootstrapPlan.hardwareWallet,hardware) && HASH.test(bootstrapPlan.operationId),
  'The completed hardware-wallet proposer bootstrap plan is required.');
  requireThat(!same(owner,hardware) && !same(owner,authority) && !same(hardware,authority),
    'The old owner, hardware wallet and Authority must be different.');
  requireThat(HASH.test(salt) && BigInt(salt)!==0n
    && Number.isSafeInteger(delaySeconds) && delaySeconds>=MIN_DELAY,
  'A unique nonzero role salt and at least 48-hour delay are required.');
  const steps=[
    {name:'Core operator',target:old.factory,abi:factoryAbi,method:'setOperator',next:authority},
    {name:'Core treasury',target:old.factory,abi:factoryAbi,method:'setTreasury',next:authority},
    {name:'Budget operator',target:old.portfolioFactory,abi:portfolioFactoryAbi,method:'setOperator',next:authority},
    {name:'Budget treasury',target:old.portfolioFactory,abi:portfolioFactoryAbi,method:'setTreasury',next:authority},
    {name:'Core owner',target:old.factory,abi:factoryAbi,method:'transferOwnership',next:address(old.timelock,'Timelock')},
    {name:'Budget owner',target:old.portfolioFactory,abi:portfolioFactoryAbi,method:'transferOwnership',next:address(old.timelock,'Timelock')},
  ].map(({name,target,abi,method,next},index)=>({name,index,target:address(target,`${name} target`),
    signer:owner,method,next,data:abi.encodeFunctionData(method,[next]),value:'0',
    after:index<4?'code-upgrade':'role-batch'}));
  const proposerRole=keccak256(toUtf8Bytes('PROPOSER_ROLE'));
  const cancellerRole=keccak256(toUtf8Bytes('CANCELLER_ROLE'));
  const targets=Array(2).fill(address(old.timelock,'Timelock'));
  const values=Array(2).fill('0');
  const payloads=[
    timelockAbi.encodeFunctionData('revokeRole',[proposerRole,owner]),
    timelockAbi.encodeFunctionData('revokeRole',[cancellerRole,owner]),
  ];
  const args=[targets,values.map(BigInt),payloads,ZeroHash,salt];
  const operationId=keccak256(AbiCoder.defaultAbiCoder().encode(
    ['address[]','uint256[]','bytes[]','bytes32','bytes32'],args));
  return {kind:'integrated-v2-role-migration-v1',codeUpgradeOperationId:codePlan.operationId,
    bootstrapOperationId:bootstrapPlan.operationId,
    authorityAddress:authority,hardwareWallet:hardware,oldOwner:owner,
    timelock:address(old.timelock,'Timelock'),delaySeconds,salt,
    directSteps:steps,roleBatch:{targets,values,payloads,predecessor:ZeroHash,salt,
      operationId,delaySeconds,
      scheduleData:timelockAbi.encodeFunctionData('scheduleBatch',[...args,delaySeconds]),
      executeData:timelockAbi.encodeFunctionData('executeBatch',args)},
    historicalTreasuryComplete:false,roleMigrationComplete:false};
}

async function roleStateAt(provider,rolePlan,input,block) {
  const {genesisRecord,codePlan,bootstrapPlan}=input;
  const rebuiltBootstrap=buildIntegratedProposerBootstrapPlan({...input,
    hardwareWallet:bootstrapPlan?.hardwareWallet,salt:bootstrapPlan?.salt,
    delaySeconds:bootstrapPlan?.delaySeconds});
  requireThat(same(evidenceDigest(rebuiltBootstrap),evidenceDigest(bootstrapPlan)),
    'Hardware-wallet bootstrap is not the reviewed two-grant Timelock operation.');
  const expected=buildIntegratedRoleMigrationPlan({...input,authorityAddress:rolePlan?.authorityAddress,
    hardwareWallet:rolePlan?.hardwareWallet,salt:rolePlan?.salt,delaySeconds:rolePlan?.delaySeconds});
  requireThat(same(evidenceDigest(expected),evidenceDigest(rolePlan)),
    'Role migration plan differs from fixed reviewed calldata.');
  const old=genesisRecord.addresses,tag=`0x${block.number.toString(16)}`;
  requireThat(same(bootstrapPlan?.operationId,rolePlan.bootstrapOperationId),
    'Role plan is not bound to the hardware-wallet bootstrap.');
  const [coreOwner,coreOperator,coreTreasury,budgetOwner,budgetOperator,budgetTreasury,
    proposerRole,cancellerRole,executorRole,chainOperationId,minDelay,isOperation,isReady,isDone,readyAt,
    bootstrapDone]
    =await Promise.all([
      call(provider,old.factory,factoryAbi,'owner',[],tag),
      call(provider,old.factory,factoryAbi,'operator',[],tag),
      call(provider,old.factory,factoryAbi,'treasury',[],tag),
      call(provider,old.portfolioFactory,portfolioFactoryAbi,'owner',[],tag),
      call(provider,old.portfolioFactory,portfolioFactoryAbi,'operator',[],tag),
      call(provider,old.portfolioFactory,portfolioFactoryAbi,'treasury',[],tag),
      call(provider,old.timelock,timelockAbi,'PROPOSER_ROLE',[],tag),
      call(provider,old.timelock,timelockAbi,'CANCELLER_ROLE',[],tag),
      call(provider,old.timelock,timelockAbi,'EXECUTOR_ROLE',[],tag),
      call(provider,old.timelock,timelockAbi,'hashOperationBatch',[
        rolePlan.roleBatch.targets,rolePlan.roleBatch.values.map(BigInt),rolePlan.roleBatch.payloads,
        rolePlan.roleBatch.predecessor,rolePlan.roleBatch.salt],tag),
      call(provider,old.timelock,timelockAbi,'getMinDelay',[],tag),
      call(provider,old.timelock,timelockAbi,'isOperation',[rolePlan.roleBatch.operationId],tag),
      call(provider,old.timelock,timelockAbi,'isOperationReady',[rolePlan.roleBatch.operationId],tag),
      call(provider,old.timelock,timelockAbi,'isOperationDone',[rolePlan.roleBatch.operationId],tag),
      call(provider,old.timelock,timelockAbi,'getTimestamp',[rolePlan.roleBatch.operationId],tag),
      call(provider,old.timelock,timelockAbi,'isOperationDone',[bootstrapPlan.operationId],tag),
    ]);
  requireThat(same(proposerRole,keccak256(toUtf8Bytes('PROPOSER_ROLE')))
    && same(cancellerRole,keccak256(toUtf8Bytes('CANCELLER_ROLE')))
    && same(chainOperationId,rolePlan.roleBatch.operationId)
    && minDelay>=BigInt(MIN_DELAY) && BigInt(rolePlan.delaySeconds)>=minDelay && bootstrapDone===true,
  'Timelock role selectors, operation ID or delay changed.');
  const fields=[coreOperator,coreTreasury,budgetOperator,budgetTreasury,coreOwner,budgetOwner];
  const prior=[genesisRecord.input.operator,genesisRecord.input.treasury,
    genesisRecord.input.operator,genesisRecord.input.treasury,
    rolePlan.oldOwner,rolePlan.oldOwner];
  const applied=fields.map((value,index)=>{
    requireThat(same(value,prior[index]) || same(value,rolePlan.directSteps[index].next),
      `Unexpected ${rolePlan.directSteps[index].name} on-chain value.`);
    return same(value,rolePlan.directSteps[index].next);
  });
  for (let i=1;i<4;i++) requireThat(!applied[i] || applied[i-1],
    'Factory operator/treasury updates were applied out of order.');
  requireThat(!applied[5] || applied[4], 'Factory ownership transfers were applied out of order.');
  requireThat(!applied[4] || applied.slice(0,4).every(Boolean),
    'Factory ownership moved before all Authority setters.');
  requireThat(isOperation ? (isDone ? !isReady : readyAt>0n)
    : (!isReady && !isDone && readyAt===0n),
    'Invalid Timelock operation state.');
  const roleValues={};
  for (const [name,role] of [['proposer',proposerRole],['canceller',cancellerRole]]) {
    roleValues[`${name}Old`]=await call(provider,old.timelock,timelockAbi,'hasRole',[role,rolePlan.oldOwner],tag);
    roleValues[`${name}Hardware`]=await call(provider,old.timelock,timelockAbi,'hasRole',
      [role,rolePlan.hardwareWallet],tag);
  }
  const executorOpen=await call(provider,old.timelock,timelockAbi,'hasRole',
    [executorRole,ZERO_ADDRESS],tag);
  requireThat(executorOpen===true,'Timelock open execution was unexpectedly removed.');
  if (isDone) {
    requireThat(isOperation===true && roleValues.proposerHardware && roleValues.cancellerHardware
      && !roleValues.proposerOld && !roleValues.cancellerOld && applied.slice(0,4).every(Boolean),
    'Completed role batch did not hand off both proposer and canceller roles.');
  } else {
    requireThat(roleValues.proposerOld && roleValues.cancellerOld
      && roleValues.proposerHardware && roleValues.cancellerHardware
      && !applied[4] && !applied[5],
    'Timelock roles or Factory owner changed outside the planned batch.');
  }
  const status=isDone?'done':isReady?'ready':isOperation?'waiting':'unscheduled';
  return {applied,current:{coreOwner,coreOperator,coreTreasury,budgetOwner,budgetOperator,budgetTreasury},
    roles:roleValues,executorOpen,status,readyAt:readyAt.toString(),
    nextDirectStep:applied.findIndex((value,index)=>!value && (index<4 || isDone)),
    roleWiringComplete:isDone && applied.every(Boolean)};
}

/** Read-only role-state recovery. It proves code + Authority before accepting local journal state. */
export async function validateIntegratedRoleMigrationStateAgainstChain(provider,rolePlan,input) {
  const authority=await validateIntegratedAuthorityAgainstChain(provider,{...input,
    authorityAddress:rolePlan?.authorityAddress});
  const block=await provider.getBlock(authority.blockNumber);
  const state=await roleStateAt(provider,rolePlan,input,block);
  const again=await provider.getBlock(block.number);
  requireThat(same(again?.hash,block.hash),'Role migration proof block changed.');
  return {...authority,...state,roleOperationId:rolePlan.roleBatch.operationId,
    historicalTreasuryComplete:false,roleMigrationComplete:false};
}

/** Checks the connected wallet and exact next action immediately before each stage-two signature. */
export async function validateIntegratedRoleMigrationActionAgainstChain(provider,rolePlan,input) {
  const {action,signer}=input;
  const wallet=address(signer,'connected signing wallet');
  const proof=await validateIntegratedRoleMigrationStateAgainstChain(provider,rolePlan,input);
  const {applied,status}=proof;
  if (action?.type==='direct') {
    const index=action.index;
    requireThat(Number.isSafeInteger(index) && index>=0 && index<6,
      'Unknown Factory role-migration step.');
    requireThat(same(wallet,rolePlan.oldOwner) && applied[index]===false
      && applied.slice(0,index).every(Boolean)
      && (index<4 ? status==='unscheduled' : status==='done'),
    'Factory step is out of order or connected wallet is not its current owner.');
  } else if (action?.type==='schedule') {
    requireThat(same(wallet,rolePlan.hardwareWallet) && applied.slice(0,4).every(Boolean)
      && !applied[4] && !applied[5] && status==='unscheduled',
    'Timelock old-role revocation must be scheduled by the bootstrapped hardware wallet.');
  } else if (action?.type==='execute') {
    requireThat(applied.slice(0,4).every(Boolean) && !applied[4] && !applied[5]
      && status==='ready' && proof.executorOpen===true,
    'Timelock role handoff is not ready for open execution.');
  } else throw new Error('Unknown role migration action.');
  return {...proof,authorizedSigner:wallet,action,calldata:action.type==='direct'
    ? rolePlan.directSteps[action.index].data
    : action.type==='schedule'?rolePlan.roleBatch.scheduleData:rolePlan.roleBatch.executeData,
  target:action.type==='direct'?rolePlan.directSteps[action.index].target:rolePlan.timelock};
}

/** Independent 48-hour operations; one harvest failure cannot strand another pool. */
export function buildIntegratedTreasuryMigrationPlan(input) {
  const {genesisRecord,codeResult,authorityAddress,saltSeed,delaySeconds} = input;
  requireThat(codeResult?.codeUpgradeComplete === true && codeResult?.roleMigrationComplete === false
    && HASH.test(codeResult.operationId) && Array.isArray(codeResult.historical),
  'A verified code-upgrade result is required before historical treasury migration.');
  const old = genesisRecord?.addresses;
  const authority = address(authorityAddress,'PlatformAuthority');
  requireThat(old?.timelock && old?.factory && old?.portfolioFactory
    && HASH.test(saltSeed) && BigInt(saltSeed) !== 0n
    && Number.isSafeInteger(delaySeconds) && delaySeconds >= MIN_DELAY,
  'Invalid treasury migration authority, seed or delay.');
  const portfolios = codeResult.historical.filter(item => item.kind === 'portfolio'
    && !same(item.treasury,authority));
  requireThat(portfolios.length === 0,
    'Existing budget portfolio treasuries have no reviewed migration setter.');
  const pools = codeResult.historical.filter(item => item.kind === 'pool'
    && !same(item.treasury,authority));
  requireThat(new Set(pools.map(item => item.address.toLowerCase())).size === pools.length,
    'Duplicate historical pool migration target.');
  const operations = pools.map(item => {
    const target = address(item.address,'historical pool');
    const expectedOld = address(item.treasury,'historical treasury');
    const salt = keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32','address'],[saltSeed,target]));
    const data = migrationAbi.encodeFunctionData('migrateTreasury',[expectedOld,authority]);
    const operationId = keccak256(AbiCoder.defaultAbiCoder().encode(
      ['address','uint256','bytes','bytes32','bytes32'],[target,0n,data,ZeroHash,salt]));
    return {target,expectedOld,next:authority,data,value:'0',predecessor:ZeroHash,salt,
      delaySeconds,operationId,
      scheduleData:timelockAbi.encodeFunctionData('schedule',[target,0n,data,ZeroHash,salt,delaySeconds]),
      executeData:timelockAbi.encodeFunctionData('execute',[target,0n,data,ZeroHash,salt])};
  });
  return {kind:'integrated-v2-historical-treasury-migration-v1',
    codeResultDigest:evidenceDigest(codeResult),codeUpgradeOperationId:codeResult.operationId,
    authorityAddress:authority,timelock:address(old.timelock,'timelock'),
    saltSeed,delaySeconds,operations,roleMigrationComplete:false,
    historicalBnbAndBemOwedRemainWithOldTreasury:true};
}

async function treasuryMigrationStateAt(provider,migrationPlan,input,phase,block) {
  const {genesisRecord,codeResult,rolePlan}=input;
  const expected=buildIntegratedTreasuryMigrationPlan({genesisRecord,codeResult,
    authorityAddress:migrationPlan?.authorityAddress,saltSeed:migrationPlan?.saltSeed,
    delaySeconds:migrationPlan?.delaySeconds});
  requireThat(same(evidenceDigest(expected),evidenceDigest(migrationPlan)),
    'Historical-pool treasury plan differs from reviewed calldata.');
  requireThat(same(rolePlan?.authorityAddress,migrationPlan.authorityAddress),
    'Historical-pool treasury destination differs from verified Authority.');
  const roleProof=await validateIntegratedRoleMigrationStateAgainstChain(provider,rolePlan,input);
  requireThat(roleProof.roleWiringComplete===true,
    'Factory and Timelock role wiring must complete before old-pool treasury migration.');
  const historical=roleProof.historical;
  requireThat(historical.length===codeResult.historical.length
    && historical.every((item,index)=>item.kind===codeResult.historical[index].kind
      && item.index===codeResult.historical[index].index
      && same(item.address,codeResult.historical[index].address)),
  'Factory historical pool/portfolio registry differs from pinned code-upgrade result.');
  const migrated=new Set(migrationPlan.operations.map(item=>item.target.toLowerCase()));
  for (const item of historical) {
    if (item.kind==='portfolio') requireThat(same(item.treasury,migrationPlan.authorityAddress),
      'A historical budget portfolio has no supported treasury migration.');
    else if (!migrated.has(item.address.toLowerCase())) requireThat(
      same(item.treasury,migrationPlan.authorityAddress),
    'A historical pool was omitted from treasury migration.');
  }
  const index=input.operationIndex;
  requireThat(Number.isSafeInteger(index) && index>=0 && index<migrationPlan.operations.length,
    'Unknown historical-pool treasury operation index.');
  const operation=migrationPlan.operations[index];
  const current=historical.find(item=>same(item.address,operation.target));
  requireThat(current?.kind==='pool','Treasury migration target is not a registered historical pool.');
  const tag=`0x${block.number.toString(16)}`;
  const [isOperation,isReady,isDone,readyAt,chainHash,minimum,currentState,
    oldBnbOwed,oldBemOwed,executorRole]=await Promise.all([
      call(provider,migrationPlan.timelock,timelockAbi,'isOperation',[operation.operationId],tag),
      call(provider,migrationPlan.timelock,timelockAbi,'isOperationReady',[operation.operationId],tag),
      call(provider,migrationPlan.timelock,timelockAbi,'isOperationDone',[operation.operationId],tag),
      call(provider,migrationPlan.timelock,timelockAbi,'getTimestamp',[operation.operationId],tag),
      call(provider,migrationPlan.timelock,timelockAbi,'hashOperation',[
        operation.target,0n,operation.data,operation.predecessor,operation.salt],tag),
      call(provider,migrationPlan.timelock,timelockAbi,'getMinDelay',[],tag),
      call(provider,operation.target,vaultAbi,'state',[],tag),
      call(provider,operation.target,vaultAbi,'bnbOwed',[operation.expectedOld],tag),
      call(provider,operation.target,vaultAbi,'bemOwed',[operation.expectedOld],tag),
      call(provider,migrationPlan.timelock,timelockAbi,'EXECUTOR_ROLE',[],tag),
    ]);
  requireThat(same(chainHash,operation.operationId) && minimum>=BigInt(MIN_DELAY)
    && BigInt(operation.delaySeconds)>=minimum,
  'Historical-pool Timelock operation ID or delay changed.');
  if (phase==='unscheduled') requireThat(!isOperation && !isReady && !isDone && readyAt===0n
    && same(current.treasury,operation.expectedOld),
  'Historical-pool treasury operation is already scheduled or treasury changed.');
  else if (phase==='ready') requireThat(isOperation && isReady && !isDone
    && readyAt>0n && readyAt<=BigInt(block.timestamp)
    && same(current.treasury,operation.expectedOld),
  'Historical-pool treasury operation is not ready or expected old treasury changed.');
  else if (phase==='done') requireThat(isOperation && isDone
    && same(current.treasury,operation.next),
  'Historical-pool treasury operation is not complete.');
  else throw new Error('Unknown historical-pool treasury phase.');
  if (phase!=='done') {
    const wallet=address(input.signer,'connected signing wallet');
    if (phase==='unscheduled') requireThat(same(wallet,rolePlan.hardwareWallet),
      'Only the bootstrapped hardware proposer may schedule old-pool treasury migration.');
    else {
      const [direct,open]=await Promise.all([
        call(provider,migrationPlan.timelock,timelockAbi,'hasRole',[executorRole,wallet],tag),
        call(provider,migrationPlan.timelock,timelockAbi,'hasRole',[executorRole,ZERO_ADDRESS],tag),
      ]);
      requireThat(direct===true || open===true,'Connected wallet cannot execute this Timelock operation.');
    }
  }
  return {...roleProof,phase,operationIndex:index,operationId:operation.operationId,
    target:operation.target,expectedOld:operation.expectedOld,next:operation.next,
    currentState:Number(currentState),strictHarvestRequired:Number(currentState)===2
      || Number(currentState)===3,
    oldBnbOwed:oldBnbOwed.toString(),oldBemOwed:oldBemOwed.toString(),
    readyAt:readyAt.toString(),historicalTreasuryComplete:false,roleMigrationComplete:false};
}

/** Per-pool schedule/execute preflight. Active/Listed pools may revert if strict claim fails. */
export async function validateIntegratedTreasuryMigrationActionAgainstChain(provider,migrationPlan,input) {
  const phase=input.phase;
  requireThat(phase==='unscheduled' || phase==='ready',
    'Only unscheduled and ready treasury operations have a signing preflight.');
  const [chain,block]=await Promise.all([provider.send('eth_chainId',[]),provider.getBlock('finalized')]);
  requireThat(BigInt(chain)===56n && Number.isSafeInteger(block?.number) && HASH.test(block?.hash),
    'A finalized BSC block is required.');
  const state=await treasuryMigrationStateAt(provider,migrationPlan,input,phase,block);
  const again=await provider.getBlock(block.number);
  requireThat(same(again?.hash,block.hash),'Treasury migration preflight block changed.');
  return {...state,blockNumber:block.number,blockHash:block.hash,
    checkedAt:new Date().toISOString(),
    calldata:phase==='unscheduled'?migrationPlan.operations[input.operationIndex].scheduleData
      :migrationPlan.operations[input.operationIndex].executeData,
    transactionTarget:migrationPlan.timelock};
}

/** Finalized single-pool migration receipt, exact Timelock events and old accrued-fee preservation. */
export async function validateIntegratedTreasuryMigrationResultAgainstChain(provider,migrationPlan,input) {
  const {preExecutionPreflight,scheduleTxHash,executeTxHash,operationIndex}=input;
  const operation=migrationPlan?.operations?.[operationIndex];
  requireThat(operation && preExecutionPreflight?.phase==='ready'
    && preExecutionPreflight.operationIndex===operationIndex
    && same(preExecutionPreflight.operationId,operation.operationId)
    && HASH.test(preExecutionPreflight.blockHash)
    && Number.isSafeInteger(preExecutionPreflight.blockNumber)
    && /^\d+$/.test(preExecutionPreflight.oldBnbOwed??'')
    && /^\d+$/.test(preExecutionPreflight.oldBemOwed??''),
  'A pinned ready old-pool treasury preflight is required.');
  const [chain,block,previous]=await Promise.all([
    provider.send('eth_chainId',[]),provider.getBlock('finalized'),
    provider.getBlock(preExecutionPreflight.blockNumber),
  ]);
  requireThat(BigInt(chain)===56n && HASH.test(block?.hash)
    && same(previous?.hash,preExecutionPreflight.blockHash),
  'Treasury migration finality or ready-block anchor changed.');
  const tag=`0x${previous.number.toString(16)}`;
  const [priorTreasury,priorBnb,priorBem]=await Promise.all([
    call(provider,operation.target,vaultAbi,'treasury',[],tag),
    call(provider,operation.target,vaultAbi,'bnbOwed',[operation.expectedOld],tag),
    call(provider,operation.target,vaultAbi,'bemOwed',[operation.expectedOld],tag),
  ]);
  requireThat(same(priorTreasury,operation.expectedOld)
    && priorBnb.toString()===preExecutionPreflight.oldBnbOwed
    && priorBem.toString()===preExecutionPreflight.oldBemOwed,
  'Persisted old-fee snapshot differs from its canonical historical block.');
  const [scheduled,executed]=await Promise.all([
    finalizedTransaction(provider,scheduleTxHash,block),
    finalizedTransaction(provider,executeTxHash,block),
  ]);
  requireThat(scheduled.receipt.blockNumber<=previous.number
    && executed.receipt.blockNumber>previous.number
    && BigInt(executed.block.timestamp)>=BigInt(scheduled.block.timestamp)+BigInt(operation.delaySeconds),
  'Historical-pool Timelock delay or pre-execution ordering differs.');
  for (const [proof,event] of [[scheduled,'CallScheduled'],[executed,'CallExecuted']]) {
    const events=logsOf(proof,migrationPlan.timelock,timelockAbi,event);
    requireThat(events.length===1 && same(events[0].args.id,operation.operationId)
      && events[0].args.index===0n && same(events[0].args.target,operation.target)
      && events[0].args.value===0n && same(events[0].args.data,operation.data)
      && (event!=='CallScheduled' || same(events[0].args.predecessor,ZeroHash)
        && events[0].args.delay===BigInt(operation.delaySeconds)),
    `Historical-pool ${event} differs from reviewed plan.`);
  }
  const migrated=logsOf(executed,operation.target,vaultAbi,'TreasuryMigrated');
  requireThat(migrated.length===1 && same(migrated[0].args.previous,operation.expectedOld)
    && same(migrated[0].args.next,operation.next),
  'Historical-pool TreasuryMigrated event differs.');
  const state=await treasuryMigrationStateAt(provider,migrationPlan,input,'done',block);
  requireThat(BigInt(state.oldBnbOwed)>=priorBnb && BigInt(state.oldBemOwed)>=priorBem,
    'Previously accrued fees are no longer owed to the old treasury.');
  const again=await provider.getBlock(block.number);
  requireThat(same(again?.hash,block.hash),'Treasury migration result block changed.');
  return {...state,blockNumber:block.number,blockHash:block.hash,
    checkedAt:new Date().toISOString(),scheduleTxHash,executeTxHash,
    oldAccruedFeesRemainWithOldTreasury:true};
}

/** Complete only after every old pool's separate Timelock migration and both Factory/role handoffs. */
export async function validateIntegratedOnChainMigrationCompleteAgainstChain(provider,migrationPlan,input) {
  const {genesisRecord,codeResult,rolePlan}=input;
  const expected=buildIntegratedTreasuryMigrationPlan({genesisRecord,codeResult,
    authorityAddress:migrationPlan?.authorityAddress,saltSeed:migrationPlan?.saltSeed,
    delaySeconds:migrationPlan?.delaySeconds});
  requireThat(same(evidenceDigest(expected),evidenceDigest(migrationPlan))
    && same(rolePlan?.authorityAddress,migrationPlan.authorityAddress),
  'Final role/treasury migration plan differs from reviewed calldata.');
  const proof=await validateIntegratedRoleMigrationStateAgainstChain(provider,rolePlan,input);
  requireThat(proof.roleWiringComplete===true,
    'Factory owner/operator/treasury and Timelock roles are not fully migrated.');
  const tag=`0x${proof.blockNumber.toString(16)}`;
  const poolAddresses=codeResult.historical.filter(item=>item.kind==='pool'
    && !same(item.treasury,migrationPlan.authorityAddress)).map(item=>item.address.toLowerCase());
  requireThat(poolAddresses.length===migrationPlan.operations.length
    && poolAddresses.every(value=>migrationPlan.operations.some(op=>op.target.toLowerCase()===value)),
  'Historical pool migration operations do not cover every existing pool.');
  requireThat(proof.historical.every(item=>same(item.treasury,migrationPlan.authorityAddress)),
    'A historical pool or portfolio still points at its old treasury.');
  for (const operation of migrationPlan.operations) requireThat(await call(provider,migrationPlan.timelock,
    timelockAbi,'isOperationDone',[operation.operationId],tag)===true,
  `Historical pool ${operation.target} Timelock migration is not complete.`);
  const again=await provider.getBlock(proof.blockNumber);
  requireThat(same(again?.hash,proof.blockHash),'Final role migration proof block changed.');
  return {...proof,historicalTreasuryComplete:true,roleMigrationComplete:true,
    onChainMigrationComplete:true,keeperCutoverVerified:false,deploymentComplete:false,
    previousAccruedFeesAreNotRedirected:true,
    checks:[...proof.checks,{label:'Every historical treasury and Timelock migration',passed:true}]};
}

/** Separate 48-hour Timelock batch for reopening both factories after the keeper is ready. */
export function buildIntegratedCreationResumePlan(input) {
  const {genesisRecord,rolePlan,migrationPlan,salt,delaySeconds}=input;
  const old=genesisRecord?.addresses;
  requireThat(old?.factory && old?.portfolioFactory && old?.timelock
    && same(rolePlan?.timelock,old.timelock)
    && same(migrationPlan?.timelock,old.timelock)
    && same(rolePlan?.authorityAddress,migrationPlan?.authorityAddress),
  'Completed role and historical-treasury plans are required to resume creation.');
  requireThat(HASH.test(salt) && BigInt(salt)!==0n
    && Number.isSafeInteger(delaySeconds) && delaySeconds>=MIN_DELAY,
  'A unique nonzero resume salt and at least 48-hour delay are required.');
  const targets=[address(old.factory,'core factory'),address(old.portfolioFactory,'budget factory')];
  const values=['0','0'];
  const payloads=[factoryAbi.encodeFunctionData('pauseCreation',[false]),
    portfolioFactoryAbi.encodeFunctionData('pauseCreation',[false])];
  const args=[targets,values.map(BigInt),payloads,ZeroHash,salt];
  const operationId=keccak256(AbiCoder.defaultAbiCoder().encode(
    ['address[]','uint256[]','bytes[]','bytes32','bytes32'],args));
  return {kind:'integrated-v2-resume-creation-v1',timelock:address(old.timelock,'Timelock'),
    hardwareWallet:address(rolePlan.hardwareWallet,'hardware wallet'),
    rolePlanDigest:evidenceDigest(rolePlan),migrationPlanDigest:evidenceDigest(migrationPlan),
    targets,values,payloads,predecessor:ZeroHash,salt,delaySeconds,operationId,
    scheduleData:timelockAbi.encodeFunctionData('scheduleBatch',[...args,delaySeconds]),
    executeData:timelockAbi.encodeFunctionData('executeBatch',args),
    keeperCutoverVerified:false,deploymentComplete:false};
}

/** Chain-only signing preflight; backend keeper readiness remains an independent release gate. */
export async function validateIntegratedCreationResumeActionAgainstChain(provider,resumePlan,input) {
  const {migrationPlan,rolePlan,phase,signer}=input;
  requireThat(phase==='unscheduled' || phase==='ready','Unknown creation-resume signing phase.');
  const expected=buildIntegratedCreationResumePlan({...input,salt:resumePlan?.salt,
    delaySeconds:resumePlan?.delaySeconds});
  requireThat(same(evidenceDigest(expected),evidenceDigest(resumePlan)),
    'Creation-resume batch differs from reviewed calldata.');
  const proof=await validateIntegratedOnChainMigrationCompleteAgainstChain(provider,migrationPlan,input);
  const wallet=address(signer,'connected signing wallet');
  const tag=`0x${proof.blockNumber.toString(16)}`;
  const [minDelay,chainId,isOperation,isReady,isDone,readyAt,chainOperationId,
    proposerRole,executorRole]=await Promise.all([
      call(provider,resumePlan.timelock,timelockAbi,'getMinDelay',[],tag),
      provider.send('eth_chainId',[]),
      call(provider,resumePlan.timelock,timelockAbi,'isOperation',[resumePlan.operationId],tag),
      call(provider,resumePlan.timelock,timelockAbi,'isOperationReady',[resumePlan.operationId],tag),
      call(provider,resumePlan.timelock,timelockAbi,'isOperationDone',[resumePlan.operationId],tag),
      call(provider,resumePlan.timelock,timelockAbi,'getTimestamp',[resumePlan.operationId],tag),
      call(provider,resumePlan.timelock,timelockAbi,'hashOperationBatch',[
        resumePlan.targets,resumePlan.values.map(BigInt),resumePlan.payloads,
        resumePlan.predecessor,resumePlan.salt],tag),
      call(provider,resumePlan.timelock,timelockAbi,'PROPOSER_ROLE',[],tag),
      call(provider,resumePlan.timelock,timelockAbi,'EXECUTOR_ROLE',[],tag),
    ]);
  requireThat(BigInt(chainId)===56n && same(chainOperationId,resumePlan.operationId)
    && BigInt(resumePlan.delaySeconds)>=minDelay && minDelay>=BigInt(MIN_DELAY),
  'Creation-resume Timelock identity or delay changed.');
  if (phase==='unscheduled') {
    requireThat(!isOperation && !isReady && !isDone && readyAt===0n
      && same(wallet,rolePlan.hardwareWallet)
      && await call(provider,resumePlan.timelock,timelockAbi,'hasRole',[proposerRole,wallet],tag),
    'Creation resume is already arranged or wallet lacks PROPOSER_ROLE.');
  } else {
    const [directExecutor,openExecutor]=await Promise.all([
      call(provider,resumePlan.timelock,timelockAbi,'hasRole',[executorRole,wallet],tag),
      call(provider,resumePlan.timelock,timelockAbi,'hasRole',[executorRole,ZERO_ADDRESS],tag),
    ]);
    requireThat(isOperation && isReady && !isDone && readyAt>0n
      && (directExecutor || openExecutor),
    'Creation-resume batch is not ready or connected wallet cannot execute it.');
  }
  const again=await provider.getBlock(proof.blockNumber);
  requireThat(same(again?.hash,proof.blockHash),'Creation-resume preflight block changed.');
  return {...proof,phase,operationId:resumePlan.operationId,readyAt:readyAt.toString(),
    transactionTarget:resumePlan.timelock,
    calldata:phase==='unscheduled'?resumePlan.scheduleData:resumePlan.executeData,
    keeperCutoverVerified:false,deploymentComplete:false,
    operationalGate:'Verify keeper signer, admin-signature queue, publish and RPC health before scheduling.'};
}

/** Post-unpause verifier: complete code/runtime/role graph plus exact delayed Timelock receipts. */
export async function validateIntegratedCreationResumeResultAgainstChain(provider,resumePlan,input) {
  const {genesisRecord,codePlan,rolePlan,migrationPlan,codeResult,scheduleTxHash,executeTxHash}=input;
  const expected=buildIntegratedCreationResumePlan({...input,salt:resumePlan?.salt,
    delaySeconds:resumePlan?.delaySeconds});
  requireThat(same(evidenceDigest(expected),evidenceDigest(resumePlan))
    && HASH.test(scheduleTxHash) && HASH.test(executeTxHash)
    && !same(scheduleTxHash,executeTxHash),
  'Creation-resume operation or transaction hashes differ from reviewed plan.');
  const [chain,block]=await Promise.all([provider.send('eth_chainId',[]),provider.getBlock('finalized')]);
  requireThat(BigInt(chain)===56n && Number.isSafeInteger(block?.number) && HASH.test(block?.hash),
    'A finalized BSC block is required after creation resume.');
  const [scheduled,executed,codeGraph]=await Promise.all([
    finalizedTransaction(provider,scheduleTxHash,block),
    finalizedTransaction(provider,executeTxHash,block),
    postCodeGraphAt(provider,codePlan,input,block,false),
  ]);
  requireThat(executed.receipt.blockNumber>scheduled.receipt.blockNumber
    && BigInt(executed.block.timestamp)>=BigInt(scheduled.block.timestamp)
      +BigInt(resumePlan.delaySeconds),
  'Creation-resume batch was not executed after its full Timelock delay.');
  for (const [proof,event] of [[scheduled,'CallScheduled'],[executed,'CallExecuted']]) {
    const events=logsOf(proof,resumePlan.timelock,timelockAbi,event);
    requireThat(events.length===2,`Creation-resume ${event} call count differs.`);
    for (let index=0;index<2;index++) {
      const args=events[index].args;
      requireThat(same(args.id,resumePlan.operationId) && args.index===BigInt(index)
        && same(args.target,resumePlan.targets[index]) && args.value===0n
        && same(args.data,resumePlan.payloads[index])
        && (event!=='CallScheduled' || same(args.predecessor,ZeroHash)
          && args.delay===BigInt(resumePlan.delaySeconds)),
      `Creation-resume ${event} ${index} differs from reviewed calldata.`);
    }
  }
  const authority=await authorityAt(provider,input,{...codeGraph,blockNumber:block.number,
    blockHash:block.hash,checkedAt:new Date().toISOString()},block);
  const roleState=await roleStateAt(provider,rolePlan,input,block);
  requireThat(roleState.roleWiringComplete===true
    && same(roleState.current.coreOwner,resumePlan.timelock)
    && same(roleState.current.budgetOwner,resumePlan.timelock),
  'Factory owners or administrator roles drifted after creation resumed.');
  const regeneratedMigration=buildIntegratedTreasuryMigrationPlan({genesisRecord,codeResult,
    authorityAddress:migrationPlan?.authorityAddress,saltSeed:migrationPlan?.saltSeed,
    delaySeconds:migrationPlan?.delaySeconds});
  requireThat(same(evidenceDigest(regeneratedMigration),evidenceDigest(migrationPlan))
    && codeGraph.historical.every(item=>same(item.treasury,rolePlan.authorityAddress)),
  'Historical treasuries or their reviewed migration operations changed.');
  const tag=`0x${block.number.toString(16)}`;
  const done=await Promise.all([resumePlan.operationId,...migrationPlan.operations.map(op=>op.operationId)]
    .map(id=>call(provider,resumePlan.timelock,timelockAbi,'isOperationDone',[id],tag)));
  requireThat(done.every(Boolean),'A creation-resume or historical-treasury operation is incomplete.');
  const again=await provider.getBlock(block.number);
  requireThat(same(again?.hash,block.hash),'Post-unpause finalized block changed.');
  return {...authority,...roleState,blockNumber:block.number,blockHash:block.hash,
    checkedAt:new Date().toISOString(),operationId:resumePlan.operationId,
    scheduleTxHash,executeTxHash,codeUpgradeComplete:true,roleMigrationComplete:true,
    historicalTreasuryComplete:true,bothFactoriesUnpaused:true,
    keeperCutoverVerified:false,deploymentComplete:false,
    checks:[...authority.checks,{label:'Both factories unpaused by exact 48-hour Timelock batch',passed:true},
      {label:'All Factory owners, roles and historical treasuries remain migrated',passed:true}]};
}
