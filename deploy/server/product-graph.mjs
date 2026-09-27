import { lstatSync, readFileSync } from 'node:fs';
import { Interface, getAddress, keccak256, toUtf8Bytes } from 'ethers';

const HASH = /^0x[\da-f]{64}$/i;
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ZERO = `0x${'0'.repeat(40)}`;
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const check = (condition, message) => { if (!condition) throw new Error(message); };
const LIBRARIES = ['FlexiblePurchase','MiningOperations','PoolFunds','PurchaseValidation','RewardAccounting','SaleGovernance','SaleSettlement','ShareCheckpoints'];
const NAMES = [...LIBRARIES,'AtomicDeployment','PoolVault','PoolFactory','ShareMarket','factory','shareMarket','lens','beacon','timelock'];
const artifacts = { factory:'ERC1967Proxy',shareMarket:'ERC1967Proxy',lens:'PoolLens',beacon:'PoolBeacon',timelock:'PoolTimelock' };
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
  if (LIBRARIES.includes(artifact.contractName) && expected.startsWith(`73${'0'.repeat(40)}`)) expected=`73${ownAddress.slice(2).toLowerCase()}${expected.slice(42)}`;
  for (const locations of Object.values(artifact.immutableReferences ?? {})) for (const {start,length} of locations) {
    if(start<0 || length<=0 || (start+length)*2>expected.length)return false;
    expected=expected.slice(0,start*2)+'0'.repeat(length*2)+expected.slice((start+length)*2);
    actual=actual.slice(0,start*2)+'0'.repeat(length*2)+actual.slice((start+length)*2);
  }
  return expected===actual;
}

/** Evidence is operator-owned local data; never accept it from an API caller. */
export function productGraphConfiguration({ recordPath, bundlePath, record, bundle }={}) {
  if (!record && !recordPath) return null;
  record ??= load(recordPath); bundle ??= load(bundlePath);
  check(record?.schemaVersion===1 && record.chainId===56 && record.status==='complete'
    && record.steps?.length===13 && record.steps.every(step=>step.status==='confirmed')
    && record.steps.some(step=>step.id==='initialize' && step.receipt?.status===1 && HASH.test(step.txHash))
    && HASH.test(record.artifactDigest) && same(digest(bundle),record.artifactDigest)
    && record.verification?.checks?.length>0 && record.verification.checks.every(item=>item.passed),
  'Trusted product deployment is not a completed, verified deployment of this build.');
  for (const name of NAMES) {
    const address=getAddress(record.addresses[name]), code=record.verification.code[name];
    check(same(address,code?.address) && HASH.test(code?.codehash ?? ''),`Missing trusted code evidence for ${name}.`);
    check(bundle.artifacts[artifacts[name] ?? name],`Missing trusted artifact for ${name}.`);
  }
  // Defensive clone: consumers cannot modify the trusted evidence through a browser record.
  return JSON.parse(JSON.stringify({record,bundle}));
}

/** Fresh pinned-block graph and linked runtime verification before every product signing permission. */
export async function verifyProductGraph(provider, factory, trusted, block) {
  check(trusted?.record && trusted?.bundle,'Trusted product deployment evidence is unavailable.');
  const {record,bundle}=trusted, a=record.addresses, tag=`0x${block.number.toString(16)}`;
  check(same(factory,a.factory),'Factory differs from the trusted deployment.');
  const read=async(name,method,args=[])=>{
    const iface=new Interface(bundle.artifacts[({factory:'PoolFactory',shareMarket:'ShareMarket'})[name] ?? artifacts[name] ?? name].abi);
    return iface.decodeFunctionResult(method,await provider.send('eth_call',[{to:a[name],data:iface.encodeFunctionData(method,args)},tag]))[0];
  };
  await Promise.all(NAMES.map(async name=>{
    const code=await provider.getCode(a[name],block.number);
    check(code!=='0x' && same(keccak256(code),record.verification.code[name].codehash)
      && runtimeMatches(bundle.artifacts[artifacts[name] ?? name],code,a,a[name]),`Reviewed runtime changed: ${name}.`);
  }));
  const assertions=[['AtomicDeployment','deployed',true],['AtomicDeployment','deployer',record.account],
    ['AtomicDeployment','predictedFactory',a.factory],['factory','owner',record.input.ownerMultisig],
    ['factory','operator',record.input.operator],['factory','treasury',record.input.treasury],
    ['factory','lens',a.lens],['factory','shareMarket',a.shareMarket],['factory','beacon',a.beacon],['factory','timelock',a.timelock],
    ['lens','factory',a.factory],['lens','VERSION',1n],['shareMarket','factory',a.factory],['shareMarket','timelock',a.timelock],
    ['shareMarket','feeBps',100n],['beacon','owner',a.timelock],['beacon','implementation',a.PoolVault],
    ['beacon','OFFICIAL_FACTORY',a.factory],['PoolVault','OFFICIAL_FACTORY',a.factory],
    ['timelock','getMinDelay',172800n],['timelock','MINIMUM_DELAY',172800n]];
  await Promise.all(assertions.map(async([name,method,expected])=>check(String(await read(name,method)).toLowerCase()===String(expected).toLowerCase(),`Reviewed binding changed: ${name}.${method}.`)));
  await Promise.all([['factory','PoolFactory'],['shareMarket','ShareMarket']].map(async([name,implementation])=>{
    const slot=await provider.getStorage(a[name],SLOT,block.number);
    check(same(`0x${slot.slice(-40)}`,a[implementation]),`Reviewed implementation changed: ${name}.`);
  }));
  const roles=await Promise.all(['PROPOSER_ROLE','CANCELLER_ROLE','EXECUTOR_ROLE','DEFAULT_ADMIN_ROLE'].map(name=>read('timelock',name)));
  await Promise.all([[roles[0],record.input.ownerMultisig,true],[roles[1],record.input.ownerMultisig,true],
    [roles[2],ZERO,true],[roles[3],a.timelock,true],[roles[3],record.account,false],[roles[3],a.AtomicDeployment,false]].map(async([role,account,expected])=>
      check(await read('timelock','hasRole',[role,account])===expected,'Reviewed Timelock permissions changed.')));
  check((await provider.getBlock(block.number))?.hash===block.hash,'Chain changed during product graph verification.');
  return {factory:a.factory,operator:record.input.operator,artifactDigest:record.artifactDigest,blockNumber:block.number};
}
