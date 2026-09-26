import {pools,orders,ledger} from './demo-data';
import {SORT_OPTIONS} from './catalog';
const scenarios=[];
function add(id,title,group,entry,state={},note=''){scenarios.push({id,title,group,entry,state,note});}
const main='01 · 主页面';
add('A01','贝矿总览 · 完整首页',main,'首页 / #home',{route:'home'},'包括首屏、初衷愿景、平台统计、项目入口、权益说明和底部宣传语。');
add('A02','资产总览 · 未连接钱包',main,'未连接时直接访问 #overview',{route:'overview'});
add('A03','资产总览 · 已连接 · 近7天',main,'连接钱包 → 使用演示账户',{route:'overview',connected:true});
add('A04','资产总览 · 近30天',main,'资产总览 → 近30天',{route:'overview',connected:true,range:'30D'});
add('A05','交易市场 · 份额交易',main,'交易市场 → 份额交易',{route:'market',connected:true});
add('A06','交易市场 · 整机出售',main,'交易市场 → 整机出售',{route:'market',marketTab:'整机出售',connected:true});
add('A07','收益中心 · 待领取',main,'收益中心 / #rewards',{route:'rewards',connected:true});
add('A08','共同决策 · 待投票',main,'共同决策 / #governance',{route:'governance',connected:true});
for(const [i,tab] of ['全部记录','收益分配','收益领取','BEM 销毁'].entries())add(`A${String(9+i).padStart(2,'0')}`,`公开记录 · ${tab}`,main,`公开记录 → ${tab}`,{route:'records',recordFilter:tab});
const catalog='02 · 拼矿列表与筛选';
for(const [i,tab] of ['项目总览','募集中','挖矿中','整机出售中'].entries())add(`B0${i+1}`,`参与拼矿 · ${tab}`,catalog,`参与拼矿 → ${tab}`,{route:'pools',filter:tab});
add('B05','筛选面板 · 全部条件',catalog,'参与拼矿 → 筛选',{route:'pools',filter:'募集中',catalog:{filterOpen:true}});
add('B06','搜索与筛选 · 已筛选结果',catalog,'搜索8204；系列选Behemoth，来源选Firsto',{route:'pools',filter:'挖矿中',catalog:{filterOpen:true,query:'8204',filters:{series:'BEHEMOTH',source:'firsto'}}});
add('B07','无结果 · 单分类',catalog,'募集中 → 搜索999999',{route:'pools',filter:'募集中',catalog:{query:'999999'}});
add('B08','无结果 · 项目总览三组',catalog,'项目总览 → 搜索999999',{route:'pools',catalog:{query:'999999'}});
add('B09','筛选校验 · 最低值大于最高值',catalog,'筛选 → 最低日产2，最高日产1',{route:'pools',filter:'募集中',catalog:{filterOpen:true,filters:{dailyMin:'2',dailyMax:'1'}}});
for(const [i,[sort,label]] of SORT_OPTIONS.entries())add(`B${10+i}`,`排序 · ${label}`,catalog,`募集中 → 排序 → ${label}`,{route:'pools',filter:'募集中',catalog:{sort}},'同一列表的排序结果；六个排序选项均列入审查。');
const detail='03 · 六台矿机详情';
let d=0;
for(const p of pools)for(const tab of ['资产详情','收益记录','共同决策','参与者'])add(`C${String(++d).padStart(2,'0')}`,`${p.name} #${p.id} · ${tab}`,detail,`#detail/${p.id} → ${tab}`,{route:'detail',poolId:p.id,detailTab:tab,connected:true},tab==='收益记录'?'当前所有矿机共用同一份演示流水，并非按矿机过滤。':tab==='共同决策'?'当前按钮统一跳转 #8204 的演示提案。':'');
const dialogs='04 · 弹窗';
const modal=(type,extra={})=>({type,...extra});
[
 ['连接钱包 · 未连接','顶栏 → 连接钱包',{route:'home',modal:modal('wallet')}],
 ['账户管理 · 已连接','顶栏 → 账户地址',{route:'overview',connected:true,modal:modal('wallet')}],
 ['认购确认','募集中详情 → 确认认购',{route:'detail',poolId:'16928',qty:5,connected:true,modal:modal('subscribe')}],
 ['领取BEM收益','收益中心 → 领取收益',{route:'rewards',connected:true,modal:modal('claim')}],
 ['领取BNB款项','收益中心 → 查看款项',{route:'rewards',connected:true,modal:modal('bnb')}],
 ['投票 · 确认赞成','共同决策 → 赞成出售',{route:'governance',connected:true,modal:modal('vote',{choice:'yes'})}],
 ['投票 · 确认反对','共同决策 → 反对',{route:'governance',connected:true,modal:modal('vote',{choice:'no'})}],
 ['买入矿机份额','交易市场 → #8204买入',{route:'market',connected:true,qty:1,modal:modal('buy',{order:orders[1]})}],
 ['出售我的份额','交易市场 → 出售我的份额',{route:'market',connected:true,modal:modal('sell')}],
 ['购买整台矿机','交易市场 → 整机出售 → 购买整台矿机',{route:'market',marketTab:'整机出售',connected:true,modal:modal('whole')}],
 ['执行矿机挂牌','赞成投票达标后 → 执行挂牌',{route:'governance',voted:'yes',connected:true,modal:modal('execute')}],
 ['发起出售提案 · 已有提案提示','共同决策 → 发起出售提案',{route:'governance',connected:true,modal:modal('proposal')}],
 ['最优质保 · 筹备说明','侧栏 → 最优质保',{route:'home',modal:modal('quality')}],
 ['矿机质押 · 未开放说明','侧栏 → 矿机质押',{route:'home',modal:modal('finance')}],
 ['合约与矿机身份','矿机详情 → 矿机身份 / 公开记录 → 查看合约信息',{route:'detail',poolId:'16210',modal:modal('identity')}],
 ['公开记录详情','公开记录 → 记录编号',{route:'records',modal:modal('record',{record:ledger[0]})}],
 ['参与规则 · 完整内容','参与指南 / 平台规则',{route:'home',modal:modal('rules')}]
].forEach(([title,entry,state],i)=>add(`D${String(i+1).padStart(2,'0')}`,title,dialogs,entry,state));
const states='05 · 完成、空态与校验';
const funded=pools.map(p=>p.id==='17006'?{...p,funded:100,shares:9,cost:.432,members:22,status:'Funded'}:p);
add('E01','认购完成 · 待购机详情',states,'#17006 → 认购最大9份 → 确认',{route:'detail',poolId:'17006',connected:true,pools:funded,toast:'演示认购成功：{count} 份',toastParams:{count:9}},'这是现有流程可到达的状态。当前时间线误显示全部完成、已运行0天，保留原样供审查。');
add('E02','满募后 · 列表待购机',states,'完成E01后 → 参与拼矿 → 募集中',{route:'pools',filter:'募集中',pools:funded,connected:true});
add('E03','认购份数 · 非法数量',states,'#16928 → 份数填0',{route:'detail',poolId:'16928',qty:0,connected:true},'0、空白、小数和超过最大值共用此行内错误与禁用按钮。');
add('E04','收益中心 · 已领取',states,'领取收益 → 演示领取全部收益',{route:'rewards',claimed:true,connected:true,toast:'演示领取完成：0.6842 BEM'});
add('E05','资产总览 · 领取后联动',states,'完成领取 → 资产总览',{route:'overview',claimed:true,connected:true},'可领取归零，即将到期待办消失。');
add('E06','共同决策 · 已赞成并达标',states,'赞成出售 → 确认演示投票',{route:'governance',voted:'yes',connected:true,toast:'演示投票已记录'});
add('E07','共同决策 · 已反对',states,'反对 → 确认演示投票',{route:'governance',voted:'no',connected:true,toast:'演示投票已记录'});
add('E08','交易市场 · 我的挂单有数据',states,'出售我的份额 → 创建演示挂单',{route:'market',listed:true,connected:true,toast:'演示挂单已创建'});
add('E09','交易市场 · 撤销后空态',states,'我的挂单 → 撤销挂单',{route:'market',connected:true,toast:'演示挂单已撤销，5 份已解锁'});
add('E10','买入校验 · 数量无效',states,'份额买入 → 数量填0',{route:'market',connected:true,qty:0,modal:modal('buy',{order:orders[1]})});
add('E11','买入校验 · 超过49份上限',states,'买入#16210 → 确认演示买入',{route:'market',connected:true,qty:1,modal:modal('buy',{order:orders[0]}),toast:'超过单个地址 49 份的持仓上限'});
add('E12','买入成功提示',states,'买入#8204 → 确认演示买入',{route:'market',connected:true,toast:'已完成份额买入流程演示'},'现有演示只显示提示，未更新持仓。');
add('E13','整机购买完成提示',states,'整机出售 → 确认演示购买',{route:'market',marketTab:'整机出售',connected:true,toast:'已完成整机购买流程演示，不发生实际过户'});
add('E14','执行挂牌完成提示',states,'投票达标 → 执行挂牌 → 确认',{route:'governance',voted:'yes',connected:true,toast:'已完成挂牌执行流程演示'},'现有演示仅显示提示，提案卡仍保留执行按钮。');
add('E15','BNB领取流程完成提示',states,'查看款项 → 体验领取流程',{route:'rewards',connected:true,toast:'已完成 BNB 领取流程演示'},'现有演示未将待领取BNB金额归零。');
add('E16','公开记录 · 导出提示',states,'公开记录 → 导出CSV',{route:'records',toast:'演示记录已导出'});
add('E17','收益中心 · 刷新提示',states,'收益中心 → 刷新记录',{route:'rewards',connected:true,toast:'演示记录已刷新'});
add('E18','退出演示账户',states,'顶栏账户 → 退出演示账户',{route:'home',toast:'已退出演示账户'});
add('E19','手机导航 · 展开',states,'手机顶部 → 打开导航',{route:'market',menu:true},'请切换手机尺寸查看侧栏抽屉和遮罩。电脑尺寸下显示常规侧栏。');
export const reviewScenarios=scenarios;
export const reviewGaps=[
 {title:'矿机质押、最优质保',detail:'目前只有说明弹窗，没有出资、借款、回赎、申请质保等业务页面。见D13、D14。'},
 {title:'退款、已结束项目',detail:'代码仅定义状态名称，尚无用户可到达的退款或项目结束流程；审查册不补画不存在的页面。'},
 {title:'真实钱包与交易状态',detail:'尚无真实钱包连接、签名、交易等待、拒签、网络错误或链上失败页面；现有按钮均为演示。'},
 {title:'待购机时间线',detail:'满募后可进入待购机状态，但详情仍显示三步全部完成、已运行0天。见E01。'},
 {title:'矿机专属记录与投票',detail:'详情收益表共用全站演示流水；共同决策统一跳转同一个#8204提案。见C组。'},
 {title:'部分操作仅有完成提示',detail:'份额买入、整机购买、BNB领取、执行挂牌尚未更新完整的后续资产状态。见E12—E15。'},
 {title:'演示日期与数据',detail:'金额、人数及截止时间是固定演示值，不能当作实时业务数据；各页请同时审查文字与口径。'},
 {title:'品牌设计备选页',detail:'旧版 /design 是历史品牌方案页，不属于当前7个业务导航页面；作为附录单独提供入口。'}
];
