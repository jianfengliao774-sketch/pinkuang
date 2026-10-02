/** Offline fixture only; never imported by shipped application code. */
import { Interface, getAddress, keccak256, ZeroAddress } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { createLiveBrowserFixture, FIXTURE_ACCOUNT, FIXTURE_OTHER_ACCOUNT } from './live-browser-fixture.mjs';
import { GENESIS_ARTIFACT_DIGEST, PORTFOLIO_MANIFEST_KEYS } from '../lib/live-config.mjs';
export const address=n=>getAddress(`0x${n.toString(16).padStart(40,'0')}`);
export const PORTFOLIOS = [address(0x901),address(0x902)];
const binds=new Interface(['function implementation() view returns(address)','function owner() view returns(address)']);
const thresholdView=new Interface(['function saleReviewThresholdBps() view returns(uint16)']);
const code='0x60006000';
export function portfolioFixture(options={}) {
  const base=createLiveBrowserFixture({isOperator:true,...options.baseOptions}), calls=[], simulations=[];
  const extra=Object.fromEntries(PORTFOLIO_MANIFEST_KEYS.map((key,i)=>[key,address(0x801+i)]));
  const manifest={...base.manifest,...extra,kind:'integrated-v2',
    artifactDigest:options.stage==='genesis'?GENESIS_ARTIFACT_DIGEST:base.manifest.artifactDigest,
    codehash:{...base.manifest.codehash,...Object.fromEntries(PORTFOLIO_MANIFEST_KEYS.map(key=>[key,keccak256(code)]))}};
  const config={status:'ready',stage:options.stage??'fresh-active',...manifest,manifest,origin:'http://127.0.0.1:3198',indexBaseUrl:'http://127.0.0.1:3198/api/chain-index',journalBase:'/api/journal'};
  const state={...options,account:base.account,beforeRead:null};
  const same=(a,b)=>a.toLowerCase()===b.toLowerCase();
  const source=()=>({...base.source(),portfolioFactory:extra.portfolioFactory,portfolioMarket:extra.portfolioMarket});
  const request=async input=>{
    calls.push(input);const {method,params=[]}=input;await state.beforeRead?.(input);
    if(/sign|sendTransaction/.test(method))throw new Error('Read fixture refuses signing');
    if(method==='eth_getStorageAt'&&same(params[0],extra.portfolioFactory))return `0x${(state.wrongImplementation?address(77):extra.portfolioFactoryImplementation).slice(2).padStart(64,'0')}`;
    if(method==='eth_getStorageAt'&&[extra.portfolioMarket,manifest.shareMarket].some(a=>same(a,params[0])))return `0x${(state.wrongMarketImplementation&&same(params[0],extra.portfolioMarket)?address(78):address(79)).slice(2).padStart(64,'0')}`;
    if(method==='eth_getCode'&&Object.values(extra).some(a=>same(a,params[0])))return state.badCode?'0x6001':code;
    if(method!=='eth_call')return base.request(input);
    if(params[0].data===thresholdView.encodeFunctionData('saleReviewThresholdBps')){
      const threshold=PORTFOLIOS.some(a=>same(a,params[0].to))?state.saleReviewThresholdBps:state.childReviewThresholdBps;
      if(threshold===undefined)throw new Error('old implementation');
      return thresholdView.encodeFunctionResult('saleReviewThresholdBps',[threshold]);
    }
    const tx=params[0];let contract=PORTFOLIOS.some(a=>same(a,tx.to))?abi.BudgetPortfolioVault
      :same(tx.to,extra.portfolioFactory)?abi.BudgetPortfolioFactory:same(tx.to,extra.portfolioMarket)?abi.ShareMarket
      :same(tx.to,extra.portfolioBeacon)?binds:same(tx.to,address(0x951))?abi.PoolVault:null;
    if(same(tx.to,manifest.shareMarket)){
      const marketRead=abi.ShareMarket.parseTransaction(tx);
      if(marketRead?.name==='saleReference'){
        if(state.referenceReadError)throw new Error('market reference unavailable');
        const quote=state.references?.[marketRead.args[0].toLowerCase()] || {};
        return abi.ShareMarket.encodeFunctionResult('saleReference',[
          quote.price??state.referencePrice??150n,quote.observedAt??state.referenceAt??BigInt(source().indexedTimestamp)-100n,
          quote.digest??state.referenceDigest??`0x${'11'.repeat(32)}`]);
      }
    }
    if(!contract)return base.request(input);
    if(params[1]!=='0x64'&&!(tx.from&&params[1]==='latest'))throw new Error('Unpinned portfolio read');
    const parsed=contract.parseTransaction(tx);if(!parsed)throw new Error('Unknown portfolio ABI');
    if(tx.from){simulations.push({transaction:tx,parsed});if(state.simulationFails)throw new Error('simulation reverted');return contract.encodeFunctionResult(parsed.fragment,parsed.fragment.outputs.map(output=>output.type==='address'?address(13):13n));}
    const member=parsed.args.length>0&&parsed.args[0]&&typeof parsed.args[0]==='string'&&same(parsed.args[0],base.account);
    const values={legacyFactory:manifest.factory,shareMarket:extra.portfolioMarket,beacon:extra.portfolioBeacon,operator:base.account,
      implementation:extra.portfolioImplementation,owner:manifest.timelock,timelock:manifest.timelock,factory:extra.portfolioFactory,OFFICIAL_FACTORY:extra.portfolioFactory,
      isPool:state.foreign!==true,portfolioCount:2n,state:state.poolState??(same(tx.to,PORTFOLIOS[1])?2n:0n),budgetWei:5000000000000000n,
      absoluteCapWei:3000000000000000n,unitCapWei:100000000000n,spentWei:0n,totalSupply:50n,memberCount:2n,
      childCount:state.childCount??0n,activeChildCount:0n,fundingDeadline:BigInt(source().indexedTimestamp)+86400n,
      purchaseDeadline:BigInt(source().indexedTimestamp)+3n*86400n,fundingFailed:false,refundPerShareWei:2n,salePerShareWei:3n,
      activeProposalId:state.activeProposalId??0n,nextProposalId:state.nextProposalId??1n,
      nextRoundAt:state.nextRoundAt??0n,shareTradingAllowed:state.trading??true,balanceOf:member?(state.shares??10n):0n,
      activatedAt:state.childActivatedAt??BigInt(source().indexedTimestamp)-8n*86400n,
      claimableBem:member?100n:0n,bnbOwed:member?(state.bnbOwed??7n):0n,refundSettled:state.refundSettled??false,saleDebt:member?(state.saleDebt??5n):0n,lockedShares:member?(state.lockedShares??0n):0n,
      feeBps:100n,buyerFeeBps:state.buyerFeeBps??100n,orderExpiresAt:BigInt(source().indexedTimestamp)+86400n,
      orders:{seller:FIXTURE_OTHER_ACCOUNT,pool:PORTFOLIOS[0],remaining:5n,pricePerUnit:100n,active:true},
      proposals:(parsed.name==='proposals'&&state.proposals
        ? state.proposals[Number(parsed.args[0]-(state.activeProposalId??0n))]:null)??state.proposal??{child:address(0x951),price:100n,referencePrice:100n,referenceAt:1n,
        endsAt:BigInt(source().indexedTimestamp)+86400n,memberCount:2n,yesMembers:2n,yesShares:59n,executed:false},
      hasVoted:false,childInfo:{collection:state.childCollection??address(0x952),tokenId:1n,purchaseCost:state.childCost??150n,
        official:true,sold:state.childSold??false},
      childSaleReview:(parsed.name==='childSaleReview'?state.reviewStatuses?.[String(parsed.args[0])]:null)??state.reviewStatus??0n,
    };
    if(parsed.name==='childSaleReview'&&(state.stage==='genesis'||state.reviewReadError))
      throw new Error('child sale review unavailable');
    if(!(parsed.name in values))throw new Error(`Unknown portfolio fixture read ${parsed.name}`);
    if(parsed.name==='proposals'||parsed.name==='childInfo')
      return contract.encodeFunctionResult(parsed.fragment,
        parsed.fragment.outputs.map(output=>values[parsed.name][output.name]));
    return contract.encodeFunctionResult(parsed.fragment,[values[parsed.name]]);
  };
  const index=url=>{
    const u=new URL(url),path=u.pathname;
    if(path.endsWith('/portfolios'))return {source:source(),data:{items:PORTFOLIOS.map(pool=>({address:pool,kind:'portfolio',factory:extra.portfolioFactory,createdBlock:95,budgetWei:'5000000000000000',absoluteCapWei:'3000000000000000',unitCapWei:'100000000000'})),nextCursor:null}};
    if(path.endsWith('/portfolio-orders'))return {source:source(),data:{items:[{orderId:'1',pool:PORTFOLIOS[0],seller:FIXTURE_OTHER_ACCOUNT,remaining:'5',pricePerUnitWei:'100'}],nextCursor:null}};
    if(path.endsWith('/v1/yield')&&PORTFOLIOS.some(pool=>same(pool,u.searchParams.get('pool')||''))){
      const days=Number(u.searchParams.get('days')||7),last=new Date((source().indexedTimestamp+28800)*1000).toISOString().slice(0,10);
      return {source:source(),data:{scope:'portfolio',pool:u.searchParams.get('pool'),account:u.searchParams.get('account')||null,timezone:'Asia/Shanghai',token:'BEM',tokenDecimals:8,accountUnclaimedDailyAccrual:null,
        buckets:Array.from({length:days},(_,i)=>({date:new Date(Date.parse(`${last}T00:00:00Z`)-(days-i-1)*86400000).toISOString().slice(0,10),poolHarvestNetAtomic:'100000000',accountClaimedAtomic:u.searchParams.get('account')?'50000000':null}))}};
    }
    if(path.endsWith('/v1/activity')&&PORTFOLIOS.some(pool=>same(pool,u.searchParams.get('pool')||'')))return {source:source(),data:{items:[],nextCursor:null}};
    return base.index(url);
  };
  const fetcher=async url=>({ok:true,status:200,redirected:false,headers:new Headers({'content-type':'application/json'}),text:async()=>JSON.stringify(index(url))});
  return {base,state,manifest,config,request,provider:{request},index,fetcher,calls,simulations,source,account:base.account};
}
