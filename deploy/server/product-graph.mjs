import { lstatSync, readFileSync } from 'node:fs';
import { Interface, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { SHARE_FEE_UPGRADE_KIND, upgradeNamesForKind, settleReads, validateFirstoUpgradeRecord, verifyFirstoUpgradeProof, evidenceDigest } from '../shared/firsto-upgrade-proof.mjs';
import {
  buildIntegratedUpgradePlan, buildIntegratedProposerBootstrapPlan, buildIntegratedRoleMigrationPlan,
  integratedUpgradeDeploymentOrder, validateIntegratedPostCodeGraphAgainstChain,
  validateIntegratedRoleMigrationStateAgainstChain,
} from '../shared/integrated-upgrade-plan.mjs';

const HASH = /^0x[\da-f]{64}$/i;
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ZERO = `0x${'0'.repeat(40)}`;
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const check = (condition, message) => { if (!condition) throw new Error(message); };
const LIBRARIES = ['FlexiblePurchase','MiningOperations','PoolFunds','PurchaseValidation','RewardAccounting','SaleGovernance','SaleSettlement','ShareCheckpoints'];
const NAMES = [...LIBRARIES,'AtomicDeployment','PoolVault','PoolFactory','ShareMarket','factory','shareMarket','lens','beacon','timelock'];
const INTEGRATED_NAMES = [...NAMES,'FirstoSale','BudgetPortfolioFactory','BudgetPortfolioVault','portfolioFactory','portfolioShareMarket','portfolioBeacon'];
const artifacts = { factory:'ERC1967Proxy',shareMarket:'ERC1967Proxy',lens:'PoolLens',beacon:'PoolBeacon',timelock:'PoolTimelock',
  portfolioFactory:'ERC1967Proxy',portfolioShareMarket:'ERC1967Proxy',portfolioBeacon:'PoolBeacon' };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
function digest(bundle) { const {sourceCommit: _source,...content}=bundle; return keccak256(toUtf8Bytes(JSON.stringify(canonical(content)))); }
function load(path) {
  check(!lstatSync(path).isSymbolicLink(), 'Trusted deployment evidence cannot be a symlink.');
  return JSON.parse(readFileSync(path,'utf8'));
}
function linked(code, references, addresses) {
  let result = code.slice(2);
  for (const [source,libraries] of Object.entries(references ?? {})) for (const [name,locations] of Object.entries(libraries)) {
    const address=getAddress(addresses[`${source}:${name}`] ?? addresses[name]).slice(2).toLowerCase();
    for (const {start,length} of locations) {
      check(length===20 && start>=0 && (start+length)*2<=result.length,'Invalid library link.');
      result=result.slice(0,start*2)+address+result.slice((start+length)*2);
    }
  }
  check(/^[\da-f]+$/i.test(result) && result.length%2===0,'Unresolved trusted artifact.');
  return result.toLowerCase();
}
function runtimeMatches(artifact, observed, addresses, ownAddress) {
  let expected=linked(artifact.deployedBytecode,artifact.deployedLinkReferences,addresses), actual=observed.slice(2).toLowerCase();
  if (expected.length!==actual.length) return false;
  if ([...LIBRARIES,'FirstoSale'].includes(artifact.contractName) && expected.startsWith(`73${'0'.repeat(40)}`)) expected=`73${ownAddress.slice(2).toLowerCase()}${expected.slice(42)}`;
  for (const locations of Object.values(artifact.immutableReferences ?? {})) for (const {start,length} of locations) {
    if(start<0 || length<=0 || (start+length)*2>expected.length)return false;
    expected=expected.slice(0,start*2)+'0'.repeat(length*2)+expected.slice((start+length)*2);
    actual=actual.slice(0,start*2)+'0'.repeat(length*2)+actual.slice((start+length)*2);
  }
  return expected===actual;
}

/** Evidence is operator-owned local data; never accept it from an API caller. */
export function productGraphConfiguration({ recordPath, bundlePath, record, bundle,
  genesisRecordPath, genesisBundlePath, genesisRecord, genesisBundle,
  integratedUpgradeEvidencePath, integratedUpgradeEvidence, integratedUpgradeArtifactPath,
  integratedUpgradeArtifact, genesisManifestPath, genesisManifest }={}) {
  if (!record && !recordPath) return null;
  record ??= load(recordPath); bundle ??= load(bundlePath);
  if (record?.schemaVersion === 2) {
    check(genesisRecord || genesisRecordPath,'Upgrade requires an independently configured local genesis record.');
    check(genesisBundle || genesisBundlePath,'Upgrade requires the preserved local genesis artifact bundle.');
    genesisRecord ??= load(genesisRecordPath); genesisBundle ??= load(genesisBundlePath);
    check(genesisRecord?.schemaVersion === 1,'Only a schema1 genesis can anchor this fixed upgrade.');
    productGraphConfiguration({record:genesisRecord,bundle:genesisBundle});
    const addresses=validateFirstoUpgradeRecord(record,genesisRecord,genesisBundle,bundle);
    const normalized={...genesisRecord,schemaVersion:2,addresses,artifactDigest:record.artifactDigest,
      sourceCommit:bundle.sourceCommit,verification:{...record.verification,code:genesisRecord.verification.code}};
    return JSON.parse(JSON.stringify({record:normalized,bundle,upgradeRecord:record,genesisRecord,genesisBundle}));
  }
  const integrated=record?.kind==='integrated-v2';
  check(record?.schemaVersion===1 && (record.kind===undefined || integrated) && record.chainId===56 && record.status==='complete'
    && record.steps?.length===(integrated ? 16 : 13) && record.steps.every(step=>step.status==='confirmed')
    && record.steps.some(step=>step.id==='initialize' && step.receipt?.status===1 && HASH.test(step.txHash))
    && HASH.test(record.artifactDigest) && same(digest(bundle),record.artifactDigest)
    && record.verification?.checks?.length>0 && record.verification.checks.every(item=>item.passed),
  'Trusted product deployment is not a completed, verified deployment of this build.');
  if (integrated) check(record.input?.governanceMode==='single'
    && same(record.addresses.portfolioVaultImplementation,record.addresses.BudgetPortfolioVault)
    && same(record.addresses.portfolioFactoryImplementation,record.addresses.BudgetPortfolioFactory),'Portfolio implementation aliases differ.');
  for (const name of integrated ? INTEGRATED_NAMES : NAMES) {
    const address=getAddress(record.addresses[name]), code=record.verification.code[name];
    check(same(address,code?.address) && HASH.test(code?.codehash ?? ''),`Missing trusted code evidence for ${name}.`);
    check(bundle.artifacts[artifacts[name] ?? name],`Missing trusted artifact for ${name}.`);
  }
  if (integratedUpgradeEvidence || integratedUpgradeEvidencePath) {
    check(integrated, 'Only an integrated-v2 genesis may anchor this security upgrade.');
    check(integratedUpgradeArtifact || integratedUpgradeArtifactPath,
      'A separate candidate artifact bundle is required for the integrated upgrade.');
    check(genesisManifest || genesisManifestPath,
      'The preserved genesis manifest is required for the integrated upgrade.');
    const evidence=integratedUpgradeEvidence ?? load(integratedUpgradeEvidencePath);
    const candidate=integratedUpgradeArtifact ?? load(integratedUpgradeArtifactPath);
    const manifest=genesisManifest ?? load(genesisManifestPath);
    const candidateDigest=digest(candidate);
    const plan=buildIntegratedUpgradePlan({genesisRecord:record,genesisBundle:bundle,
      trustedGenesisManifest:manifest,upgradeBundle:candidate,trustedUpgradeArtifactDigest:candidateDigest,
      replacements:evidence?.plan?.replacements,salt:evidence?.plan?.salt,
      delaySeconds:evidence?.plan?.delaySeconds});
    check(evidenceDigest(plan)===evidenceDigest(evidence.plan),
      'Integrated upgrade plan differs from the reviewed server evidence.');
    const bootstrap=buildIntegratedProposerBootstrapPlan({genesisRecord:record,genesisBundle:bundle,
      trustedGenesisManifest:manifest,hardwareWallet:evidence?.bootstrapPlan?.hardwareWallet,
      salt:evidence?.bootstrapPlan?.salt,delaySeconds:evidence?.bootstrapPlan?.delaySeconds});
    check(evidenceDigest(bootstrap)===evidenceDigest(evidence.bootstrapPlan),
      'Integrated hardware-wallet bootstrap differs from reviewed evidence.');
    const codeExecuteTxHash=evidence.codeExecuteTxHash ?? null;
    check(codeExecuteTxHash===null || HASH.test(codeExecuteTxHash),
      'Integrated code execution hash is malformed.');
    let rolePlan=null,authority=null;
    if (evidence.rolePlan) {
      rolePlan=buildIntegratedRoleMigrationPlan({genesisRecord:record,codePlan:plan,bootstrapPlan:bootstrap,
        authorityAddress:evidence.rolePlan.authorityAddress,hardwareWallet:evidence.rolePlan.hardwareWallet,
        salt:evidence.rolePlan.salt,delaySeconds:evidence.rolePlan.delaySeconds});
      check(evidenceDigest(rolePlan)===evidenceDigest(evidence.rolePlan),
        'Integrated role plan differs from reviewed evidence.');
      authority=evidence.authority;
      check(authority && same(authority.address,rolePlan.authorityAddress)
        && HASH.test(authority.deploymentTxHash),
      'Integrated Authority requires a reviewed deployment transaction.');
      // These two public addresses were selected by the operator. A changed
      // administrator or relay address requires a new, independently reviewed release.
      check(same(authority.administratorOne,'0x7674fa446D42b1f7f150DC5e678cc525d275Ea53')
        && same(authority.administratorTwo,'0xeD2FCBe59EBe1754a3676aeb9CcfBA20f193FcbB'),
      'Integrated Authority administrators differ from the approved addresses.');
      getAddress(authority.gasWallet);
    }
    return JSON.parse(JSON.stringify({record,bundle,integratedUpgrade:{plan,bootstrapPlan:bootstrap,
      rolePlan,authority,codeExecuteTxHash,bundle:candidate,genesisManifest:manifest,digest:candidateDigest}}));
  }
  // Defensive clone: consumers cannot modify the trusted evidence through a browser record.
  return JSON.parse(JSON.stringify({record,bundle}));
}

/** Fresh pinned-block graph and linked runtime verification before every product signing permission. */
export async function verifyProductGraph(provider, factory, trusted, block) {
  check(trusted?.record && trusted?.bundle,'Trusted product deployment evidence is unavailable.');
  const {record,bundle}=trusted, tag=`0x${block.number.toString(16)}`;
  const integrated=record.kind==='integrated-v2';
  const security=trusted.integratedUpgrade;
  let a=record.addresses, candidateActive=false, roleState=null, finalizedProof=null;
  if (security) {
    const current=await provider.getStorage(a.factory,SLOT,block.number);
    check(/^0x0{24}[\da-f]{40}$/i.test(current),'Invalid current Factory implementation slot.');
    const implementation=`0x${current.slice(-40)}`;
    if (same(implementation,security.plan.replacements.PoolFactory)) {
      const input={genesisRecord:record,genesisBundle:bundle,
        trustedGenesisManifest:security.genesisManifest,upgradeBundle:security.bundle,
        trustedUpgradeArtifactDigest:security.digest,bootstrapPlan:security.bootstrapPlan,
        ...(security.authority ? {authorityAddress:security.authority.address,
          deploymentTxHash:security.authority.deploymentTxHash,
          administratorOne:security.authority.administratorOne,
          administratorTwo:security.authority.administratorTwo,
          gasWallet:security.authority.gasWallet} : {})};
      if (security.rolePlan) roleState=finalizedProof=await validateIntegratedRoleMigrationStateAgainstChain(provider,
        security.rolePlan,{...input,codePlan:security.plan});
      else finalizedProof=await validateIntegratedPostCodeGraphAgainstChain(provider,security.plan,input);
      a={...a,...security.plan.replacements};
      candidateActive=true;
    } else check(same(implementation,a.PoolFactory),
      'Factory implementation is neither the reviewed genesis nor the reviewed upgrade.');
  }
  const budget=integrated && same(factory,a.portfolioFactory);
  check(same(factory,a.factory) || budget,'Factory differs from the trusted deployment.');
  const upgradeProof=trusted.upgradeRecord ? await verifyFirstoUpgradeProof(provider,trusted,block) : null;
  const upgradedNames=candidateActive ? integratedUpgradeDeploymentOrder
    : trusted.upgradeRecord ? upgradeNamesForKind(trusted.upgradeRecord.kind) : [];
  const sourceFor=name=>candidateActive ? upgradedNames.includes(name) ? security.bundle : bundle
    : trusted.upgradeRecord && !upgradedNames.includes(name) ? trusted.genesisBundle : bundle;
  const runtimeLinksFor=name=>candidateActive && !upgradedNames.includes(name) ? record.addresses
    : trusted.upgradeRecord && !upgradedNames.includes(name) ? trusted.genesisRecord.addresses : a;
  const read=async(name,method,args=[])=>{
    const artifactName=({factory:'PoolFactory',shareMarket:'ShareMarket',portfolioFactory:'BudgetPortfolioFactory',portfolioShareMarket:'ShareMarket'})[name] ?? artifacts[name] ?? name;
    const iface=new Interface(sourceFor(artifactName).artifacts[artifactName].abi);
    return iface.decodeFunctionResult(method,await provider.send('eth_call',[{to:a[name],data:iface.encodeFunctionData(method,args)},tag]))[0];
  };
  const observedCodehash={};
  await settleReads((integrated ? INTEGRATED_NAMES : NAMES).map(async name=>{
    const code=await provider.getCode(a[name],block.number);
    const upgraded=(candidateActive || trusted.upgradeRecord) && upgradedNames.includes(name);
    // The common proof checked replacement bytes at a finalized block. Compare
    // their complete hash again at the signing block, including immutables;
    // artifact shape matching alone masks constructor immutable values.
    const finalizedCode=candidateActive && upgraded
      ? await provider.getCode(a[name],finalizedProof.blockNumber) : null;
    check(code!=='0x' && (upgraded || same(keccak256(code),record.verification.code[name].codehash))
      && (!finalizedCode || same(keccak256(code),keccak256(finalizedCode)))
      && runtimeMatches(sourceFor(name).artifacts[artifacts[name] ?? name],code,runtimeLinksFor(name),a[name]),`Reviewed runtime changed: ${name}.`);
    observedCodehash[name]=keccak256(code);
  }));
  const currentRoles=roleState?.current;
  const assertions=[['AtomicDeployment','deployed',true],['AtomicDeployment','deployer',record.account],
    ['AtomicDeployment','predictedFactory',a.factory],['factory','owner',currentRoles?.coreOwner ?? record.input.ownerMultisig],
    ['factory','operator',currentRoles?.coreOperator ?? record.input.operator],
    ['factory','treasury',currentRoles?.coreTreasury ?? record.input.treasury],
    ['factory','lens',a.lens],['factory','shareMarket',a.shareMarket],['factory','beacon',a.beacon],['factory','timelock',a.timelock],
    ['lens','factory',a.factory],['lens','VERSION',1n],['shareMarket','factory',a.factory],['shareMarket','timelock',a.timelock],
    ['shareMarket','feeBps',100n],['beacon','owner',a.timelock],['beacon','implementation',a.PoolVault],
    ['beacon','OFFICIAL_FACTORY',a.factory],['PoolVault','OFFICIAL_FACTORY',a.factory],
    ['timelock','getMinDelay',172800n],['timelock','MINIMUM_DELAY',172800n]];
  if (trusted.upgradeRecord?.kind === SHARE_FEE_UPGRADE_KIND || integrated) assertions.push(['shareMarket','buyerFeeBps',100n]);
  if (integrated) assertions.push(['AtomicDeployment','predictedPortfolioFactory',a.portfolioFactory],
    ['portfolioFactory','owner',currentRoles?.budgetOwner ?? record.input.ownerMultisig],
    ['portfolioFactory','operator',currentRoles?.budgetOperator ?? record.input.operator],
    ['portfolioFactory','treasury',currentRoles?.budgetTreasury ?? record.input.treasury],['portfolioFactory','timelock',a.timelock],
    ['portfolioFactory','legacyFactory',a.factory],['portfolioFactory','beacon',a.portfolioBeacon],
    ['portfolioFactory','shareMarket',a.portfolioShareMarket],['portfolioShareMarket','factory',a.portfolioFactory],
    ['portfolioShareMarket','timelock',a.timelock],['portfolioShareMarket','feeBps',100n],['portfolioShareMarket','buyerFeeBps',100n],
    ['portfolioBeacon','owner',a.timelock],['portfolioBeacon','implementation',a.BudgetPortfolioVault],
    ['portfolioBeacon','OFFICIAL_FACTORY',a.portfolioFactory],['BudgetPortfolioVault','OFFICIAL_FACTORY',a.portfolioFactory]);
  await settleReads(assertions.map(async([name,method,expected])=>check(String(await read(name,method)).toLowerCase()===String(expected).toLowerCase(),`Reviewed binding changed: ${name}.${method}.`)));
  await settleReads([['factory','PoolFactory'],['shareMarket','ShareMarket'],...(integrated
    ? [['portfolioFactory','BudgetPortfolioFactory'],['portfolioShareMarket','ShareMarket']] : [])].map(async([name,implementation])=>{
    const slot=await provider.getStorage(a[name],SLOT,block.number);
    check(/^0x0{24}[\da-f]{40}$/i.test(slot) && same(`0x${slot.slice(-40)}`,a[implementation]),`Reviewed implementation changed: ${name}.`);
  }));
  const roles=await settleReads(['PROPOSER_ROLE','CANCELLER_ROLE','EXECUTOR_ROLE','DEFAULT_ADMIN_ROLE'].map(name=>read('timelock',name)));
  await settleReads([[roles[0],record.input.ownerMultisig,roleState?.roles?.proposerOld ?? true],
    [roles[1],record.input.ownerMultisig,roleState?.roles?.cancellerOld ?? true],
    [roles[2],ZERO,true],[roles[3],a.timelock,true],[roles[3],record.account,false],[roles[3],a.AtomicDeployment,false]].map(async([role,account,expected])=>
      check(await read('timelock','hasRole',[role,account])===expected,'Reviewed Timelock permissions changed.')));
  if (candidateActive) {
    await settleReads([[roles[0],security.bootstrapPlan.hardwareWallet],
      [roles[1],security.bootstrapPlan.hardwareWallet]].map(async([role,account])=>
      check(await read('timelock','hasRole',[role,account])===true,
        'Reviewed hardware-wallet Timelock permission changed.')));
    check(await read('timelock','isOperationDone',[security.bootstrapPlan.operationId])===true,
      'Reviewed hardware-wallet bootstrap operation is not complete.');
  }
  check((await provider.getBlock(block.number))?.hash===block.hash,'Chain changed during product graph verification.');
  return {factory:budget ? a.portfolioFactory : a.factory,productKind:budget ? 'budget' : 'pool',
    ...(integrated ? {legacyFactory:a.factory,portfolioFactory:a.portfolioFactory} : {}),
    operator:budget ? currentRoles?.budgetOperator ?? record.input.operator
      : currentRoles?.coreOperator ?? record.input.operator,
    artifactDigest:candidateActive ? security.digest : record.artifactDigest,blockNumber:block.number,
    addresses:{...a},codehash:observedCodehash,
    ...(candidateActive ? {securityUpgrade:{operationId:security.plan.operationId,
      roleWiringComplete:roleState?.roleWiringComplete===true,
      roleMigrationStarted:roleState?.applied?.some(Boolean)===true}} : {}),
    ...(upgradeProof ? {upgrade:upgradeProof} : {})};
}
