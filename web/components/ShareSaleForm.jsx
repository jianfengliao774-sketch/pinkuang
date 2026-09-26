'use client';
import {useState} from 'react';
import {useI18n} from '../lib/i18n';
import {demoAvailableShares,demoShareTradingAllowed} from '../lib/economics';
export default function ShareSaleForm({pools,initialPoolId,onCreate}){
 const {t}=useI18n();
 const eligible=pools.filter(p=>demoAvailableShares(p)>0&&demoShareTradingAllowed(p));
 const [id,setId]=useState(initialPoolId||eligible[0]?.id||'');
 const [shares,setShares]=useState(5),[price,setPrice]=useState('0.068');
 const pool=eligible.find(p=>p.id===id);
 const valid=pool&&Number.isInteger(shares)&&shares>=1&&shares<=demoAvailableShares(pool)&&Number.isFinite(Number(price))&&Number(price)>0;
 return <><h2 id="dialog-title">{t('出售我的份额')}</h2><label className="field-label">{t('矿机')}<select value={id} onChange={e=>setId(e.target.value)}>{eligible.map(p=><option key={p.id} value={p.id}>{p.name} #{p.id} · {t('{count} 份',{count:demoAvailableShares(p)})}</option>)}</select></label><div className="sale-fields"><label className="field-label">{t('本次挂牌')}<input type="number" min="1" max={pool?demoAvailableShares(pool):0} step="1" value={shares} onChange={e=>setShares(e.target.value===''?'':Number(e.target.value))}/></label><label className="field-label">{t('每份价格')} · BNB<input type="number" min="0.00001" step="0.00001" value={price} onChange={e=>setPrice(e.target.value)}/></label></div><div className="confirm-lines"><div><span>{t('全部成交后实收')}</span><strong>{valid?(shares*Number(price)*.99).toFixed(5):'—'} BNB</strong></div></div><div className="inline-note">{t('仅可挂牌未锁定份额，有效期 7 天。投票冻结时不能新增挂单或成交，但可撤单；到期后任何人可解锁。卖方承担 1% 成交费。')}</div>{!eligible.length&&<p>{t('暂无可转让的矿机份额')}</p>}<button className="btn" disabled={!valid} onClick={()=>onCreate({pool:id,shares,price:Number(price)})}>{t('创建演示挂单')}</button></>;
}
