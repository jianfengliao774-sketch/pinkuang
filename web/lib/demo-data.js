// UI preview fixtures. This module is the boundary to replace with indexed and on-chain data.
export const pools = [
 {id:'16210',name:'TapeOut',series:'TAPEOUT',status:'Active',price:6.5,purchaseCost:6.5,daily:0.95,funded:100,members:24,shares:49,cost:3.5035,lockedShares:0,availableShares:49,shareTradingAllowed:true,color:'blue',gates:128,age:18},
 {id:'8204',name:'Behemoth',series:'BEHEMOTH',status:'Active',price:8.4,purchaseCost:8.4,daily:1.22,funded:100,members:18,shares:20,cost:1.848,lockedShares:0,availableShares:20,shareTradingAllowed:false,color:'violet',gates:256,age:12},
 {id:'15832',name:'TapeOut',series:'TAPEOUT',status:'Listed',price:5.5,purchaseCost:5.5,askingPrice:5.8,daily:0.8,funded:100,members:16,shares:23,cost:1.3915,lockedShares:0,availableShares:23,shareTradingAllowed:false,color:'teal',gates:96,age:26},
 {id:'16928',name:'TapeOut',series:'TAPEOUT',status:'Funding',price:6.8,daily:1.02,funded:68,members:12,shares:0,cost:0,color:'blue',gates:144,age:0},
 {id:'8316',name:'Behemoth',series:'BEHEMOTH',status:'Funding',price:9.2,daily:1.36,funded:42,members:9,shares:0,cost:0,color:'violet',gates:272,age:0},
 {id:'17006',name:'TapeOut',series:'TAPEOUT',status:'Funding',price:4.8,daily:0.69,funded:91,members:21,shares:0,cost:0,color:'teal',gates:112,age:0}
];
export const labels={Funding:'募集中',Funded:'待购机',Active:'挖矿中',Listed:'整机出售中',Closed:'已结束',Refunding:'可退款'};
export const navItems=[['home','拼矿总览'],['overview','资产总览'],['pools','参与拼矿'],['market','矿机转让'],['rewards','收益中心'],['governance','共同决策'],['records','公开记录']];
export const rewards=[{id:'r1',pool:'16210',day:'09.24',amount:0.2886},{id:'r2',pool:'8204',day:'09.23',amount:0.2318},{id:'r3',pool:'15832',day:'09.18',amount:0.1638}];
export const orders=[{id:1,pool:'16210',shares:8,price:.068,seller:'0x82a6…90C4'},{id:2,pool:'8204',shares:12,price:.086,seller:'0xF719…E124'},{id:3,pool:'16928',shares:0,price:0,seller:''},{id:4,pool:'16210',shares:5,price:.067,seller:'0x3De8…104B'}].filter(x=>x.shares);
export const ledger=[['2026.09.25 09:42','收益分配','TapeOut #16210','+0.2886','BEM','0x89b7…6e24'],['2026.09.24 16:18','份额认购','Behemoth #8204','−1.8480','BNB','0x3c1d…098a'],['2026.09.24 14:05','收益领取','TapeOut #16210','+0.4521','BEM','0x16f4…86c1'],['2026.09.23 18:06','收益分配','Behemoth #8204','+0.2318','BEM','0x827a…673e']];
