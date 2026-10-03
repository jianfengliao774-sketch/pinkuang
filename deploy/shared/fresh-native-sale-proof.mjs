import { AbiCoder, Interface, ZeroAddress, ZeroHash, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { buildDigest, evidenceDigest, settleReads } from './firsto-upgrade-proof.mjs';

export const FRESH_NATIVE_SALE_KIND = 'fresh-native-firsto-sale-upgrade-v1';
const names = ['SaleSettlement', 'FirstoSale', 'PoolVault'];
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const need = (ok,message) => { if (!ok) throw new Error(message); };
const views = new Interface(['function implementation() view returns(address)',
  'function OFFICIAL_FACTORY() view returns(address)', 'function nativeFirstoSaleVersion() view returns(uint8)',
  'function hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32) view returns(bytes32)',
  'function isOperationDone(bytes32) view returns(bool)']);
const actions = new Interface(['function upgradeTo(address)',
  'function enableNativeFirstoSale(uint256,uint256,uint16,uint256)']);
const cache = new WeakMap(), verified = new WeakSet();

export function nativeSaleSalt(factory, artifactDigest) {
  return keccak256(toUtf8Bytes(`bemine.native-firsto.v1:${factory.toLowerCase()}:${artifactDigest.toLowerCase()}`));
}

export function validateFreshNativeSaleCatalog(catalog,bundle,trusted) {
  need(trusted?.freshAuthority && trusted?.freshSalePolicy, 'Native sale requires the preserved Authority and 80% policy evidence.');
  const a=trusted.record.addresses;
  need(catalog?.schemaVersion===1 && catalog.kind===FRESH_NATIVE_SALE_KIND && catalog.chainId===56
    && ['formal','full-test'].includes(catalog.profile) && catalog.profile===trusted.freshSalePolicy.catalog.profile
    && same(catalog.genesisArtifactDigest,trusted.record.artifactDigest)
    && same(catalog.candidateArtifactDigest,buildDigest(bundle)), 'Native sale artifact identity differs.');
  for (const key of ['factory','beacon','timelock']) need(same(catalog.bindings?.[key],a[key]),`Native sale binding differs: ${key}.`);
  need(same(catalog.bindings?.proposer,trusted.record.input.ownerMultisig), 'Native sale proposer differs.');
  const baseline=getAddress(catalog.expectedImplementations?.PoolVault);
  need(!same(baseline,ZeroAddress) && !Object.values(a).some(value=>same(value,baseline)), 'Native sale must follow the reviewed 80% implementation.');
  for (const [name,value] of Object.entries(catalog.libraries ?? {})) {
    const address=getAddress(value);
    need(!same(address,ZeroAddress) && (name==='SaleGovernance' || same(address,a[name])),`Native sale changed an unrelated library: ${name}.`);
  }
  for (const name of names) need(bundle.artifacts?.[name] && catalog.artifacts?.[name]
    && evidenceDigest(catalog.artifacts[name])===evidenceDigest(bundle.artifacts[name]),`Native sale artifact differs: ${name}.`);
  for (const artifact of Object.values(catalog.artifacts)) {
    need(artifact.deployedBytecode.length<=24576*2+2, 'Native sale runtime exceeds the chain deployment limit.');
    for (const links of Object.values(artifact.deployedLinkReferences ?? {})) for (const name of Object.keys(links)) {
      if (names.includes(name)) continue;
      const address=getAddress(catalog.libraries?.[name]);
      need(!same(address,ZeroAddress) && (name==='SaleGovernance' || same(address,a[name])),`Native sale changed an unrelated library: ${name}.`);
    }
  }
  need(same(catalog.salt,nativeSaleSalt(a.factory,catalog.candidateArtifactDigest)), 'Native sale salt differs.');
  if (catalog.activation!=null) {
    const x=catalog.activation;
    need(catalog.profile==='full-test' && x && /^0x[\da-f]{40}$/i.test(x.pool)
      && !same(x.pool,ZeroAddress) && !Object.values(a).some(value=>same(value,x.pool)), 'Formal native sale cannot contain a test activation.');
    for (const [key,bits] of [['proposalId',256],['priceWei',128],['feeBps',16],['feeEpoch',256]]) {
      need(typeof x[key]==='string' && /^(?:0|[1-9]\d{0,77})$/.test(x[key]), 'Native activation integer is invalid.');
      const value=BigInt(x[key]); need(value>=(key==='feeBps'?0n:1n) && value<1n<<BigInt(bits), 'Native activation integer is out of range.');
    }
    need(BigInt(x.feeBps)<=200n, 'Native activation fee is out of range.');
  }
  return JSON.parse(JSON.stringify({catalog,bundle}));
}

export function freshNativeSaleOperation(catalog,replacements) {
  const targets=[catalog.bindings.beacon],values=[0n],payloads=[actions.encodeFunctionData('upgradeTo',[replacements.PoolVault])];
  if (catalog.activation) {
    const x=catalog.activation; targets.push(x.pool); values.push(0n);
    payloads.push(actions.encodeFunctionData('enableNativeFirstoSale',[x.proposalId,x.priceWei,x.feeBps,x.feeEpoch]));
  }
  const operationId=keccak256(AbiCoder.defaultAbiCoder().encode(['address[]','uint256[]','bytes[]','bytes32','bytes32'],
    [targets,values,payloads,ZeroHash,catalog.salt]));
  return {targets,values,payloads,predecessor:ZeroHash,salt:catalog.salt,operationId};
}

function linksOf(artifact,code) {
  const result={},bytes=code.slice(2);
  for (const libraries of Object.values(artifact.deployedLinkReferences ?? {})) for (const [name,slots] of Object.entries(libraries))
    for (const {start,length} of slots) {
      need(Number.isSafeInteger(start) && start>=0 && length===20 && (start+length)*2<=bytes.length,'Native library reference is invalid.');
      const address=getAddress('0x'+bytes.slice(start*2,(start+length)*2));
      need(!result[name] || same(result[name],address), 'Native library slots disagree.'); result[name]=address;
    }
  return result;
}

function exactRuntime(artifact,code,links,address) {
  let expected=artifact.deployedBytecode.slice(2),actual=code.slice(2);
  for (const libraries of Object.values(artifact.deployedLinkReferences ?? {})) for (const [name,slots] of Object.entries(libraries))
    for (const {start,length} of slots) {
      need(length===20 && links[name], 'Native library is unresolved.');
      expected=expected.slice(0,start*2)+links[name].slice(2)+expected.slice((start+length)*2);
    }
  if (['SaleSettlement','FirstoSale'].includes(artifact.contractName)) {
    need(expected.startsWith('73'+'0'.repeat(40)), 'Native library self binding is invalid.');
    expected='73'+address.slice(2)+expected.slice(42);
  }
  for (const slots of Object.values(artifact.immutableReferences ?? {})) for (const {start,length} of slots) {
    need(artifact.contractName==='PoolVault' && start>=0 && length>0 && (start+length)*2<=expected.length,'Native immutable is invalid.');
    expected=expected.slice(0,start*2)+'0'.repeat(length*2)+expected.slice((start+length)*2);
    actual=actual.slice(0,start*2)+'0'.repeat(length*2)+actual.slice((start+length)*2);
  }
  need(/^[\da-f]+$/i.test(expected) && expected.length===actual.length && same(expected,actual),`Native exact runtime differs: ${artifact.contractName}.`);
}

/** Only an internally verified native operation may supply the old policy's baseline address. */
export function nativeSalePolicyBaseline(proof) {
  need(verified.has(proof), 'Unverified native policy baseline.'); return proof.baselinePoolVault;
}

export async function verifyFreshNativeSale(provider,trusted,block) {
  const native=trusted.freshNativeSale; if (!native) return null;
  const {catalog,bundle}=native,a=trusted.record.addresses,tag='0x'+block.number.toString(16);
  const read=async(to,method,args=[])=>views.decodeFunctionResult(method,await provider.send('eth_call',
    [{to,data:views.encodeFunctionData(method,args)},tag]))[0];
  const current=getAddress(await read(a.beacon,'implementation'));
  if (same(current,a.PoolVault) || same(current,catalog.expectedImplementations.PoolVault)) return null;
  let providers=cache.get(native); if (!providers) {providers=new WeakMap();cache.set(native,providers);}
  const prior=providers.get(provider);
  if (prior && same(prior.current,current)) {
    need(same((await provider.getBlock(prior.value.blockNumber))?.hash,prior.value.blockHash),'Native proof anchor changed.'); return prior.value;
  }
  const poolCode=await provider.getCode(current,block.number),poolLinks=linksOf(bundle.artifacts.PoolVault,poolCode);
  const replacements={PoolVault:current,SaleSettlement:poolLinks.SaleSettlement,FirstoSale:poolLinks.FirstoSale};
  const used=Object.values(replacements).map(getAddress);
  need(new Set(used.map(value=>value.toLowerCase())).size===3 && used.every(value=>!same(value,ZeroAddress)
    && !same(value,catalog.expectedImplementations.PoolVault) && !Object.values(a).some(old=>same(old,value))), 'Native replacement reuses a preserved address.');
  const runtimeLinks={...a,...catalog.libraries,...replacements};
  for (const [name,address] of Object.entries(poolLinks)) if (!names.includes(name))
    need(same(address,catalog.libraries[name]),`Native reused library differs: ${name}.`);
  const codes=Object.fromEntries(await settleReads(names.map(async name=>[name,name==='PoolVault'?poolCode:await provider.getCode(replacements[name],block.number)])));
  for (const name of names) exactRuntime(bundle.artifacts[name],codes[name],runtimeLinks,replacements[name]);
  const operation=freshNativeSaleOperation(catalog,replacements);
  const [factory,version,id,done]=await settleReads([read(current,'OFFICIAL_FACTORY'),read(current,'nativeFirstoSaleVersion'),
    read(a.timelock,'hashOperationBatch',[operation.targets,operation.values,operation.payloads,ZeroHash,operation.salt]),
    read(a.timelock,'isOperationDone',[operation.operationId])]);
  need(same(factory,a.factory) && version===1n && same(id,operation.operationId) && done===true, 'Native bindings, version or fixed Timelock execution are incomplete.');
  const value=Object.freeze({replacements,runtimeLinks,baselinePoolVault:catalog.expectedImplementations.PoolVault,
    candidateArtifactDigest:catalog.candidateArtifactDigest,operationId:operation.operationId,version:1,
    codehash:Object.fromEntries(names.map(name=>[name,keccak256(codes[name])])),blockNumber:block.number,blockHash:block.hash});
  verified.add(value);providers.set(provider,{current,value});return value;
}
