import { validatePublicBaseUrl, isConfirmedDeposit, validShareBasePath } from './project-share.mjs';
const ADDRESS=/^0x[\da-f]{40}$/i,HASH=/^0x[\da-f]{64}$/i;
const valid=a=>typeof a==='string'&&ADDRESS.test(a)&&!/^0x0{40}$/i.test(a);
const same=(a,b)=>valid(a)&&valid(b)&&a.toLowerCase()===b.toLowerCase();
const sources=new Set(['tg','x','native']);
export function buildPortfolioShareUrl(base,pool,source){
  const trusted=validatePublicBaseUrl(base);if(!trusted||!valid(pool)||source!==undefined&&!sources.has(source))return null;
  const url=new URL(trusted);if(source)url.searchParams.set('source',source);url.hash=`portfolio/${pool.toLowerCase()}`;return url.href;
}
export function portfolioLandingUrl(base,pool,source){
  const direct=buildPortfolioShareUrl(base,pool,source);if(!direct)return null;
  const url=new URL('budget-share.html',validatePublicBaseUrl(base));url.searchParams.set('project',pool.toLowerCase());if(source)url.searchParams.set('source',source);return url.href;
}
export function resolvePortfolioShareTarget(search,basePath=''){
  if(basePath!==''&&!validShareBasePath(basePath))return null;basePath=basePath.replace(/\/$/,'');const params=new URLSearchParams(search);
  if([...params.keys()].some(k=>!['project','source'].includes(k)||params.getAll(k).length!==1))return null;
  const pool=params.get('project'),source=params.get('source');if(!valid(pool)||source!==null&&!sources.has(source))return null;
  return `${basePath}/${source?`?source=${source}`:''}#portfolio/${pool.toLowerCase()}`;
}
/** Presentation guard only. The journal layer must already have verified Deposited and finality. */
export function isConfirmedPortfolioDeposit(confirmation,project){
  return !!(project?.kind==='portfolio'&&confirmation?.targetType==='portfolio'
    &&same(confirmation.factory,project.OFFICIAL_FACTORY)&&same(confirmation.target,project.pool)
    &&isConfirmedDeposit(confirmation,project.pool)&&/^[1-9]\d*$/.test(String(confirmation.shares))&&BigInt(confirmation.shares)<=100n
    &&/^[1-9]\d*$/.test(String(confirmation.amountWei)));
}
export function createPortfolioShare({publicBaseUrl,project,confirmation,locale='zh'}={}){
  if(project?.kind!=='portfolio'||!valid(project.pool)||!valid(project.OFFICIAL_FACTORY)||!HASH.test(project.blockHash||'')
    ||typeof project.blockNumber!=='bigint'||project.blockNumber<0n)return null;
  const projectUrl=buildPortfolioShareUrl(publicBaseUrl,project.pool),url=portfolioLandingUrl(publicBaseUrl,project.pool);
  if(!url)return null;const en=locale==='en',title=en?'BEMine · Multi-miner portfolio':'拼矿 BEMine · 多矿机共同项目';
  const confirmed=isConfirmedPortfolioDeposit(confirmation,project);
  const funded=typeof project.totalSupply==='bigint'&&project.totalSupply>=0n&&project.totalSupply<=100n;
  const canSubscribe=project.state===0n&&funded&&project.totalSupply<100n&&typeof project.fundingDeadline==='bigint'
    &&typeof project.timestamp==='bigint'&&project.timestamp<project.fundingDeadline;
  const status=canSubscribe?(en?`${100n-project.totalSupply}/100 shares remain. Check current availability.`:`剩余 ${100n-project.totalSupply}/100 份，参与前请核对最新进度。`)
    :(en?'See the current project status and public records.':'查看项目最新状态与公开记录。');
  const text=[confirmed?(en?'I have joined a BEMine multi-miner portfolio.':'我已参与拼矿 BEMine 的多矿机共同项目。')
    :(en?'Explore a BEMine multi-miner portfolio.':'一起了解拼矿 BEMine 的多矿机共同项目。'),
    en?'100 project shares. Multiple miners. Shared decisions.':'整个项目 100 份，多台矿机共同持有，逐台出售共同决定。',status].join('\n');
  const intent=(endpoint,source)=>{const link=new URL(endpoint);link.searchParams.set('url',portfolioLandingUrl(publicBaseUrl,project.pool,source));link.searchParams.set('text',text);return link.href;};
  return Object.freeze({title,text,xText:text,url,projectUrl,confirmed,canSubscribe,status,
    telegramUrl:intent('https://t.me/share/url','tg'),xUrl:intent('https://x.com/intent/tweet','x')});
}
