import test from 'node:test';
import assert from 'node:assert/strict';
import {createPortfolioShare,isConfirmedPortfolioDeposit,buildPortfolioShareUrl,portfolioLandingUrl,resolvePortfolioShareTarget} from '../lib/portfolio-share.mjs';
import {createProjectShare} from '../lib/project-share.mjs';
import {makeArtworkShareUrl,resolveArtworkShareTarget} from '../lib/share-landing.mjs';
const pool=`0x${'ab'.repeat(20)}`,factory=`0x${'cd'.repeat(20)}`,hash=`0x${'ef'.repeat(32)}`,base='https://tapeout.cc.cd/bemine-v2/';
const project={kind:'portfolio',pool,OFFICIAL_FACTORY:factory,blockNumber:100n,blockHash:hash,state:0n,totalSupply:35n,timestamp:100n,fundingDeadline:200n};
const confirmation={action:'deposit',targetType:'portfolio',status:'confirmed',finalized:true,poolAddress:pool,target:pool,factory,shares:'2',amountWei:'100',transactionHash:hash,receipt:{status:1,to:pool,transactionHash:hash}};
test('portfolio invitations use the configured release path and a dedicated static poster landing',()=>{
  for(const locale of ['zh','en']){
    const m=createPortfolioShare({publicBaseUrl:base,project,locale});assert(m);assert(m.canSubscribe);assert(!m.confirmed);
    assert.equal(m.projectUrl,`${base}#portfolio/${pool}`);assert.equal(new URL(m.url).pathname,'/bemine-v2/budget-share.html');
    assert.equal(resolvePortfolioShareTarget(new URL(m.url).search,'/bemine-v2'),`/bemine-v2/#portfolio/${pool}`);
    assert.equal(new URL(new URL(m.telegramUrl).searchParams.get('url')).searchParams.get('source'),'tg');
  }
});
test('only a finalized matching portfolio receipt can claim successful participation',()=>{
  assert(isConfirmedPortfolioDeposit(confirmation,project));
  for(const patch of [{finalized:false},{status:'pending'},{targetType:'pool'},{factory:pool},{target:factory},{shares:'0'},{shares:'101'},{amountWei:'0'},{receipt:{...confirmation.receipt,to:factory}}])assert(!isConfirmedPortfolioDeposit({...confirmation,...patch},project));
  assert(createPortfolioShare({publicBaseUrl:base,project,confirmation}).confirmed);
});
test('full, expired, unknown and closed portfolios never solicit subscriptions, and personal data is absent',()=>{
  for(const patch of [{totalSupply:100n},{timestamp:200n},{state:undefined},{state:4n}]){
    const m=createPortfolioShare({publicBaseUrl:base,project:{...project,...patch,wallet:'secret-wallet',invested:'sensitive-amount'},confirmation});
    assert(!m.canSubscribe);assert(!JSON.stringify(m).includes(hash));assert(!JSON.stringify(m).includes('secret-wallet'));assert(!JSON.stringify(m).includes('sensitive-amount'));
  }
});
test('portfolio links reject unknown origins, duplicate fields and redirect-like parameters',()=>{
  assert.equal(buildPortfolioShareUrl('https://evil.test/bemine/',pool),null);assert.equal(portfolioLandingUrl(base,'0x'+'0'.repeat(40)),null);
  for(const search of [`?project=${pool}&url=https://evil.test`,`?project=${pool}&project=${factory}`,`?project=${pool}&source=evil`,`?project=${pool}&factory=${factory}`])assert.equal(resolvePortfolioShareTarget(search,'/bemine-v2'),null);
  assert.equal(resolvePortfolioShareTarget(`?project=${pool}`,'//evil.test'),null);assert.equal(resolvePortfolioShareTarget(`?project=${pool}`,'/../evil'),null);
  assert.equal(createPortfolioShare({publicBaseUrl:base,project:{...project,blockHash:null}}),null);
});
test('existing single-miner artwork sharing also preserves the new release base without changing old paths',()=>{
  const single=createProjectShare({publicBaseUrl:base,project:{name:'TapeOut',circuitId:'7',poolAddress:pool,state:'Active'}});assert(single);
  const url=makeArtworkShareUrl(single.projectUrl,'anime');assert.equal(new URL(url).pathname,'/bemine-v2/share/anime.html');
  assert.equal(resolveArtworkShareTarget(new URL(url).search,'/bemine-v2'),`/bemine-v2/#detail/${pool}`);
});
test('portfolio X copy stays within weighted character limits including the shortened URL',()=>{
  const weighted=text=>[...text].reduce((sum,char)=>{const cp=char.codePointAt(0);return sum+(cp<=0x10ff||cp>=0x2000&&cp<=0x200d||cp>=0x2010&&cp<=0x201f||cp>=0x2032&&cp<=0x2037?1:2);},0);
  for(const locale of ['zh','en'])for(const state of [0n,2n,4n])for(const receipt of [undefined,confirmation]){
    const model=createPortfolioShare({publicBaseUrl:base,project:{...project,state},locale,confirmation:receipt});
    assert(weighted(model.xText)+24<=280,`${locale}/${state}/${!!receipt}`);
  }
});
