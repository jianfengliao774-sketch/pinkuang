import { AbiCoder, Interface, ZeroAddress, ZeroHash, getAddress, keccak256 } from 'ethers';
import { buildDigest, evidenceDigest } from './firsto-upgrade-proof.mjs';
import { validateFirstoBatchUpgradeReview } from './firsto-batch-upgrade-plan.mjs';
import { reviewedUpgradeBytecode } from './integrated-upgrade-plan.mjs';

export const GOVERNANCE24_UPGRADE_KIND = 'platform-governance24-upgrade-v1';
export const GOVERNANCE24_REVIEW_KIND = 'platform-governance24-review-v1';
export const governance24UpgradeDeploymentOrder = Object.freeze([
  'FlexiblePurchase', 'PoolVault', 'BudgetPortfolioVault', 'PoolTimelock24',
  'CoreGovernance24Beacon', 'PortfolioGovernance24Beacon',
  'CoreGovernance24Dispatcher', 'PortfolioGovernance24Dispatcher',
  'Governance24Validation',
  'Governance24FreshPoolFactory', 'Governance24BudgetPortfolioFactory',
  'CoreGovernance24ShareMarket', 'PortfolioGovernance24ShareMarket',
]);
export const governance24ArtifactNames = Object.freeze({
  ...Object.fromEntries(governance24UpgradeDeploymentOrder.map(name => [name, name])),
  CoreGovernance24Beacon: 'Governance24Beacon', PortfolioGovernance24Beacon: 'Governance24Beacon',
  CoreGovernance24Dispatcher: 'Governance24Dispatcher', PortfolioGovernance24Dispatcher: 'Governance24Dispatcher',
  CoreGovernance24ShareMarket: 'Governance24ShareMarket', PortfolioGovernance24ShareMarket: 'Governance24ShareMarket',
});
export const governance24ActionIds = Object.freeze(['core-dispatch', 'portfolio-dispatch',
  'core-factory', 'portfolio-factory', 'core-market', 'portfolio-market', 'authority-owner']);
