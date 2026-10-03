import { parseEther } from 'ethers';
import { dailyCapToWeightCap } from './portfolio-daily-cap.mjs';

function positiveBnb(value,label){
  if(typeof value!=='string'||!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value.trim()))
    throw new Error(`${label}请输入精确 BNB 金额，最多 18 位小数。`);
  const wei=parseEther(value.trim());
  if(wei<=0n)throw new Error(`${label}必须大于 0 BNB。`);
  return wei;
}

/** UI validation only; the contract independently enforces wei-denominated caps. */
export function portfolioCreateForm({budget,absoluteCap,dailyCap,capacitySample,fundHours,buyHours}){
  const total=positiveBnb(budget,'募集预算');
  if(total%100n!==0n)throw new Error('募集预算需能平均分为 100 份，最多保留 16 位小数。');
  const perMiner=positiveBnb(absoluteCap,'单机价格上限');
  const unitCap=dailyCapToWeightCap(dailyCap,capacitySample);
  if(perMiner>total)throw new Error('单机价格上限不能超过募集预算。');
  if(!/^[1-9]\d{0,2}$/.test(fundHours)||!/^[1-9]\d{0,2}$/.test(buyHours))
    throw new Error('募集期与购机期请输入 1–999 的整数小时。');
  return {budget:budget.trim(),absoluteCap,dailyCap,unitCap,fundHours,buyHours};
}
