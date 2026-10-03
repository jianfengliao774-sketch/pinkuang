import { getAddress } from 'ethers';
import { abi } from './chain-client.mjs';
import { isFreshUserExit } from '../../deploy/shared/fresh-user-exits.mjs';
export { isFreshUserExit } from '../../deploy/shared/fresh-user-exits.mjs';
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
export function freshUserExitReady(config,targetType,action){
  return config?.stage==='fresh-active' && config.userExitReady===true && config.stale!==true
    && config.readMode==='current' && isFreshUserExit(targetType,action,0n);
}
/** Exact canonical calldata is mandatory even when checking the pre-wallet exit exception. */
export function isFreshUserExitTransaction(config,transaction,action){
  try{
    if(config?.stage!=='fresh-active'||BigInt(transaction.chainId)!==56n||BigInt(transaction.value??0)!==0n)return false;
    const target=getAddress(transaction.to), budget=typeof action==='object'
      && ['portfolio','portfolioMarket','portfolioFactory'].includes(action?.targetType);
    const factory=budget?config.portfolioFactory:config.factory,market=budget?config.portfolioMarket:config.shareMarket;
    const targetType=same(target,factory)?(budget?'portfolioFactory':'factory')
      :same(target,market)?(budget?'portfolioMarket':'market'):(budget?'portfolio':'pool');
    if(budget&&targetType!==action.targetType)return false;
    const contract=targetType==='pool'?abi.PoolVault:targetType==='portfolio'?abi.BudgetPortfolioVault
      :['market','portfolioMarket'].includes(targetType)?abi.ShareMarket:null;
    const parsed=contract?.parseTransaction({data:transaction.data,value:0n}),kind=typeof action==='string'?action:action?.kind;
    return !!parsed && (parsed.name===kind||kind==='withdraw'&&parsed.name==='withdrawBnb')
      && same(contract.encodeFunctionData(parsed.fragment,parsed.args),transaction.data)
      && isFreshUserExit(targetType,parsed.name,0n);
  }catch{return false;}
}
