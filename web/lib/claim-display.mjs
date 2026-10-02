const ADDRESS=/^0x[\da-f]{40}$/i,HASH=/^0x[\da-f]{64}$/i;
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const actions={BEM:{claim:'0x4e71d92d',claimBem:'0x63274d60'},BNB:{withdrawBnb:'0x1da0603a'}};
const events={BEM:'BemClaimed',BNB:'BnbWithdrawn'};
const number=value=>typeof value==='bigint'&&value>=0n?value
  :typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?BigInt(value)
    :typeof value==='string'&&/^(?:0x[\da-f]+|0|[1-9]\d*)$/i.test(value)?BigInt(value):null;
const amount=value=>typeof value==='bigint'&&value>=0n?value
  :typeof value==='string'&&/^(0|[1-9]\d*)$/.test(value)?BigInt(value):null;
const success=value=>value===1||value==='1'||value==='0x1';
const confirmedTime=value=>typeof value==='number'&&Number.isFinite(value)?value
  :typeof value==='string'?Date.parse(value):NaN;

function receiptEvidence(record,{pool,account,currency}) {
  const action=record?.action?.kind??record?.action,hash=record?.hash??record?.transactionHash;
  if(record?.status!=='confirmed'||!same(record.account,account)||!same(record.target,pool)
    ||!actions[currency][action]||!HASH.test(hash??'')
    ||record.chainId!==undefined&&number(record.chainId)!==56n)return null;
  const receipt=record.receipt,block=number(receipt?.blockNumber??record.blockNumber);
  if(block===null)return null;
  if(receipt) {
    if(record.finalized!==true||!success(receipt.status)||!same(receipt.to,pool)
      ||!same(receipt.transactionHash,hash)||!HASH.test(receipt.blockHash??'')
      ||receipt.from!==undefined&&!same(receipt.from,account))return null;
  } else {
    // Restored wallet records must still identify the exact zero-value claim
    // call, rather than relying on a generic success popup or an action label.
    if(!same(record.data,actions[currency][action])||number(record.value)!==0n)return null;
  }
  return {kind:'receipt',hash,blockNumber:block,confirmedAt:confirmedTime(record.confirmedAt)};
}

function activityEvidence(row,{pool,account,currency}) {
  if(row?.event!==events[currency]||!same(row.contract,pool)||!same(row.pool,pool)
    ||row.confirmed===false||row.status!==undefined&&row.status!=='confirmed'
    ||!HASH.test(row.transactionHash??'')||!HASH.test(row.blockHash??''))return null;
  const owners=[row.fields?.user,row.fields?.member].filter(value=>value!==undefined);
  if(!owners.length||owners.some(owner=>!same(owner,account))||amount(row.fields?.amount)===null
    ||amount(row.fields.amount)===0n)return null;
  const block=number(row.blockNumber);
  if(block===null)return null;
  return {kind:'activity',hash:row.transactionHash,blockNumber:block,amount:amount(row.fields.amount),confirmedAt:NaN};
}

/** Display feedback only. It does not authorize, sign, poll or submit a claim. */
export function claimDisplayState({pool,account,currency,balance,transactions=[],activity=[],balanceBlock,
  now=Date.now(),confirmationWindowMs=120_000}={}) {
  if(!actions[currency])throw new Error('Unknown claim currency.');
  const known=amount(balance),labels={
    connect:['连接钱包', 'Connect wallet'], available:[`领取 ${currency}`,`Claim ${currency}`],
    claimed:[`已领取 ${currency}`,`${currency} claimed`], empty:[`暂无可领取 ${currency}`,`No ${currency} to claim`],
    confirmed:[`本次 ${currency} 领取已确认`,`${currency} claim confirmed`],
    unavailable:[`${currency} 余额暂未读取`,`${currency} balance unavailable`],
  };
  const evidence=[];
  if(ADDRESS.test(pool??'')&&ADDRESS.test(account??'')) {
    for(const record of transactions??[]){const item=receiptEvidence(record,{pool,account,currency});if(item)evidence.push(item);}
    for(const row of activity??[]){const item=activityEvidence(row,{pool,account,currency});if(item)evidence.push(item);}
  }
  const latest=evidence.reduce((chosen,item)=>!chosen||item.blockNumber>chosen.blockNumber?item:chosen,null);
  const recent=evidence.filter(item=>item.kind==='receipt'&&Number.isFinite(item.confirmedAt)
    &&now>=item.confirmedAt&&now-item.confirmedAt<confirmationWindowMs)
    .reduce((chosen,item)=>!chosen||item.blockNumber>chosen.blockNumber?item:chosen,null);
  const at=number(balanceBlock),olderBalance=!!recent&&at!==null&&at<recent.blockNumber;
  const state=!ADDRESS.test(account??'')?'connect'
    :olderBalance?'confirmed':known!==null&&known>0n?'available'
      :known===0n?latest?'claimed':'empty':recent?'confirmed':'unavailable';
  return {state,canClaim:state==='available',amount:known,balanceKnown:known!==null,
    evidence:state==='confirmed'?recent:latest,labelZh:labels[state][0],labelEn:labels[state][1],
    updating:state==='confirmed',hintZh:state==='confirmed'?'领取交易已成功，正在更新余额。':'',
    hintEn:state==='confirmed'?'The claim succeeded; the balance is updating.':''};
}
