import { FRESH_DELEGATION_MANAGER, FRESH_DELEGATOR, FRESH_BALANCE_ENFORCER,
  expectedFreshActivationCall, decodeFreshActivationEnvelope, verifyFreshActivationExecution, assertFreshActivationWalletScope,
} from './fresh-activation-execution.mjs';

const same=(a,b)=>typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();
const check=(ok,message)=>{if(!ok)throw new Error(message);};
export const isFreshActivationWrapper=tx=>same(tx?.to,FRESH_DELEGATION_MANAGER.address);

/** Read-only proof. No fallback to an arbitrary wrapper, no simulation or wallet request. */
export async function verifyWrappedFreshActivation(provider,record,step,tx,receipt,
  {verifyPrefix,includeCurrent=false,historicalPrefix=true}={}) {
  check(isFreshActivationWrapper(tx) && (!(historicalPrefix || includeCurrent) || typeof verifyPrefix==='function'),
    'Unreviewed activation wrapper or missing role-prefix verifier.');
  const index=record.steps.findIndex(item=>item.id===step.id);
  check(index>0 && receipt.blockNumber>0,'Authority CREATE must remain a direct transaction.');
  const [inclusion,before,finalized,latest]=await Promise.all([
    provider.getBlock(receipt.blockNumber),historicalPrefix?provider.getBlock(receipt.blockNumber-1):Promise.resolve(null),
    provider.getBlock('finalized'),provider.getBlock('latest'),
  ]);
  check(inclusion?.hash && (!historicalPrefix || before?.hash) && finalized?.hash && latest?.hash
    && same(inclusion.hash,receipt.blockHash) && (!historicalPrefix || same(inclusion.parentHash,before.hash))
    && finalized.number>=receipt.blockNumber && latest.number>=finalized.number
    && latest.number-receipt.blockNumber+1>=2,'Activation wrapper is not canonical and finalized.');
  // These three reviewed implementations have no proxy/upgrade or destruction path.
  // Pin their exact runtime and the existing EIP-7702 delegation at a current
  // finalized anchor. This does not assert the account had that code at the
  // receipt block: successful Factory events prove the executed result.
  // Historical Factory state is required only at first journal acceptance.
  const [accountCode,managerCode,delegatorCode,enforcerCode]=await Promise.all([
    historicalPrefix || includeCurrent ? provider.getCode(record.account,finalized.number) : Promise.resolve('0x'),
    provider.getCode(FRESH_DELEGATION_MANAGER.address,finalized.number),
    provider.getCode(FRESH_DELEGATOR.address,finalized.number),
    provider.getCode(FRESH_BALANCE_ENFORCER.address,finalized.number),
  ]);
  if(historicalPrefix || includeCurrent)assertFreshActivationWalletScope(accountCode);
  const input={record,step,tx,receipt,expected:expectedFreshActivationCall(record,step),
    runtimeProof:{accountCode,managerCode,delegatorCode,enforcerCode}};
  const proof=receipt.status===1?verifyFreshActivationExecution(input):decodeFreshActivationEnvelope(input);
  const completed=receipt.status===1?index+1:index;
  // UI waits for finality between operations. Reject a block containing additional
  // role changes rather than trying to infer an intra-block partial prefix.
  if(historicalPrefix){
    await verifyPrefix(index,before);
    await verifyPrefix(completed,inclusion);
  }
  if(includeCurrent){
    await verifyPrefix(completed,finalized);
    if(!same(finalized.hash,latest.hash))await verifyPrefix(completed,latest);
  }
  for(const anchor of [before,inclusion,finalized,latest].filter(Boolean))
    check(same((await provider.getBlock(anchor.number))?.hash,anchor.hash),
      'Activation wrapper proof changed during verification.');
  const again=await provider.getTransactionReceipt(tx.hash);
  check(again && same(again.blockHash,receipt.blockHash) && again.status===receipt.status,
    'Activation wrapper receipt changed during verification.');
  return proof;
}
