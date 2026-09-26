import {useState} from 'react';
import {Pause,Play,ArrowRight,ArrowUpRight,Layers3,Users,Activity,Wallet,ShieldCheck,Vote,ChevronRight} from 'lucide-react';
import {platformTotals} from '../lib/platform-stats';
import {useI18n} from '../lib/i18n';
import HeroScene from './HeroScene';
import CommunityPattern from './CommunityPattern';
import BemPriceStat from './BemPriceStat';
import purposeArt from '../lib/purpose-art.json';
const fmt=(n,d=0)=>Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
export default function SiteOverview({pools,onExplore,onAccount,onRules,onRecords}){
 const {t,locale}=useI18n();
 const [motionPaused,setMotionPaused]=useState(false);
 const stats=platformTotals(pools),groups=[['Funding','募集中','一起出资，开启下一台矿机。'],['Active','挖矿中','共同持有，按份额分享产出。'],['Listed','整机出售中','共同决定，让矿机有序流转。']];
 return <div className="bemine-home">
  <section className={`bemine-hero${motionPaused?' motion-paused':''}`}>
   <HeroScene/><div className="bemine-hero-shade"/>
   <div className="bemine-hero-copy">
    <div className="bemine-hero-kicker"><span/>{t('拼矿 BEMine · 一起参与 TapeOut')}</div>
    <h1>{t('一份投入，十分热爱，')}<br/><em>{t('百分参与，万份回报。')}</em></h1>
    <p>{t('从一份矿机开始，与更多 Tapeouters 共同持有、共享产出，参与 TapeOut 的每一步成长。')}</p>
    <div className="bemine-hero-actions"><button className="btn" onClick={()=>onExplore('募集中')}>{t('寻找我的第一份矿机')}<ArrowRight size={17}/></button><button className="bemine-hero-link" onClick={onRules}>{t('了解如何参与')}<ArrowUpRight size={16}/></button></div>
    <small>{t('「万份回报」为品牌愿景，不代表收益承诺。实际产出会随矿机及协议状态变化。')}</small>
   </div>
   <button className="bemine-motion-toggle" aria-label={t(motionPaused?'播放背景动效':'暂停背景动效')} aria-pressed={motionPaused} onClick={()=>setMotionPaused(v=>!v)}>{motionPaused?<Play size={14}/>:<Pause size={14}/>}<span>{t(motionPaused?'播放动效':'暂停动效')}</span></button>
  </section>
  <section className="bemine-purpose" id="vision"><div className="bemine-section-heading"><div><span className="bemine-kicker">OUR PURPOSE</span><h2>{t('初衷愿景')}</h2></div></div><div className="bemine-vision"><div className="bemine-vision-art"><img src={`${process.env.NEXT_PUBLIC_BASE_PATH||''}/images/${purposeArt.file}`} width={purposeArt.width} height={purposeArt.height} loading="lazy" decoding="async" alt={t('Tapeouters 围绕共同持有的矿机，一起建设生态')}/></div><div className="bemine-vision-copy"><h3>{t('让每一位 Tapeouter，都能享受挖矿的乐趣。')}</h3><p>{t('我们相信，参与 TapeOut 不应只属于少数人。无论投入多少，每一份热爱都值得有一个参与的入口。')}</p><p>{t('BEMine 希望通过共同持有矿机，降低独自购机的资金门槛，让每一位 Tapeouter 在参与生态建设的同时，也有能力享受挖矿的乐趣。')}</p><strong>{t('从一份开始，一起建设，一起成长。')}</strong></div></div></section>
  <section className="bemine-network"><div className="bemine-section-heading"><div><span className="bemine-kicker">TOGETHER IN TAPEOUT</span><h2>{t('每一份参与，都在这里汇聚。')}</h2></div><span className="bemine-data-label">{t('平台统计 · 演示数据')}</span></div><div className="bemine-stat-grid">{[
   ['累计立项',stats.projects,'个',Layers3,'拼矿已创建项目'],['参与 Tapeouters',stats.participants,'位',Users,'按参与地址去重'],['管理矿机',stats.managed,'台',Wallet,'已完成购机并管理'],['当前预估日产',stats.daily,'BEM',Activity,'全机产出 · 分配前']
  ].map(([name,value,unit,Icon,note],i)=><div className="bemine-stat" key={name}><div><span>{t(name)}</span><Icon size={18}/></div><strong>{fmt(value,i>2?4:0)}<small>{t(unit)}</small></strong><p>{t(note)}</p></div>)}<BemPriceStat/></div><p className="bemine-data-note">{t('平台统计用于页面演示，不代表实际运营规模；币价为独立行情。参与人数按钱包地址统计，筹款中的目标矿机不计入已管理矿机与当前日产。')}</p></section>
  <section className="bemine-projects"><div className="bemine-section-heading"><div><span className="bemine-kicker">FIND YOUR SHARE</span><h2>{t('找到属于你的参与方式。')}</h2></div><button className="text-button" onClick={()=>onExplore('项目总览')}>{t('查看项目总览')}<ArrowRight size={16}/></button></div><div className="bemine-stage-grid">{groups.map(([status,title,desc],i)=>{const list=pools.filter(p=>status==='Funding'?['Funding','Funded'].includes(p.status):p.status===status);return <button className="bemine-stage" key={status} onClick={()=>onExplore(title)}><div><span>0{i+1} / {t(title)}</span><ChevronRight size={19}/></div><strong>{list.length}<small>{locale==='en'?(list.length===1?'project':'projects'):'个项目'}</small></strong><p>{t(desc)}</p><footer>{status==='Funding'?t('剩余 {count} 份可参与',{count:list.reduce((n,p)=>n+100-p.funded,0)}):t('全机预估日产 {amount} BEM',{amount:fmt(list.reduce((n,p)=>n+p.daily,0),2)})}<ArrowUpRight size={16}/></footer></button>})}</div></section>
  <section className="bemine-why"><div><span className="bemine-kicker">YOUR SHARE. YOUR VOICE.</span><h2>{t('一起拼矿，')}<br/>{t('也一起决定。')}</h2><p>{t('资产有归属，产出有记录，')}<br/>{t('重大事项由共同持有人参与决定。')}</p><button className="text-button" onClick={onRules}>{t('了解平台规则')}<ArrowRight size={15}/></button></div><div className="bemine-benefits">{[[Layers3,'从 1 份开始','每台矿机共有 100 份，单地址可认购全部份额。'],[Activity,'按份分享真实产出','产出先归集到池子，个人按份领取；已入账收益永久保留。'],[Vote,'共同参与重要决策','地址数须过半；折价出售需至少 60 份赞成，其余需超过 50 份。'],[ShieldCheck,'把记录摆在明处','查看归集、分配与本人领取记录，了解每一份权益。']].map(([Icon,title,desc])=><article key={title}><Icon size={23}/><h3>{t(title)}</h3><p>{t(desc)}</p></article>)}</div></section>
  <section className="bemine-life"><CommunityPattern/><div className="bemine-life-copy"><span>GROW WITH THE COMMUNITY</span><h2>{t('共持BEM矿机，共享BEM人生')}</h2><p>{t('让参与更轻一点，让每一份选择更清楚一点。')}</p></div><div><button className="btn" onClick={onAccount}>{t('查看我的资产')}<ArrowRight size={17}/></button><button className="bemine-hero-link" onClick={onRecords}>{t('查看公开记录')}<ArrowUpRight size={15}/></button></div></section>
 </div>
}