const HASH = /^0x[\da-f]{64}$/i, HEX = /^0x(?:[\da-f]{2})+$/i;
const need = (ok, text) => { if (!ok) throw new Error(text); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const address = value => { const a = getAddress(value); need(a !== ZeroAddress, 'Zero address.'); return a; };
const exact = (value, names, text) => need(value && Object.keys(value).sort().join(',') === [...names].sort().join(','), text);
export const governance24BatchAbi = new Interface([
  'function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)',
  'function executeBatch(address[],uint256[],bytes[],bytes32,bytes32) payable',
]);
const actions = new Interface(['function upgradeTo(address)', 'function upgradeToAndCall(address,bytes)',
  'function migrateGovernance24(address,address)', 'function transferOwnership(address)', 'function cancel(bytes32)']);
const linkPolicy = Object.freeze({
  FlexiblePurchase: ['PoolFunds', 'PurchaseValidation'],
  PoolVault: ['FirstoSale', 'FlexiblePurchase', 'MiningOperations', 'PoolFunds', 'RewardAccounting',
    'SaleGovernance', 'SaleSettlement', 'ShareCheckpoints'],
  BudgetPortfolioVault: ['SaleGovernance'], PoolTimelock24: [], Governance24Beacon: [], Governance24Dispatcher: [], Governance24Validation: [],
  Governance24FreshPoolFactory: ['Governance24Validation','PurchaseValidation'], Governance24BudgetPortfolioFactory: ['Governance24Validation'], Governance24ShareMarket: ['Governance24Validation'],
});
const safeInputs=new WeakSet(),reviewCache=new WeakMap();
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
/** Clone and freeze all evidence before asynchronous chain reads, keeping later caller mutations out of a proof. */
export function snapshotGovernance24UpgradeInput(input) {
  const copied=freeze(JSON.parse(JSON.stringify(input)));safeInputs.add(copied);return copied;
}
const immutableNames = Object.freeze({
  FlexiblePurchase: [], PoolVault: ['OFFICIAL_FACTORY'], BudgetPortfolioVault: ['OFFICIAL_FACTORY'],
  PoolTimelock24: ['INITIAL_PROPOSER'], Governance24Beacon: ['OFFICIAL_FACTORY'], Governance24Validation: [],
  Governance24Dispatcher: ['OFFICIAL_FACTORY', 'SECONDARY_BEACON', 'SELF'],
  Governance24FreshPoolFactory: ['__self'], Governance24BudgetPortfolioFactory: ['__self'], Governance24ShareMarket: ['__self'],
});

function linked(template, refs, addresses, artifact, occupied = new Set()) {
  need(typeof template === 'string' && template.startsWith('0x') && template.length % 2 === 0, `Invalid ${artifact} bytecode.`);
  let result = template.slice(2), names = [];
  for (const [source, libraries] of Object.entries(refs ?? {})) for (const [name, positions] of Object.entries(libraries)) {
    need(source === `src/libraries/${name}.sol` && Array.isArray(positions) && positions.length > 0, `Unexpected ${artifact} link source.`);
    names.push(name);
    for (const { start, length } of positions) {
      need(Number.isSafeInteger(start) && start >= 0 && length === 20 && (start + length) * 2 <= result.length
        && /^__\$[\da-f]{34}\$__$/.test(template.slice(2 + start * 2, 2 + (start + length) * 2)), `Invalid ${artifact} link reference.`);
      for (let at = start; at < start + length; at++) { need(!occupied.has(at), 'Overlapping bytecode bindings.'); occupied.add(at); }
      result = result.slice(0, start * 2) + address(addresses[name]).slice(2).toLowerCase() + result.slice((start + length) * 2);
    }
  }
  need(names.sort().join(',') === [...linkPolicy[artifact]].sort().join(',') && /^[\da-f]+$/i.test(result), `Unexpected ${artifact} dependencies or unresolved bytecode.`);
  return `0x${result}`;
}
function artifactFor(input, name) {
  const contractName = governance24ArtifactNames[name], artifact = input.upgradeBundle.artifacts[contractName];
  need(artifact?.contractName === contractName && Array.isArray(artifact.abi), `Missing ${contractName} artifact.`);
  const constructor=artifact.abi.filter(entry=>entry.type==='constructor'),expectedTypes=['PoolVault','BudgetPortfolioVault','PoolTimelock24'].includes(contractName)
    ? ['address'] : ['Governance24Beacon','Governance24Dispatcher'].includes(contractName) ? ['address','address'] : [];
  need(constructor.length <= 1 && (constructor[0]?.inputs ?? []).map(item=>item.type).join(',') === expectedTypes.join(',')
    && (!constructor.length || constructor[0].stateMutability === 'nonpayable'), `Unexpected ${contractName} constructor.`);
  const names = Object.values(artifact.immutableBindings ?? {}), ids = Object.keys(artifact.immutableReferences ?? {});
  exact(artifact.immutableBindings ?? {}, ids, `Missing compiler immutable names: ${contractName}.`);
  need([...names].sort().join(',') === [...immutableNames[contractName]].sort().join(','), `Unexpected ${contractName} immutable declarations.`);
  return artifact;
}
function constructors(name, a, proposer) {
  if (name === 'PoolVault') return [a.factory];
  if (name === 'BudgetPortfolioVault') return [a.portfolioFactory];
  if (name === 'PoolTimelock24') return [proposer];
  if (name.endsWith('Beacon')) return [name.startsWith('Core') ? a.PoolVault : a.BudgetPortfolioVault, a.PoolTimelock24];
  if (name.endsWith('Dispatcher')) return [name.startsWith('Core') ? a.factory : a.portfolioFactory,
    name.startsWith('Core') ? a.CoreGovernance24Beacon : a.PortfolioGovernance24Beacon];
  return [];
}
export function governance24ExpectedRuntime(artifact, addresses, deployedAddress, name) {
  const occupied = new Set();
  let code = linked(artifact.deployedBytecode, artifact.deployedLinkReferences, addresses, artifact.contractName, occupied).slice(2).toLowerCase();
  const bindings = { __self: deployedAddress, SELF: deployedAddress, INITIAL_PROPOSER: addresses.proposer,
    OFFICIAL_FACTORY: name === 'PoolVault' || name.startsWith('Core')
    ? addresses.factory : addresses.portfolioFactory,
  SECONDARY_BEACON: name.startsWith('Core') ? addresses.CoreGovernance24Beacon : addresses.PortfolioGovernance24Beacon };
  if (name === 'FlexiblePurchase' || name === 'Governance24Validation') {
    need(code.startsWith(`73${'0'.repeat(40)}`), 'Library self-address prefix is missing.');
    code = `73${address(deployedAddress).slice(2).toLowerCase()}${code.slice(42)}`;
  }
  for (const [id, positions] of Object.entries(artifact.immutableReferences ?? {})) {
    need(Array.isArray(positions) && positions.length > 0, 'Empty immutable references.');
    const binding = address(bindings[artifact.immutableBindings[id]]);
    for (const { start, length } of positions) {
      need(Number.isSafeInteger(start) && start >= 0 && length === 32 && (start + length) * 2 <= code.length
        && artifact.deployedBytecode.slice(2 + start * 2, 2 + (start + length) * 2) === '0'.repeat(64), 'Invalid compiler immutable location.');
      for (let at = start; at < start + length; at++) { need(!occupied.has(at), 'Overlapping bytecode bindings.'); occupied.add(at); }
      code = code.slice(0, start * 2) + binding.slice(2).toLowerCase().padStart(64, '0') + code.slice((start + length) * 2);
    }
  }
  need((code.length / 2) <= 24576, 'Runtime exceeds EIP-170.');
  return `0x${code}`;
}

/** Follow actual addresses, including old Funds linked inside an unchanged FirstoSale implementation. */
export function governance24LinkedAddressClosure(predecessor,predecessorInput) {
  const nodes=predecessor.catalog.nodes,genesis=predecessorInput?.genesisRecord?.addresses,genesisBundle=predecessorInput?.genesisBundle;
  const found=new Map();
  function visit(name,at,parent) {
    const key=`${name}:${at.toLowerCase()}`;
    if(found.has(key)){const row=found.get(key);if(!row.parents.includes(parent))row.parents.push(parent);return;}
    let node=Object.values(nodes).find(candidate=>same(candidate.address,at)&&candidate.artifact.contractName===name),source='reviewed-current-node';
    if(!node){
      need(genesis&&genesisBundle&&same(genesis[name],at),`Linked ${name} address is outside the independently reviewed current/genesis graphs.`);
      const artifact=genesisBundle.artifacts[name];need(artifact?.contractName===name,`Missing historical ${name} artifact.`);
      const dependencies=Object.values(artifact.deployedLinkReferences ?? {}).flatMap(libs=>Object.keys(libs));
      node={address:at,artifact,links:Object.fromEntries(dependencies.map(dep=>[dep,genesis[dep]])),immutableAddress:null};source='trusted-genesis-artifact';
    }
    const runtime=reviewedUpgradeBytecode.expectedRuntime(node.artifact,node.links,at,node.immutableAddress);
    const row={name,address:at,parents:[parent],source,runtime,codehash:keccak256(runtime)};found.set(key,row);
    for(const [dependency,dependencyAddress]of Object.entries(node.links ?? {}))visit(dependency,dependencyAddress,`${name}@${at.toLowerCase()}`);
  }
  for(const [parent,node]of Object.entries(nodes))for(const [dependency,at]of Object.entries(node.links ?? {}))visit(dependency,at,parent);
  return [...found.values()].map(row=>({...row,parents:row.parents.sort()})).sort((a,b)=>`${a.name}:${a.address.toLowerCase()}`.localeCompare(`${b.name}:${b.address.toLowerCase()}`));
}

/** A fixed coverage ledger states where linked dependencies change and where 48h recovery remains. */
export function governance24Coverage(predecessor,predecessorInput) {
  const nodes = predecessor.catalog.nodes;
  const upgraded = { PoolVault: 'CoreGovernance24Beacon', BudgetPortfolioVault: 'PortfolioGovernance24Beacon',
    factory: 'PoolTimelock24', portfolioFactory: 'PoolTimelock24', shareMarket: 'PoolTimelock24', portfolioShareMarket: 'PoolTimelock24' };
  const rows = Object.keys(nodes).sort().map(name => ({ name, address: nodes[name].address,
    treatment: upgraded[name] ? 'business-path-24h' : ['timelock','beacon','portfolioBeacon'].includes(name)
      ? 'legacy-recovery-48h' : name === 'lens' || name === 'AtomicDeployment' ? 'fixed-helper-preserved'
        : Object.values(nodes).some(node => Object.keys(node.links ?? {}).includes(name)) ? 'linked-library-fixed-address' : 'historical-implementation-preserved',
    updateVia: upgraded[name] ?? (Object.values(nodes).some(node => Object.keys(node.links ?? {}).includes(name)) ? 'redeploy-linked-parent-through-24h-business-route' : null),
    parents: Object.keys(nodes).filter(parent => Object.keys(nodes[parent].links ?? {}).includes(name)).sort() }));
  rows.push({ name: 'PlatformAuthority', address: predecessor.catalog.authority.address, treatment: 'owner-24h', updateVia: 'PoolTimelock24', parents: [] });
  rows.push({ name: 'Governance24Validation', address: null, treatment: 'linked-library-new-fixed-address',
    updateVia: 'four-parent-UUPS-24h', parents: ['Governance24FreshPoolFactory','Governance24BudgetPortfolioFactory','CoreGovernance24ShareMarket','PortfolioGovernance24ShareMarket'] });
  const introductions=governance24UpgradeDeploymentOrder.map(name=>({name,artifact:governance24ArtifactNames[name],
    treatment:name==='PoolTimelock24'?'24h-proposer-canceller-public-executor':name==='Governance24Validation'||name==='FlexiblePurchase'
      ?'fixed-linked-library-parent-updates':name.endsWith('Dispatcher')?'immutable-dispatch-through-original-48h-beacon':name.endsWith('Beacon')
        ?'secondary-business-beacon-owned-by-24h-lock':'business-implementation-updated-via-24h-lock',
    libraries:linkPolicy[governance24ArtifactNames[name]]}));
  const linkedAddressClosure=governance24LinkedAddressClosure(predecessor,predecessorInput).map(({runtime,...row})=>({...row,treatment:'fixed-linked-address-redeploy-parent-via-24h-business-route'}));
  return { scope: 'current-business-paths-24h-with-48h-legacy-recovery', rows, introductions,linkedAddressClosure,
    externalDependencies:[['FirstoExchange',predecessor.protocol.exchange],['Mining','0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46'],
      ['BEM','0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a'],['Tapeout NFT','0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C'],
      ['Behemoth NFT','0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C'],['CircuitMarket','0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f'],
      ['WBNB','0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c']].map(([name,address])=>({name,address,treatment:'external-asset-or-protocol-outside-platform-governance'})) };
}

/** Conservatively classify every original pending call; retained beacon recovery may never silently undo dispatch. */
export function governance24PendingOperationEffects(predecessor, pendingOperations) {
  const a=predecessor.addresses,proxies=[a.factory,a.portfolioFactory,a.shareMarket,a.portfolioShareMarket];
  return pendingOperations.map(op=>{
    const calls=op.mode === 'single' ? [{target:op.target,value:op.value,data:op.data}]
      : op.targets.map((target,index)=>({target,value:op.values[index],data:op.payloads[index]}));
    const effects=calls.map(call=>{
      if ([a.beacon,a.portfolioBeacon].some(to=>same(to,call.target))) return {...call,effect:'legacy-beacon-can-overwrite-dispatcher',conflict:true};
      if (same(a.timelock,call.target)) return {...call,effect:'legacy-governance-self-call',conflict:true};
      if (proxies.some(to=>same(to,call.target))) {
        try {
          const parsed=actions.decodeFunctionData('upgradeToAndCall',call.data);
          if (same(actions.encodeFunctionData('upgradeToAndCall',parsed),call.data) && BigInt(call.value) === 0n)
            return {...call,effect:'stale-uups-inert-after-governance-migration',conflict:false};
        } catch {}
      }
      return {...call,effect:'unreviewed-live-pending-call',conflict:true};
    });
    // A batch containing an inert UUPS call must revert atomically after migration. It cannot overwrite a beacon.
    const atomicInert=op.mode === 'batch' && effects.some(effect=>effect.effect === 'stale-uups-inert-after-governance-migration');
    return {operationId:op.operationId,mode:op.mode,effects,conflict:atomicInert ? false : effects.some(effect=>effect.conflict),
      classification:atomicInert ? 'entire-batch-inert-after-migration' : effects.some(effect=>effect.conflict) ? 'conflicting-retained-operation' : 'inert-after-migration'};
  });
}

export function validateGovernance24UpgradeReview(input) {
  const cached=reviewCache.get(input);if(cached)return cached;
  const prior = validateFirstoBatchUpgradeReview(input.predecessorInput), catalog = input.reviewCatalog;
  need(HASH.test(input.trustedReviewCatalogDigest ?? '') && same(evidenceDigest(catalog), input.trustedReviewCatalogDigest), 'Governance review differs from its independent pin.');
  need(catalog?.schemaVersion === 1 && catalog.kind === GOVERNANCE24_REVIEW_KIND && catalog.chainId === 56
    && catalog.profile === prior.catalog.profile && HASH.test(input.trustedPredecessorInputDigest ?? '')
    && same(catalog.predecessorInputDigest, input.trustedPredecessorInputDigest)
    && same(catalog.predecessorInputDigest, evidenceDigest(input.predecessorInput))
    && same(catalog.candidateArtifactDigest, input.trustedUpgradeArtifactDigest)
    && same(buildDigest(input.upgradeBundle), input.trustedUpgradeArtifactDigest), 'Governance predecessor or candidate artifact pin differs.');
  need(Number.isSafeInteger(catalog.anchor?.blockNumber) && catalog.anchor.blockNumber >= prior.catalog.anchor.blockNumber
    && HASH.test(catalog.anchor.blockHash ?? ''), 'Current governance review anchor is missing.');
  need(evidenceDigest(catalog.coverage) === evidenceDigest(governance24Coverage(prior,input.predecessorInput)), 'Governance coverage inventory is incomplete or differs.');
  need(evidenceDigest(catalog.bindings) === evidenceDigest(prior.catalog.bindings), 'Governance preserved bindings differ.');
  need(Array.isArray(catalog.pendingOperations) && Array.isArray(catalog.preservation?.corePools)
    && Array.isArray(catalog.preservation?.portfolioPools) && catalog.preservation?.storage && typeof catalog.preservation.storage === 'object', 'Pinned pending operations and pool preservation inventory are required.');
  const operationIds = new Set();
  for (const op of catalog.pendingOperations) {
    need(same(op.timelock, prior.addresses.timelock) && ['single','batch'].includes(op.mode) && HASH.test(op.operationId ?? '')
      && HASH.test(op.predecessor ?? '') && HASH.test(op.salt ?? '') && /^[1-9]\d*$/.test(op.timestamp ?? '') && BigInt(op.timestamp) > 1n, 'Pending original 48-hour operation is incomplete.');
    const types = op.mode === 'single' ? ['address','uint256','bytes','bytes32','bytes32'] : ['address[]','uint256[]','bytes[]','bytes32','bytes32'];
    const values = op.mode === 'single' ? [address(op.target), BigInt(op.value), op.data, op.predecessor, op.salt]
      : [op.targets.map(address), op.values.map(BigInt), op.payloads, op.predecessor, op.salt];
    need(op.mode !== 'batch' || op.targets.length > 0 && op.targets.length === op.values.length && op.values.length === op.payloads.length, 'Incomplete pending batch.');
    need(same(keccak256(AbiCoder.defaultAbiCoder().encode(types, values)), op.operationId)
      && !operationIds.has(op.operationId.toLowerCase()), 'Pending operation identity differs or repeats.'); operationIds.add(op.operationId.toLowerCase());
  }
  const fake = { ...prior.addresses, proposer: prior.catalog.bindings.proposer };
  for (const name of governance24UpgradeDeploymentOrder) fake[name] = '0x0000000000000000000000000000000000001111';
  for (const name of governance24UpgradeDeploymentOrder) {
    const artifact = artifactFor(input, name), args = constructors(name, fake, prior.catalog.bindings.proposer);
    const initcode = linked(artifact.bytecode, artifact.linkReferences, fake, artifact.contractName)
      + new Interface(artifact.abi).encodeDeploy(args).slice(2);
    need(HEX.test(initcode) && (initcode.length - 2) / 2 <= 49152, 'Deployment exceeds EIP-3860.');
    governance24ExpectedRuntime(artifact, fake, fake[name], name);
  }
  const result={ predecessor: prior, catalog, addresses: prior.addresses, proposer: address(prior.catalog.bindings.proposer), deployer: address(prior.catalog.deployer),
    pendingOperationEffects:governance24PendingOperationEffects(prior,catalog.pendingOperations),
    linkedAddressClosure:governance24LinkedAddressClosure(prior,input.predecessorInput) };
  if(safeInputs.has(input)){freeze(result);reviewCache.set(input,result);}return result;
}
function addPrefix(input, review, deploymentsPrefix, full) {
  const names = governance24UpgradeDeploymentOrder.slice(0, Object.keys(deploymentsPrefix).length);
  exact(deploymentsPrefix, full ? governance24UpgradeDeploymentOrder : names, 'Only the exact confirmed dependency prefix is permitted.');
  const addresses = { ...review.addresses, proposer: review.proposer }, used = new Set([...Object.values(addresses), review.predecessor.catalog.authority.address].map(a => a.toLowerCase()));
  for (const name of names) {
    const value = address(typeof deploymentsPrefix[name] === 'string' ? deploymentsPrefix[name] : deploymentsPrefix[name]?.address);
    need(!used.has(value.toLowerCase()), 'Replacement reuses a preserved graph or replacement address.'); used.add(value.toLowerCase()); addresses[name] = value;
  }
  return addresses;
}
function deployment(name, input, review, addresses, deployedAddress = null) {
  const artifact = artifactFor(input, name), constructorArgs = constructors(name, addresses, review.proposer);
  const data = linked(artifact.bytecode, artifact.linkReferences, addresses, artifact.contractName)
    + new Interface(artifact.abi).encodeDeploy(constructorArgs).slice(2);
  need((data.length - 2) / 2 <= 49152, 'Deployment exceeds EIP-3860.');
  const libraries = Object.fromEntries(linkPolicy[artifact.contractName].map(key => [key, addresses[key]]));
  return { name, artifactName: artifact.contractName, constructorArgs, libraries, value: '0', data,
    ...(deployedAddress ? { address: deployedAddress, expectedRuntime: governance24ExpectedRuntime(artifact, addresses, deployedAddress, name),
      codehash: keccak256(governance24ExpectedRuntime(artifact, addresses, deployedAddress, name)) } : {}) };
}
function cancellationInventory(review) {
  const conflicts=review.pendingOperationEffects.filter(op=>op.conflict);
  const covered=op=>op.effects.every(effect=>{
    if(effect.effect!=='legacy-beacon-can-overwrite-dispatcher')return false;
    try {const parsed=actions.decodeFunctionData('upgradeTo',effect.data);return same(actions.encodeFunctionData('upgradeTo',parsed),effect.data)&&BigInt(effect.value)===0n;}catch{return false;}
  });
  need(conflicts.every(covered),'Unreviewed pending governance operation is outside this business release; obtain explicit independent review before migration.');
  return conflicts.map(op=>({id:`cancel-${op.operationId.toLowerCase()}`,name:'取消已被本次完整升级覆盖的旧排程',operationId:op.operationId,
    to:review.addresses.timelock,value:'0',data:actions.encodeFunctionData('cancel',[op.operationId]),unsigned:true,
    originalOperation:review.catalog.pendingOperations.find(original=>same(original.operationId,op.operationId)),effects:op.effects}));
}
export function governance24Cancellations(input) {return cancellationInventory(validateGovernance24UpgradeReview(input));}
export function prepareGovernance24UpgradeDeployment(name, input, { deploymentsPrefix = {} } = {}) {
  const review = validateGovernance24UpgradeReview(input), index = governance24UpgradeDeploymentOrder.indexOf(name);
  need(index >= 0, 'Unknown governance deployment.');
  exact(deploymentsPrefix, governance24UpgradeDeploymentOrder.slice(0, index), 'Only the exact confirmed dependency prefix is permitted.');
  const addresses = addPrefix(input, review, deploymentsPrefix, false);
  return { ...deployment(name, input, review, addresses), to: null, unsigned: true, deployer: review.deployer,
    baselineVerified: false, replacementDeploymentVerified: false };
}
export function buildGovernance24UpgradePlan(input) {
  const review = validateGovernance24UpgradeReview(input), a = addPrefix(input, review, input.replacements ?? {}, true);
  const cancellations=cancellationInventory(review);
  need(HASH.test(input.salt ?? '') && !same(input.salt, ZeroHash), 'A unique nonzero migration salt is required.');
  need(Number.isSafeInteger(input.delaySeconds) && input.delaySeconds >= 172800, 'The initial migration requires the full original 48-hour delay.');
  const migration = actions.encodeFunctionData('migrateGovernance24', [a.timelock, a.PoolTimelock24]);
  const targets = [a.beacon, a.portfolioBeacon, a.factory, a.portfolioFactory, a.shareMarket, a.portfolioShareMarket, review.predecessor.catalog.authority.address];
  const implementations = [a.CoreGovernance24Dispatcher, a.PortfolioGovernance24Dispatcher, a.Governance24FreshPoolFactory,
    a.Governance24BudgetPortfolioFactory, a.CoreGovernance24ShareMarket, a.PortfolioGovernance24ShareMarket, null];
  const payloads = implementations.map((impl, index) => index < 2 ? actions.encodeFunctionData('upgradeTo', [impl])
    : index < 6 ? actions.encodeFunctionData('upgradeToAndCall', [impl, migration])
      : actions.encodeFunctionData('transferOwnership', [a.PoolTimelock24]));
  const values = targets.map(() => '0'), args = [targets, values, payloads, ZeroHash, input.salt];
  const operationId = keccak256(AbiCoder.defaultAbiCoder().encode(['address[]','uint256[]','bytes[]','bytes32','bytes32'], args));
  need(!review.catalog.pendingOperations.some(op => same(op.operationId, operationId)), 'Migration collides with a preserved pending operation.');
  const scheduleData = governance24BatchAbi.encodeFunctionData('scheduleBatch', [...args, input.delaySeconds]);
  const executeData = governance24BatchAbi.encodeFunctionData('executeBatch', args);
  return { kind: GOVERNANCE24_UPGRADE_KIND, chainId: 56, unsigned: true, reviewCatalogDigest: input.trustedReviewCatalogDigest,
    upgradeArtifactDigest: input.trustedUpgradeArtifactDigest, predecessorInputDigest: review.catalog.predecessorInputDigest,
    replacements: Object.fromEntries(governance24UpgradeDeploymentOrder.map(name => [name, a[name]])), timelock: a.timelock,
    nextTimelock: a.PoolTimelock24, value: '0', predecessor: ZeroHash, salt: input.salt, delaySeconds: input.delaySeconds,
    targets, values, payloads, operationId, scheduleData, executeData,
    schedule: { to: a.timelock, value: '0', data: scheduleData }, execute: { to: a.timelock, value: '0', data: executeData },
    steps: targets.map((target, index) => ({ name: governance24ActionIds[index], target, value: '0', data: payloads[index], implementation: implementations[index] })),
    deployments: governance24UpgradeDeploymentOrder.map(name => deployment(name, input, review, a, a[name])),
    coverage: review.catalog.coverage, preservedPendingOperations: review.catalog.pendingOperations,pendingOperationEffects:review.pendingOperationEffects,cancellations,
    currentChainStateVerified: false, replacementDeploymentVerified: false, saltUniquenessVerified: false };
}
