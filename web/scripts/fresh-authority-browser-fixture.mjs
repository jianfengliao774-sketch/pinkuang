/** Local-only full-product fixture. Test key, synthetic addresses, no external RPC or broadcasts. */
import { Wallet, ZeroAddress, getAddress, id, keccak256, toQuantity, verifyTypedData } from 'ethers';
import { portfolioFixture, PORTFOLIOS, address } from './portfolio-fixture.mjs';
import { abi } from '../lib/chain-client.mjs';
import { freshManifestDigest } from '../lib/fresh-product-config.mjs';
import { authorityAction } from '../lib/authority-client.mjs';
import { expectedAuthorityQueueCall } from '../lib/authority-queue-recovery.mjs';
import { dataFixture, chainFixture, MARKET, MINING } from './operator-quotes-fixture.mjs';
import { machineRegistryAbi } from '../lib/operator-quotes.mjs';
import { validateBudgetQueue } from '../../deploy/shared/budget-queue.mjs';
const signer = new Wallet(`0x${'11'.repeat(32)}`), other = new Wallet(`0x${'12'.repeat(32)}`);
const ordinary = address(0xb0b);
const hash=n=>`0x${BigInt(n).toString(16).padStart(64,'0')}`, same=(a,b)=>a?.toLowerCase()===b?.toLowerCase();
const authority=address(0x990),gasWallet=address(0x991),child=address(0x992),code='0x60006000';
export function freshAuthorityBrowserFixture(){
  const f=portfolioFixture({baseOptions:{account:signer.address},poolState:1n});
  const manifest={...f.manifest,verifiedAt:'2026-09-30T00:00:00.000Z',verifiedBlockNumber:95,
    authority,gasWallet,freshAuthority:{address:authority,administratorOne:signer.address,administratorTwo:other.address,
      gasWallet,codehash:keccak256(code),deploymentTxHash:hash(990)}};
  const graph=()=>({status:'verified',chainId:56,stage:'fresh-active',artifactDigest:manifest.artifactDigest,
    genesisArtifactDigest:manifest.artifactDigest,upgradeArtifactDigest:null,operationId:null,
    factory:manifest.factory,portfolioFactory:manifest.portfolioFactory,freshFactoryVerified:true,
    verifiedBlockNumber:100,verifiedBlockHash:hash(100),stageActivationBlock:95,stageActivationHash:hash(95),
    freshAuthority:{...manifest.freshAuthority,activationBlock:95,activationHash:hash(95)},
    operationalReady:state.operationalReady,transactionReady:state.operationalReady,userExitReady:true,readMode:'current',stale:false,manifest});
  const data=dataFixture(),quote=data.quote,price=1000000000000n;
  const official=chainFixture(quote,{listing:{id:45n,price,valid:true}});
  const state={account:signer.address,authenticated:false,queue:null,revision:0,created:false,bought:false,
    authorityNonce:0n,relay:{status:'idle'},transactions:new Map(),signatures:[],posts:[],reads:[],pendingReceipt:true,
    operationalReady:true,userRecord:null,userRevision:0,userSends:[]};
  const params={circuits:quote.collection,circuitId:BigInt(quote.tokenId),targetRaise:price,priceCap:price,
    directSeller:ZeroAddress,directPrice:0n,fundingDeadline:BigInt(f.source().indexedTimestamp)+3n*86400n-1n,
    purchaseDeadline:BigInt(f.source().indexedTimestamp)+3n*86400n};
  const config={...f.config,...manifest,manifest,operationalReady:true,transactionReady:true};
  const request=async input=>{
    state.reads.push(input.method); const {method,params:p=[]}=input;
    if(method==='eth_accounts'||method==='eth_requestAccounts')return [state.account];
    if(method==='eth_getBalance')return toQuantity(10n**20n);
    if(method==='eth_gasPrice')return toQuantity(100000000n);
    if(method==='eth_getTransactionCount')return '0x7';
    if(method==='eth_sendTransaction'){
      const tx=p[0],record=state.userRecord;
      if(!record||!same(tx.from,state.account)||!same(tx.to,PORTFOLIOS[0])||tx.data!==record.data
        ||BigInt(tx.value)!==0n||abi.BudgetPortfolioVault.parseTransaction(tx).name!=='withdrawBnb')throw Error('Unexpected user send');
      state.userSends.push(tx);return hash(777);
    }
    if(method==='eth_signTypedData_v4'){
      if(!same(state.account,signer.address))throw Error('Not the fixture administrator');
      const typed=JSON.parse(p[1]);delete typed.types.EIP712Domain;
      state.signatures.push(typed);return signer.signTypedData(typed.domain,typed.types,typed.message);
    }
    if(/send|sign|wallet_/i.test(method))throw Error('Fixture forbids this wallet method '+method);
    if(method==='eth_getTransactionByHash')return state.transactions.get(p[0])?.tx??null;
    if(method==='eth_getTransactionReceipt')return state.pendingReceipt?null:state.transactions.get(p[0])?.receipt??null;
    if(method==='eth_getBlockByNumber'&&p[0]==='finalized')return {number:'0x64',hash:hash(100),timestamp:toQuantity(f.source().indexedTimestamp)};
    if(method==='eth_getCode'&&[authority,child].some(a=>same(p[0],a)))return code;
    if(method==='eth_call'){
      const tx=p[0], target=getAddress(tx.to);
      if(PORTFOLIOS.some(a=>same(a,target))){
        const parsed=abi.BudgetPortfolioVault.parseTransaction(tx);
        if(['balanceOf','claimableBem','bnbOwed'].includes(parsed?.name)&&same(parsed.args[0],ordinary))
          return abi.BudgetPortfolioVault.encodeFunctionResult(parsed.fragment,[parsed.name==='balanceOf'?10n:parsed.name==='claimableBem'?100n:7n]);
      }
      if(same(target,authority)){
        const parsed=abi.PlatformAuthority.parseTransaction(tx),values={administratorOne:signer.address,administratorTwo:other.address,
          gasWallet,coreFactory:manifest.factory,budgetFactory:manifest.portfolioFactory,nonces:state.authorityNonce};
        if(!(parsed?.name in values))throw Error('Unexpected authority read '+parsed?.name);
        return abi.PlatformAuthority.encodeFunctionResult(parsed.fragment,[values[parsed.name]]);
      }
      if(same(target,manifest.factory)||same(target,manifest.portfolioFactory)){
        const contract=same(target,manifest.factory)?abi.PoolFactory:abi.BudgetPortfolioFactory;
        const parsed=contract.parseTransaction(tx);
        if(parsed?.name==='operator'||parsed?.name==='treasury')return contract.encodeFunctionResult(parsed.fragment,[authority]);
        if(parsed?.name==='machinePool')return machineRegistryAbi.encodeFunctionResult(parsed.fragment,[state.created?child:ZeroAddress]);
        if(parsed?.name==='isPool'&&same(parsed.args[0],child))return contract.encodeFunctionResult(parsed.fragment,[state.created]);
        if(parsed?.name==='designatedSubscriber')return contract.encodeFunctionResult(parsed.fragment,[same(parsed.args[0],child)?PORTFOLIOS[0]:ZeroAddress]);
      }
      if(same(target,child)){
        const parsed=abi.PoolVault.parseTransaction(tx),values={params,factory:manifest.factory,state:state.bought?2n:0n,totalSupply:state.bought?100n:0n};
        if(!(parsed?.name in values))throw Error('Unexpected child read '+parsed?.name);
        return abi.PoolVault.encodeFunctionResult(parsed.fragment,[values[parsed.name]]);
      }
      if([MARKET,MINING,quote.collection].some(a=>same(a,target)))return official.provider.request(input);
    }
    return f.request(input);
  };
  const journal=async(url,method,body)=>{
    const path=new URL(url).pathname.split('/journal/')[1];
    if(path==='product-graph')return graph();
    if(path==='notifications/capabilities')return {enabled:false};
    if(path==='session')return {account:state.account};
    if(path==='market'&&method==='GET')return {revision:state.userRevision,record:state.userRecord};
    if(path==='market/prepare-and-arm'){
      const r=body.record;
      if(body.expectedRevision!==state.userRevision||r.action.kind!=='withdrawBnb'||r.targetType!=='portfolio'
        ||!same(r.account,state.account)||!same(r.target,PORTFOLIOS[0])||BigInt(r.value)!==0n)throw Error('Invalid direct user exit');
      state.userRecord=r;state.userRevision+=2;
      return {revision:state.userRevision,record:r,transaction:{from:r.account,to:r.target,data:r.data,value:toQuantity(BigInt(r.value)),
        chainId:'0x38',nonce:toQuantity(r.nonce),gas:toQuantity(BigInt(r.gas)),maxFeePerGas:toQuantity(BigInt(r.gasPrice)),
        maxPriorityFeePerGas:toQuantity(BigInt(r.gasPrice)),type:'0x2'}};
    }
    if(path==='market'&&method==='PUT'){
      if(body.expectedRevision!==state.userRevision)throw Error('User journal CAS mismatch');
      state.userRecord=body.record;return {revision:++state.userRevision,record:state.userRecord};
    }
    if(path==='market'&&method==='DELETE'){
      const r=state.userRecord;
      const result={status:'confirmed',finalized:true,account:r.account,target:r.target,factory:r.factory,action:'withdrawBnb',nonce:7,
        transactionHash:hash(777),receipt:{status:1,transactionHash:hash(777),to:r.target,blockNumber:100,blockHash:hash(100)}};
      state.userRecord=null;return {result,revision:++state.userRevision};
    }
    if(path==='authority-relay/status')return state.relay;
    if(path==='budget-queue'){
      if(method==='GET')return {revision:state.revision,record:state.queue};
      if(body.expectedRevision!==state.revision)throw Error('Fixture queue CAS conflict');
      validateBudgetQueue(body.record,{config,account:state.account,parent:PORTFOLIOS[0]});
      state.queue=structuredClone(body.record);state.revision++;return {revision:state.revision};
    }
    if(path==='budget-candidates')return {complete:true,chainId:56,parent:PORTFOLIOS[0],factory:manifest.portfolioFactory,
      legacyFactory:manifest.factory,artifactDigest:manifest.artifactDigest,budgetWei:'5000000000000000',spentWei:'0',
      absoluteCapWei:'3000000000000000',unitCapWei:'100000000000',snapshot:{complete:true,blockNumber:100,blockHash:hash(100),observedAt:Date.now()},
      candidates:[{collection:quote.collection,tokenId:quote.tokenId,costWei:price.toString(),verifiedWeight:quote.verifiedWeight,venue:'official',listingId:'45'}]};
    if(path==='authority-relay'&&method==='POST'){
      const command=body.command, expected=expectedAuthorityQueueCall(config,state.queue,0);
      if(JSON.stringify(command.args)!==JSON.stringify(expected.command.args)||command.kind!==expected.command.kind)throw Error('Wrong exact signed command');
      const typed=authorityAction(authority,command.kind,command.args,command.nonce,command.deadline);
      if(!same(verifyTypedData(typed.domain,typed.types,typed.message,command.signature),signer.address))throw Error('Wrong admin signature');
      if(BigInt(command.nonce)!==state.authorityNonce)throw Error('Duplicate Authority nonce');
      state.authorityNonce++;state.posts.push(command);
      const transactionHash=hash(1000+state.posts.length),blockHash=hash(100);
      const tx={hash:transactionHash,from:gasWallet,to:authority,chainId:'0x38',nonce:toQuantity(state.posts.length),value:'0x0',blockNumber:'0x64',blockHash,
        input:abi.PlatformAuthority.encodeFunctionData(command.kind,[...expected.arguments,command.nonce,command.deadline,command.signature])};
      const log=(contract,address,name,args)=>({address,...contract.encodeEventLog(contract.getEvent(name),args),transactionHash,blockHash,removed:false});
      const create=command.kind==='executeApprovedOperation';
      const receipt={from:gasWallet,to:authority,transactionHash,blockHash,blockNumber:'0x64',status:'0x1',logs:[
        log(abi.PlatformAuthority,authority,'AdminAction',[signer.address,expected.eventKind,expected.target,command.nonce]),
        create?log(abi.PoolFactory,manifest.factory,'PoolCreated',[child,quote.collection,quote.tokenId,price,price,authority])
          :log(abi.BudgetPortfolioVault,PORTFOLIOS[0],'ChildPurchased',[child,quote.collection,quote.tokenId,price,true])
      ]};
      state.transactions.set(transactionHash,{tx,receipt});
      if(create)state.created=true;else state.bought=true;
      state.relay={status:'confirmed',hash:transactionHash};return state.relay;
    }
    throw Error(`Unexpected fixture journal ${method} ${path}`);
  };
  return {f,manifest,config,graph,manifestSha:freshManifestDigest(manifest),state,signer,other,ordinary,child,request,journal,
    index:url=>{
      const result=f.index(url),path=new URL(url).pathname;
      if(result.data&&(path.endsWith('/v1/pools')||path.endsWith('/v1/stats')))
        result.data={...result.data,registeredPoolCount:String(f.base.rows.length),standalonePoolCount:String(f.base.rows.length),
          childPoolCount:'0',reservedChildPoolCount:'0',reservedChildPoolAddresses:[],reservedChildPoolAddressesComplete:true};
      return result;
    },data,params};
}
