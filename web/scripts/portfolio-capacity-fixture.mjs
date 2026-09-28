/** Offline capacity fixture; no signatures or real chain writes. */
import assert from 'node:assert/strict';
import {Interface,ZeroAddress} from 'ethers';
import {abi} from '../lib/chain-client.mjs';
import {portfolioFixture,PORTFOLIOS,address} from './portfolio-fixture.mjs';
const nft=new Interface(['function ownerOf(uint256) view returns(address)']);
const collection='0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C';
export function capacityFixture({count=3,sold=[],pending=[],unknown,missing,duplicate=false,wrongOwner=false,reorg=false}={}){
  const f=portfolioFixture({poolState:2n}),children=Array.from({length:count},(_,i)=>address(0x1000+i)),requests=[],quotes=[];
  const now=Number(f.source().indexedTimestamp)*1000+1000;
  const request=async input=>{
    requests.push(input);const {method,params=[]}=input;
    if(method==='eth_getBlockByNumber'&&reorg&&quotes.length)return {...await f.request(input),hash:`0x${'ef'.repeat(32)}`};
    if(method!=='eth_call')return f.request(input);
    const tx=params[0],to=tx.to.toLowerCase(),childIndex=children.findIndex(c=>c.toLowerCase()===to);
    if(to===PORTFOLIOS[0].toLowerCase()){
      const parsed=abi.BudgetPortfolioVault.parseTransaction(tx),values={childCount:BigInt(count),activeChildCount:BigInt(count-sold.length)};
      if(parsed.name==='childAt'){if(Number(parsed.args[0])===missing)throw new Error('Missing child page');return abi.BudgetPortfolioVault.encodeFunctionResult(parsed.fragment,[children[duplicate&&Number(parsed.args[0])===count-1?0:Number(parsed.args[0])]]);}
      if(parsed.name==='childInfo'){const i=children.findIndex(c=>c.toLowerCase()===parsed.args[0].toLowerCase());assert(i>=0);return abi.BudgetPortfolioVault.encodeFunctionResult(parsed.fragment,[collection,BigInt(i+1),1000n,true,sold.includes(i)]);}
      if(parsed.name in values)return abi.BudgetPortfolioVault.encodeFunctionResult(parsed.fragment,[values[parsed.name]]);
    }
    if(childIndex>=0){assert.equal(params[1],'0x64');const parsed=abi.PoolVault.parseTransaction(tx),values={factory:f.manifest.factory,
      state:sold.includes(childIndex)||pending.includes(childIndex)?4n:2n,expiresAt:0n,activatedAt:1n,
      params:{circuits:collection,circuitId:BigInt(childIndex+1),targetRaise:100n,priceCap:100n,directSeller:ZeroAddress,directPrice:0n,fundingDeadline:100n,purchaseDeadline:200n}};
      assert(parsed.name in values);return abi.PoolVault.encodeFunctionResult(parsed.fragment,[values[parsed.name]]);
    }
    if(to===f.manifest.factory.toLowerCase()){
      const parsed=abi.PoolFactory.parseTransaction(tx);if(parsed.name==='isPool'&&children.some(c=>c.toLowerCase()===parsed.args[0].toLowerCase()))return abi.PoolFactory.encodeFunctionResult(parsed.fragment,[true]);
    }
    if(to===collection.toLowerCase()){const parsed=nft.parseTransaction(tx);return nft.encodeFunctionResult(parsed.fragment,[wrongOwner?address(88):children[Number(parsed.args[0])-1]]);}
    return f.request(input);
  };
  const quoteLoader=async(c,token)=>{quotes.push(token);if(Number(token)-1===unknown)throw new Error('Unavailable last child');return {asset:{collection:c,tokenId:token,owner:children[Number(token)-1],category:'official_mining',classification:'official_mining',mining:{status:'verified',tokenSymbol:'BEM',tokenDecimals:8,estimated24hAtomic:'100000001',sourceBlock:'100'}}};};
  return {...f,provider:{request},children,requests,quotes,input:{pool:PORTFOLIOS[0],now,quoteLoader}};
}
