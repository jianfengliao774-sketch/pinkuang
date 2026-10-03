import { Interface, ZeroAddress, getAddress } from 'ethers';
import { discoverOfficialBudgetCandidates } from '../scripts/budget-official-discovery.mjs';
import { createBudgetMulticallReader } from '../scripts/budget-multicall-read.mjs';

const views = new Interface([
  'function isPool(address) view returns(bool)', 'function OFFICIAL_FACTORY() view returns(address)',
  'function legacyFactory() view returns(address)', 'function state() view returns(uint8)',
  'function budgetWei() view returns(uint256)', 'function spentWei() view returns(uint256)',
  'function absoluteCapWei() view returns(uint256)', 'function unitCapWei() view returns(uint256)',
  'function purchaseDeadline() view returns(uint64)', 'function machinePool(address,uint256) view returns(address)',
]);
const need = (condition, message) => { if (!condition) throw new Error(message); };
const same = (a,b) => getAddress(a) === getAddress(b);

/** Complete official discovery for one registered parent; never signs or creates a child. */
export async function readBudgetCandidates({ provider, parent, factory, graph, block, signal, fetcher = fetch,
  discover = discoverOfficialBudgetCandidates, now = Date.now(), reservationReader }) {
  parent=getAddress(parent); factory=getAddress(factory);
  need(graph?.productKind==='budget' && same(graph.factory,factory) && graph.legacyFactory, 'Reviewed budget graph is required.');
  const tag=`0x${block.number.toString(16)}`;
  const read=async(to,name,args=[])=>views.decodeFunctionResult(name,await provider.send('eth_call',[{to,data:views.encodeFunctionData(name,args)},tag]))[0];
  need(await read(factory,'isPool',[parent]) && same(await read(parent,'OFFICIAL_FACTORY'),factory)
    && same(await read(parent,'legacyFactory'),graph.legacyFactory), 'Budget parent is not registered to the reviewed graph.');
  const [state,budget,spent,absolute,unit,deadline]=await Promise.all(['state','budgetWei','spentWei','absoluteCapWei','unitCapWei','purchaseDeadline'].map(name=>read(parent,name)));
  need(state===1n && BigInt(block.timestamp)<deadline && spent<budget, 'Budget project is outside its acquisition window.');
  const found=await discover({provider,blockNumber:block.number,signal,fetcher,now,absoluteCapWei:absolute,unitCapWei:unit});
  need(found?.snapshot?.complete===true && found.snapshot.blockNumber===block.number
    && found.snapshot.blockHash.toLowerCase()===block.hash.toLowerCase() && Array.isArray(found.candidates), 'Official discovery is incomplete.');
  const reader=reservationReader??(found.candidates.length?await createBudgetMulticallReader({provider,blockNumber:block.number,signal}):null);
  const candidates=[];
  for(let offset=0;offset<found.candidates.length;offset+=512){
    need(!signal?.aborted,'Budget discovery aborted.');
    const batch=await Promise.all(found.candidates.slice(offset,offset+512).map(async candidate=>{
      const [reservation]=await reader.call(graph.legacyFactory,views,'machinePool',[candidate.collection,BigInt(candidate.tokenId)]);
      const raise=(BigInt(candidate.costWei)+99n)/100n*100n;
      return reservation===ZeroAddress && raise<=budget-spent ? candidate : null;
    }));
    candidates.push(...batch.filter(Boolean));
  }
  need((await provider.getBlock(block.number))?.hash?.toLowerCase()===block.hash.toLowerCase(), 'Budget discovery block changed.');
  return { complete:true,chainId:56,parent,factory,legacyFactory:getAddress(graph.legacyFactory),artifactDigest:graph.artifactDigest,
    budgetWei:budget.toString(),spentWei:spent.toString(),remainingWei:(budget-spent).toString(),absoluteCapWei:absolute.toString(),unitCapWei:unit.toString(),
    purchaseDeadline:deadline.toString(),snapshot:found.snapshot,candidates };
}
