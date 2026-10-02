import { isFreshActivationWrapper, verifyWrappedFreshActivation } from '../shared/fresh-activation-chain-proof.mjs';
import { lstatSync, readFileSync } from 'node:fs';
import { AbiCoder, Interface, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { SHARE_FEE_UPGRADE_KIND, upgradeNamesForKind, settleReads, validateFirstoUpgradeRecord, verifyFirstoUpgradeProof, evidenceDigest } from '../shared/firsto-upgrade-proof.mjs';
import { validateFreshSalePolicyCatalog, verifyFreshSalePolicy } from '../shared/fresh-sale-policy-proof.mjs';
import { validateFreshNativeSaleCatalog, verifyFreshNativeSale } from '../shared/fresh-native-sale-proof.mjs';
import { validateFreshFactoryReuseCatalog, verifyFreshFactoryReuse, factoryReuseRuntimeMatches } from '../shared/fresh-factory-reuse-proof.mjs';
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
const FRESH_AUTHORITY_STEPS = ['deployAuthority','coreOperator','coreTreasury','budgetOperator','budgetTreasury','coreOwner','budgetOwner'];
const FRESH_ADMINS = ['0x7674fa446D42b1f7f150DC5e678cc525d275Ea53','0xed2fcbe59ebe1754a3676aeb9ccfba20f193fcbb'];
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

/** Match the reviewed Authority runtime while checking its constructor immutables through pinned views. */
export function reviewedAuthorityRuntimeMatches(trusted, observed) {
  const artifact=trusted?.bundle?.artifacts?.PlatformAuthority;
  const address=trusted?.freshAuthority?.authority?.address;
  return Boolean(artifact && address && observed!=='0x'
    && runtimeMatches(artifact,observed,trusted.record.addresses,address));
}

/** Evidence is operator-owned local data; never accept it from an API caller. */
export function productGraphConfiguration({ recordPath, bundlePath, record, bundle,
  genesisRecordPath, genesisBundlePath, genesisRecord, genesisBundle,
  integratedUpgradeEvidencePath, integratedUpgradeEvidence, integratedUpgradeArtifactPath,
  integratedUpgradeArtifact, genesisManifestPath, genesisManifest,
  productActivationPath, productActivation, expectedGasWallet,
  salePolicyCatalogPath, salePolicyCatalog, salePolicyArtifactPath, salePolicyArtifact,
  nativeSaleCatalogPath, nativeSaleCatalog, nativeSaleArtifactPath, nativeSaleArtifact }={}) {
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
  const freshFactory=Boolean(bundle?.artifacts?.FreshPoolFactory);
  check(record?.schemaVersion===1 && (record.kind===undefined || integrated) && record.chainId===56 && record.status==='complete'
    && record.steps?.length===(integrated ? 16 : 13) && record.steps.every(step=>step.status==='confirmed')
    && record.steps.some(step=>step.id==='initialize' && step.receipt?.status===1 && HASH.test(step.txHash))
    && HASH.test(record.artifactDigest) && same(digest(bundle),record.artifactDigest)
    && record.verification?.checks?.length>0 && record.verification.checks.every(item=>item.passed),
  'Trusted product deployment is not a completed, verified deployment of this build.');
  if (integrated) check(record.input?.governanceMode==='single'
    && same(record.addresses.portfolioVaultImplementation,record.addresses.BudgetPortfolioVault)
    && same(record.addresses.portfolioFactoryImplementation,record.addresses.BudgetPortfolioFactory),'Portfolio implementation aliases differ.');
  if (freshFactory) {
    check(record.steps.filter(step=>step.id==='FreshPoolFactory').length===1
      && !record.steps.some(step=>step.id==='PoolFactory')
      && same(record.addresses.FreshPoolFactory,record.verification.code.FreshPoolFactory?.address)
      && HASH.test(record.verification.code.FreshPoolFactory?.codehash ?? '')
      && (!record.addresses.PoolFactory || same(record.addresses.PoolFactory,record.addresses.FreshPoolFactory)),
    'Fresh deployment must contain exactly the reviewed FreshPoolFactory implementation.');
    record={...record,addresses:{...record.addresses,PoolFactory:record.addresses.FreshPoolFactory},
      verification:{...record.verification,code:{...record.verification.code,
        PoolFactory:record.verification.code.FreshPoolFactory}}};
  }
  for (const name of integrated ? INTEGRATED_NAMES : NAMES) {
    const address=getAddress(record.addresses[name]), code=record.verification.code[name];
    check(same(address,code?.address) && HASH.test(code?.codehash ?? ''),`Missing trusted code evidence for ${name}.`);
    check(bundle.artifacts[name==='PoolFactory' && freshFactory ? 'FreshPoolFactory' : artifacts[name] ?? name],
      `Missing trusted artifact for ${name}.`);
  }
  if (freshFactory) check(integrated && record.input?.governanceMode==='single',
    'FreshPoolFactory must be deployed as a complete integrated single-owner graph.');
  if (integratedUpgradeEvidence || integratedUpgradeEvidencePath) {
    check(!productActivation && !productActivationPath,
      'A fresh Authority activation cannot be combined with an old-graph upgrade.');
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
  if (productActivation || productActivationPath) {
    check(integrated && freshFactory && record.input?.governanceMode==='single',
      'Fresh Authority activation requires a completed integrated single-owner deployment.');
    check(typeof expectedGasWallet==='string' && /^0x[\da-f]{40}$/i.test(expectedGasWallet),
      'Fresh Authority requires a separately configured complete Gas wallet public address.');
    const reviewedGasWallet=getAddress(expectedGasWallet);
    check(!same(reviewedGasWallet,ZERO) && !same(reviewedGasWallet,record.account)
      && !FRESH_ADMINS.some(admin=>same(admin,reviewedGasWallet)),
    'Fresh Gas wallet must be separate from deployment and administrator wallets.');
    const evidence=productActivation ?? load(productActivationPath);
    const authority=evidence?.authority;
    check(evidence?.schemaVersion===1 && evidence.kind==='fresh-authority' && evidence.chainId===56
      && evidence.deploymentId===record.id && same(evidence.genesisArtifactDigest,record.artifactDigest)
      && Number.isFinite(Date.parse(evidence.verifiedAt))
      && Array.isArray(evidence.steps) && evidence.steps.length===FRESH_AUTHORITY_STEPS.length
      && evidence.steps.every((step,index)=>step?.id===FRESH_AUTHORITY_STEPS[index]
        && HASH.test(step.txHash) && Number.isSafeInteger(step.blockNumber) && step.blockNumber>0
        && HASH.test(step.blockHash))
      && new Set(evidence.steps.map(step=>step.txHash.toLowerCase())).size===FRESH_AUTHORITY_STEPS.length
      && HASH.test(authority?.deploymentTxHash) && same(authority.deploymentTxHash,evidence.steps[0].txHash)
      && same(authority?.administratorOne,FRESH_ADMINS[0])
      && same(authority?.administratorTwo,FRESH_ADMINS[1])
      && same(authority?.gasWallet,reviewedGasWallet)
      && bundle.artifacts.PlatformAuthority,
    'Fresh Authority evidence does not match the reviewed deployment and seven ordered transactions.');
    const authorityAddress=getAddress(authority.address);
    check(!Object.values(record.addresses).some(value=>same(value,authorityAddress)),
      'Fresh Authority reuses a genesis deployment address.');
    const trusted = JSON.parse(JSON.stringify({record,bundle,freshAuthority:{...evidence,
      authority:{...authority,address:authorityAddress}}}));
    if (salePolicyCatalog || salePolicyCatalogPath || salePolicyArtifact || salePolicyArtifactPath) {
      check((salePolicyCatalog || salePolicyCatalogPath) && (salePolicyArtifact || salePolicyArtifactPath),
        'Sale policy requires both a reviewed local catalog and artifact bundle.');
      trusted.freshSalePolicy = validateFreshSalePolicyCatalog(salePolicyCatalog ?? load(salePolicyCatalogPath),
        salePolicyArtifact ?? load(salePolicyArtifactPath), trusted);
      const reuse = trusted.freshSalePolicy.catalog.factoryReuse;
      if (reuse != null) {
        check(reuse.catalog && reuse.bundle, 'Factory reuse requires its reviewed nested catalog and artifact bundle.');
        trusted.freshFactoryReuse = validateFreshFactoryReuseCatalog(reuse.catalog, reuse.bundle, trusted);
      }
    }
    if (nativeSaleCatalog || nativeSaleCatalogPath || nativeSaleArtifact || nativeSaleArtifactPath) {
      check((nativeSaleCatalog || nativeSaleCatalogPath) && (nativeSaleArtifact || nativeSaleArtifactPath),
        'Native sale requires both a reviewed local catalog and artifact bundle.');
      trusted.freshNativeSale=validateFreshNativeSaleCatalog(nativeSaleCatalog ?? load(nativeSaleCatalogPath),
        nativeSaleArtifact ?? load(nativeSaleArtifactPath),trusted);
    }
    return trusted;
  }
  // Defensive clone: consumers cannot modify the trusted evidence through a browser record.
  check(!salePolicyCatalog && !salePolicyCatalogPath && !salePolicyArtifact && !salePolicyArtifactPath,
    'Sale policy cannot bypass the original fresh activation evidence.');
  check(!nativeSaleCatalog && !nativeSaleCatalogPath && !nativeSaleArtifact && !nativeSaleArtifactPath,
    'Native sale cannot bypass the original fresh activation evidence.');
  return JSON.parse(JSON.stringify({record,bundle}));
}

export async function verifyFreshAuthority(provider,record,bundle,evidence,block) {
  const {authority,steps}=evidence;
  const a=record.addresses, tag=`0x${block.number.toString(16)}`;
  const factory=new Interface(bundle.artifacts.PoolFactory.abi);
  const budget=new Interface(bundle.artifacts.BudgetPortfolioFactory.abi);
  const authorityAbi=new Interface(bundle.artifacts.PlatformAuthority.abi);
  const constructorArgs=[a.factory,a.portfolioFactory,authority.administratorOne,
    authority.administratorTwo,authority.gasWallet];
  const creationData=bundle.artifacts.PlatformAuthority.bytecode
    +AbiCoder.defaultAbiCoder().encode(['address','address','address','address','address'],constructorArgs).slice(2);
  const expected=[
    {to:null,data:creationData},
    {to:a.factory,data:factory.encodeFunctionData('setOperator',[authority.address])},
    {to:a.factory,data:factory.encodeFunctionData('setTreasury',[authority.address])},
    {to:a.portfolioFactory,data:budget.encodeFunctionData('setOperator',[authority.address])},
    {to:a.portfolioFactory,data:budget.encodeFunctionData('setTreasury',[authority.address])},
    {to:a.factory,data:factory.encodeFunctionData('transferOwnership',[a.timelock])},
    {to:a.portfolioFactory,data:budget.encodeFunctionData('transferOwnership',[a.timelock])},
  ];
  const read=await Promise.all(steps.map(async(step,index)=>{
    const [tx,receipt,inclusion]=await Promise.all([
      provider.getTransaction(step.txHash),provider.getTransactionReceipt(step.txHash),
      provider.getBlock(step.blockNumber),
    ]);
    check(tx && receipt && inclusion && receipt.status===1 && receipt.blockNumber===step.blockNumber
      && same(receipt.blockHash,step.blockHash) && same(inclusion.hash,step.blockHash)
      && step.blockNumber<=block.number && same(tx.hash,step.txHash)
      && same(tx.from,record.account) && tx.value===0n
      && (index===0 ? same(receipt.contractAddress,authority.address) : receipt.contractAddress===null),
    `Fresh Authority transaction ${step.id} differs from the finalized reviewed action.`);
    if(index>0 && isFreshActivationWrapper(tx)){
      const activation={schemaVersion:1,kind:'fresh-authority',chainId:56,account:record.account,
        authorityAddress:authority.address,genesis:{factory:a.factory,portfolioFactory:a.portfolioFactory,timelock:a.timelock},steps};
      const plannedStep={...step,nonce:tx.nonce,dataHash:keccak256(expected[index].data)};
      // Historical receipts remain independently checkable after RPC state
      // pruning. The complete current graph is verified by verifyProductGraph;
      // this proves the immutable role transition, not a past account runtime.
      await verifyWrappedFreshActivation(provider,activation,plannedStep,tx,receipt,{historicalPrefix:false});
    } else check((expected[index].to===null?tx.to===null:same(tx.to,expected[index].to))
      && same(tx.data,expected[index].data),`Fresh Authority transaction ${step.id} has an unreviewed envelope.`);
    return {step,tx,receipt};
  }));
  check(read.every((item,index)=>index===0 || item.step.blockNumber>=read[index-1].step.blockNumber
      && item.tx.nonce>read[index-1].tx.nonce
      && (item.step.blockNumber>read[index-1].step.blockNumber
        || item.tx.index>read[index-1].tx.index))
    && steps.at(-1).blockNumber<=block.number,
  'Fresh Authority actions are not ordered before the finalized proof block.');
  const code=await provider.getCode(authority.address,block.number);
  check(code!=='0x' && runtimeMatches(bundle.artifacts.PlatformAuthority,code,a,authority.address),
    'Fresh Authority runtime differs from the reviewed artifact.');
  const call=async method=>authorityAbi.decodeFunctionResult(method,await provider.send('eth_call',[
    {to:authority.address,data:authorityAbi.encodeFunctionData(method)},tag]))[0];
  const [owner,core,budgetAddress,adminOne,adminTwo,gasWallet,domainRaw]=await Promise.all([
    call('owner'),call('coreFactory'),call('budgetFactory'),call('administratorOne'),
    call('administratorTwo'),call('gasWallet'),provider.send('eth_call',[
      {to:authority.address,data:authorityAbi.encodeFunctionData('eip712Domain')},tag]),
  ]);
  const domain=authorityAbi.decodeFunctionResult('eip712Domain',domainRaw);
  check(same(owner,a.timelock) && same(core,a.factory) && same(budgetAddress,a.portfolioFactory)
    && !same(adminOne,ZERO) && !same(adminTwo,ZERO)
    && !same(adminOne,adminTwo) && !same(adminOne,gasWallet) && !same(adminTwo,gasWallet)
    && same(gasWallet,authority.gasWallet)
    && domain.name==='BEMine Platform Authority' && domain.version==='1'
    && domain.chainId===56n && same(domain.verifyingContract,authority.address),
  'Fresh Authority constructor state, ownership or EIP-712 domain changed.');
  return {current:{coreOwner:a.timelock,coreOperator:authority.address,coreTreasury:authority.address,
    budgetOwner:a.timelock,budgetOperator:authority.address,budgetTreasury:authority.address},
    address:authority.address,codehash:keccak256(code),activationBlock:steps.at(-1).blockNumber,
    activationHash:steps.at(-1).blockHash,deploymentTxHash:authority.deploymentTxHash,
    administratorOne:authority.administratorOne,administratorTwo:authority.administratorTwo,
    gasWallet:authority.gasWallet};
}

/** Fresh pinned-block graph and linked runtime verification before every product signing permission. */
export async function verifyProductGraph(provider, factory, trusted, block) {
  check(trusted?.record && trusted?.bundle,'Trusted product deployment evidence is unavailable.');
  const {record,bundle}=trusted, tag=`0x${block.number.toString(16)}`;
  const integrated=record.kind==='integrated-v2';
  const freshFactory=Boolean(bundle.artifacts.FreshPoolFactory);
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
  const freshAuthority=trusted.freshAuthority
    ? await verifyFreshAuthority(provider,record,bundle,trusted.freshAuthority,block) : null;
  const nativeSale=await verifyFreshNativeSale(provider,trusted,block);
  const salePolicy=await verifyFreshSalePolicy(provider,trusted,block,{nativeUpgrade:nativeSale});
  const factoryReuse=await verifyFreshFactoryReuse(provider,trusted,block);
  if (salePolicy) a={...a,...salePolicy.replacements,portfolioVaultImplementation:salePolicy.replacements.BudgetPortfolioVault};
  if (nativeSale) {
    check(salePolicy && same(salePolicy.replacements.PoolVault,nativeSale.baselinePoolVault),
      'Native sale did not preserve the complete reviewed 80% graph.');
    for (const [name,address] of Object.entries(nativeSale.runtimeLinks)) {
      if (['SaleSettlement','FirstoSale','PoolVault'].includes(name)) continue;
      check(same(address,salePolicy.runtimeLinks[name]),`Native sale reused an unreviewed library: ${name}.`);
    }
    a={...a,...nativeSale.replacements};
  }
  if (factoryReuse) a={...a,...factoryReuse.replacements};
  const upgradeProof=trusted.upgradeRecord ? await verifyFirstoUpgradeProof(provider,trusted,block) : null;
  const upgradedNames=candidateActive ? integratedUpgradeDeploymentOrder
    : trusted.upgradeRecord ? upgradeNamesForKind(trusted.upgradeRecord.kind) : [];
  const policyNames=salePolicy ? ['SaleGovernance','PoolVault','BudgetPortfolioVault','ShareMarket'] : [];
  const nativeNames=nativeSale ? ['SaleSettlement','FirstoSale','PoolVault'] : [];
  const reuseName=name=>factoryReuse && ['PoolFactory','FreshPoolFactory'].includes(name);
  const sourceFor=name=>reuseName(name) ? trusted.freshFactoryReuse.bundle : nativeNames.includes(name) ? trusted.freshNativeSale.bundle : policyNames.includes(name) ? trusted.freshSalePolicy.bundle : candidateActive ? upgradedNames.includes(name) ? security.bundle : bundle
    : trusted.upgradeRecord && !upgradedNames.includes(name) ? trusted.genesisBundle : bundle;
  const artifactFor=name=>name==='PoolFactory' && freshFactory ? 'FreshPoolFactory' : artifacts[name] ?? name;
  const runtimeLinksFor=name=>nativeNames.includes(name) ? nativeSale.runtimeLinks : salePolicy ? policyNames.includes(name) ? salePolicy.runtimeLinks : record.addresses
    : candidateActive && !upgradedNames.includes(name) ? record.addresses
    : trusted.upgradeRecord && !upgradedNames.includes(name) ? trusted.genesisRecord.addresses : a;
  const read=async(name,method,args=[])=>{
    const artifactName=artifactFor(({factory:'PoolFactory',shareMarket:'ShareMarket',portfolioFactory:'BudgetPortfolioFactory',portfolioShareMarket:'ShareMarket'})[name] ?? name);
    const source=name==='portfolioShareMarket' ? bundle : sourceFor(artifactName);
    const iface=new Interface(source.artifacts[artifactName].abi);
    return iface.decodeFunctionResult(method,await provider.send('eth_call',[{to:a[name],data:iface.encodeFunctionData(method,args)},tag]))[0];
  };
  const observedCodehash={};
  await settleReads((integrated ? INTEGRATED_NAMES : NAMES).map(async name=>{
    const code=await provider.getCode(a[name],block.number);
    const policyUpgraded=policyNames.includes(name);
    const nativeUpgraded=nativeNames.includes(name);
    const reuseUpgraded=reuseName(name);
    const upgraded=(candidateActive || trusted.upgradeRecord) && upgradedNames.includes(name);
    // The common proof checked replacement bytes at a finalized block. Compare
    // their complete hash again at the signing block, including immutables;
    // artifact shape matching alone masks constructor immutable values.
    const finalizedCode=candidateActive && upgraded
      ? await provider.getCode(a[name],finalizedProof.blockNumber) : null;
    check(code!=='0x' && (reuseUpgraded ? same(keccak256(code),factoryReuse.codehash[name]) : nativeUpgraded ? same(keccak256(code),nativeSale.codehash[name]) : policyUpgraded ? same(keccak256(code),salePolicy.codehash[name])
      : upgraded || same(keccak256(code),record.verification.code[name].codehash))
      && (!finalizedCode || same(keccak256(code),keccak256(finalizedCode)))
      && (reuseUpgraded ? factoryReuseRuntimeMatches(sourceFor(name).artifacts[artifactFor(name)],code,a[name])
        : runtimeMatches(sourceFor(name).artifacts[artifactFor(name)],code,runtimeLinksFor(name),a[name])),`Reviewed runtime changed: ${name}.`);
    observedCodehash[name]=keccak256(code);
  }));
  if (factoryReuse) observedCodehash.FreshPoolFactory=observedCodehash.PoolFactory;
  const currentRoles=roleState?.current ?? freshAuthority?.current;
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
    const expected=name==='portfolioShareMarket' && salePolicy ? record.addresses.ShareMarket : a[implementation];
    check(/^0x0{24}[\da-f]{40}$/i.test(slot) && same(`0x${slot.slice(-40)}`,expected),`Reviewed implementation changed: ${name}.`);
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
    ...(freshFactory ? {freshFactoryVerified:true} : {}),
    ...(freshAuthority ? {freshAuthority} : {}),
    ...(salePolicy ? {salePolicyUpgrade:{candidateArtifactDigest:salePolicy.candidateArtifactDigest,
      operationId:salePolicy.operationId,saleReviewThresholdBps:salePolicy.saleReviewThresholdBps,
      automaticSaleReferenceVersion:salePolicy.automaticSaleReferenceVersion,
      replacements:{...salePolicy.replacements},codehash:{...salePolicy.codehash},
      verifiedBlockNumber:salePolicy.blockNumber,verifiedBlockHash:salePolicy.blockHash}} : {}),
    ...(nativeSale ? {nativeSaleUpgrade:{version:1,candidateArtifactDigest:nativeSale.candidateArtifactDigest,
      operationId:nativeSale.operationId,replacements:{...nativeSale.replacements},codehash:{...nativeSale.codehash},
      verifiedBlockNumber:nativeSale.blockNumber,verifiedBlockHash:nativeSale.blockHash}} : {}),
    ...(factoryReuse ? {factoryReuseUpgrade:{version:1,candidateArtifactDigest:factoryReuse.candidateArtifactDigest,
      operationId:factoryReuse.operationId,replacements:{...factoryReuse.replacements},codehash:{...factoryReuse.codehash},
      verifiedBlockNumber:factoryReuse.blockNumber,verifiedBlockHash:factoryReuse.blockHash}} : {}),
    ...(candidateActive ? {securityUpgrade:{operationId:security.plan.operationId,
      roleWiringComplete:roleState?.roleWiringComplete===true,
      roleMigrationStarted:roleState?.applied?.some(Boolean)===true}} : {}),
    ...(upgradeProof ? {upgrade:upgradeProof} : {})};
}
