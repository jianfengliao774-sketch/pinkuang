import { lstatSync, readFileSync } from 'node:fs';

const gas='0xad95dff16fe0e09c47bade687ab549929ac66c80';
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const need=(ok,message)=>{if(!ok)throw new Error(message);};
/** A newly generated test sender has no legacy nonce domain to migrate. */
export async function verifyFullTestSenderIsolation(provider,identity,{allowCurrentPending=false,requireFunding=false}={}){
 const path='/etc/bemine-full-test/independent-signer.json',stat=lstatSync(path);
 need(stat.isFile()&&!stat.isSymbolicLink()&&stat.uid===0&&!(stat.mode&0o022)&&stat.size<4096,'Invalid independent test signer proof.');
 const proof=JSON.parse(readFileSync(path,'utf8'));
 need(proof.schemaVersion===1&&proof.profile==='full-test'&&proof.chainId===56&&same(identity.gasWallet,gas)
  &&same(proof.gasWallet,gas)&&proof.initialLatestNonce===0&&proof.initialPendingNonce===0
  &&proof.separateCredential===true&&Number.isSafeInteger(proof.blockNumber)&&proof.blockNumber>0
  &&/^0x[0-9a-f]{64}$/i.test(proof.blockHash),'Test Gas isolation differs.');
 const [network,latest,pending,balance,anchor,initial]=await Promise.all([provider.getNetwork(),provider.getTransactionCount(gas,'latest'),
  provider.getTransactionCount(gas,'pending'),provider.getBalance(gas),provider.getBlock(proof.blockNumber),
  provider.getTransactionCount(gas,proof.blockNumber)]);
 need(same(anchor?.hash,proof.blockHash)&&initial===0,'Independent test Gas birth proof is not canonical.');
 need(network.chainId===56n&&latest>=0&&(allowCurrentPending?pending>=latest:pending===latest),'Test Gas nonce is unresolved.');
 if(requireFunding)need(balance>=3_000_000_000_000_000n,'Fund the dedicated test Gas wallet with at least 0.003 BNB before automation.');
 return {cutoverNonce:0,currentNonce:latest,oldSendersDisabled:true,independentSender:true};
}
