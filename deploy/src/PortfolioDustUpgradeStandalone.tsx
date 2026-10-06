import {useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FetchRequest,JsonRpcProvider,getAddress,keccak256,toQuantity} from 'ethers';
// @ts-ignore Shared independently tested read-only proof.
import {preparePortfolioDustDeployment,buildPortfolioDustPlan,validatePortfolioDustChain} from '../shared/portfolio-dust-plan.mjs';
// @ts-ignore Shared journal is validated before any wallet request.
import {newPortfolioDustJournal,parsePortfolioDustJournal,portfolioDustJournalKey,verifyPortfolioDustReceipt,assertPortfolioDustConfirmedState} from '../shared/portfolio-dust-journal.mjs';
// @ts-ignore Shared nonce proof is independently tested against stale wallet views.
import {readPortfolioDustNonce} from '../shared/portfolio-dust-nonce.mjs';
// @ts-ignore Shared pacing preserves every proof and RPC error.
import {pacePortfolioDustRpc} from '../shared/portfolio-dust-rpc.mjs';
// @ts-ignore Reuse only a proof returned by this run's exact receipt verification.
import {runPortfolioDustFlow} from '../shared/portfolio-dust-flow.mjs';
// @ts-ignore Receipts keep their canonical checks when a current graph proof is reused.
import {portfolioDustProofForReceipt} from '../shared/portfolio-dust-proof-reuse.mjs';
// @ts-ignore Bounded retry is restricted to reading; saved timing is display-only.
import {retryPortfolioDustRead,portfolioDustReadErrorMessage,confirmedScheduleStatus} from '../shared/portfolio-dust-read-recovery.mjs';
import {discoverWallets,messageOf,readWallet,switchToBsc,type WalletOption} from './wallet';
import './portfolio-dust.css';
type Json=Record<string,any>;
declare const __PORTFOLIO_DUST_RELEASE__: {kind:string;configSha256:string;sourceCommit:string;rpcPath:string};
const release=__PORTFOLIO_DUST_RELEASE__,same=(a?:string,b?:string)=>!!a&&!!b&&a.toLowerCase()===b.toLowerCase();
const short=(s:string)=>`${s.slice(0,9)}…${s.slice(-6)}`;
const stringify=(v:unknown)=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x);
const salt=()=>`0x${Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('')}`;
function provider() {const request=new FetchRequest(new URL(release.rpcPath,location.href).href);request.timeout=18000;
  request.setThrottleParams({maxAttempts:1});
  request.retryFunc=async()=>false;
  const p=new JsonRpcProvider(request,56,{staticNetwork:true,batchMaxCount:1,cacheTimeout:-1});
  p.send=retryPortfolioDustRead(pacePortfolioDustRpc(p.send.bind(p)));return p;}
async function loadConfig() {const response=await fetch('./data/config.json',{cache:'no-store',redirect:'error'});
  if(!response.ok) throw new Error('部署配置暂时无法读取，请稍后重试。');
  const bytes=await response.arrayBuffer(),digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  if(digest!==release.configSha256) throw new Error('部署产物与固定发布摘要不一致。');
  const config=JSON.parse(new TextDecoder().decode(bytes));preparePortfolioDustDeployment(config);return config;}
export function PortfolioDustUpgradeStandalone() {
  const [config,setConfig]=useState<Json|null>(null),[wallets,setWallets]=useState<WalletOption[]>([]),[wallet,setWallet]=useState<WalletOption|null>(null);
  const [account,setAccount]=useState(''),[chain,setChain]=useState(0),[journal,setJournal]=useState<Json|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('正在读取固定部署产物…');
  const [recoveryHash,setRecoveryHash]=useState(''),[proof,setProof]=useState<Json|null>(null);
  const [nonceProof,setNonceProof]=useState<Json|null>(null);
  const busyRef=useRef(false),journalRef=useRef<Json|null>(null),configRef=useRef<Json|null>(null),resumedRef=useRef(false);
  useEffect(()=>discoverWallets(setWallets),[]);
  useEffect(()=>{let alive=true;void loadConfig().then(value=>{if(!alive)return;configRef.current=value;setConfig(value);
    const raw=localStorage.getItem(portfolioDustJournalKey(value));const row=raw?parsePortfolioDustJournal(JSON.parse(raw),value):null;
    journalRef.current=row;setJournal(row);setMessage(confirmedScheduleStatus(row)||'准备就绪。点击下方按钮，按钱包提示确认两笔交易。');
  }).catch(e=>{if(alive)setError(messageOf(e));});return()=>{alive=false;};},[]);
  useEffect(()=>{if(!wallet)return;let alive=true;
    const update=()=>{setProof(null);setNonceProof(null);void readWallet(wallet.provider).then(state=>{if(alive){setAccount(state?getAddress(state.address):'');setChain(state?.chainId??0);}}).catch(e=>{if(alive)setError(messageOf(e));});};
    update();wallet.provider.on?.('accountsChanged',update);wallet.provider.on?.('chainChanged',update);
    return()=>{alive=false;wallet.provider.removeListener?.('accountsChanged',update);wallet.provider.removeListener?.('chainChanged',update);};},[wallet]);
  useEffect(()=>{if(!config)return;const key=portfolioDustJournalKey(config),update=(event:StorageEvent)=>{if(event.key!==key)return;
    try{const row=event.newValue?parsePortfolioDustJournal(JSON.parse(event.newValue),config):null;journalRef.current=row;setJournal(row);}catch(e){setError(messageOf(e));}};
    window.addEventListener('storage',update);return()=>window.removeEventListener('storage',update);},[config]);
  useEffect(()=>{if(!config||resumedRef.current)return;resumedRef.current=true;
    // Resume a saved schedule hash with reads only. Never open another signing request.
    if(journalRef.current?.transactions.schedule?.txHash)void readSavedSchedule();
  },[config]);
  function save(row:Json) {const current=configRef.current;if(!current)throw new Error('固定部署配置未加载。');
    const checked=parsePortfolioDustJournal(row,current);localStorage.setItem(portfolioDustJournalKey(current),stringify(checked));journalRef.current=checked;setJournal(checked);}
  async function withRun(action:()=>Promise<void>) {if(busyRef.current)return;busyRef.current=true;setBusy(true);setError('');
    try{await action();}catch(e){setError(portfolioDustReadErrorMessage(e)||messageOf(e));setProof(null);
      setMessage(confirmedScheduleStatus(journalRef.current)||'本次操作未完成。原交易记录已保留，可核对进度后继续。');
    }finally{busyRef.current=false;setBusy(false);}}
  async function withLock(action:()=>Promise<void>) {if(!config||!navigator.locks)throw new Error('请使用支持跨标签交易锁的新版浏览器。');
    await navigator.locks.request(portfolioDustJournalKey(config),{mode:'exclusive',ifAvailable:true},async lock=>{
      if(!lock)throw new Error('另一标签正在处理本次部署，请使用原标签继续。');
      const raw=localStorage.getItem(portfolioDustJournalKey(config));journalRef.current=raw?parsePortfolioDustJournal(JSON.parse(raw),config):null;setJournal(journalRef.current);await action();});}
  async function readSavedSchedule() {await withRun(async()=>{await withLock(async()=>{
    finish(await runPortfolioDustFlow({getJournal:()=>journalRef.current,
      createJournal:()=>{throw new Error('只读恢复需要原部署记录。');},saveJournal:save,
      checkOriginal:verifyOriginal,inspect,send:()=>{throw new Error('原排程尚未核验，记录保留；不会发送新交易。');}}));});});}
  async function inspect(row:Json|null) {if(!config)throw new Error('部署产物尚未读取。');const p=provider();
    setMessage('正在读取链上合约与升级进度，请稍候…');
    try{const replacement=row?.transactions.deploy?.status==='confirmed'?row.transactions.deploy.address:undefined;
      const result=await validatePortfolioDustChain(p,config,{replacement,salt:row?.salt,delaySeconds:row?.delaySeconds});setProof(result);return result;
    }finally{p.destroy();}}
  function requestFor(step:'deploy'|'schedule',row:Json):{from:string;to?:string;data:string;gas:string} {if(!config)throw new Error('配置未读取。');
    if(step==='deploy')return {from:config.deployer,data:preparePortfolioDustDeployment(config).data,gas:toQuantity(BigInt(config.deploymentGasLimit))};
    const plan=buildPortfolioDustPlan(config,row.transactions.deploy.address,row.salt,row.delaySeconds);
    return {from:config.proposer,to:plan.to,data:plan.scheduleData,gas:toQuantity(300000)};}
  async function checkOriginal(step:'deploy'|'schedule',row:Json,hash:string,freshProof?:Json|null) {if(!config)throw new Error('配置未读取。');
    const request=requestFor(step,row),original=row.transactions[step];
    if(!same(original.dataHash,keccak256(request.data)))throw new Error('部署记录与固定操作不一致。');
    setMessage(step==='schedule'?'正在核对原排程交易及升级进度，不会重复发送…':'正在核对原补丁部署交易及运行代码…');
    const schedulePlan=step==='schedule'?buildPortfolioDustPlan(config,row.transactions.deploy.address,row.salt,row.delaySeconds):undefined;
    const p=provider();try{const receipt=await verifyPortfolioDustReceipt(p,hash,{...original,to:request.to,data:request.data,schedulePlan});if(!receipt)return null;
      if(!receipt.success){save({...row,failed:[...row.failed,{step,...receipt}],transactions:Object.fromEntries(Object.entries(row.transactions).filter(([key])=>key!==step))});
        throw new Error('原交易已在链上确认失败，记录已归档。可以再次点击开始。');}
      const next:Json={...row,transactions:{...row.transactions,[step]:{...original,...receipt,status:'confirmed'}}};
      // Never mark deployment complete until its full runtime, immutable and library link are verified.
      const currentPlan=buildPortfolioDustPlan(config,next.transactions.deploy.address,next.salt,next.delaySeconds);
      const state=portfolioDustProofForReceipt(freshProof,next,currentPlan,receipt)
        ??await validatePortfolioDustChain(p,config,{replacement:next.transactions.deploy.address,salt:next.salt,delaySeconds:next.delaySeconds});
      assertPortfolioDustConfirmedState(step,receipt,state);setProof(state);
      // Historical timing survives a transport failure; it never substitutes for a fresh proof.
      if(step==='schedule'&&Number.isSafeInteger(Number(state.readyAt))&&Number(state.readyAt)>0)
        next.transactions.schedule={...next.transactions.schedule,verifiedReadyAt:Number(state.readyAt),
          verifiedBlockNumber:state.blockNumber,verifiedBlockHash:state.blockHash};
      save(next);return state;
    }finally{p.destroy();}}
  async function verifyOriginal(step:'deploy'|'schedule',row:Json,freshProof?:Json|null) {const original=row.transactions[step],hash=original.txHash||recoveryHash.trim();
    if(!/^0x[\da-f]{64}$/i.test(hash))throw new Error('钱包尚未返回原哈希。请保留原请求；可在下方填入钱包中的交易哈希进行核对。');
    const done=await checkOriginal(step,row,hash,freshProof);if(!done)setMessage('原交易正在等待链上确认。不会重复发送。');return done;}
  async function inspectNonce(selected:WalletOption,row:Json|null,from=config?.deployer) {if(!config)throw new Error('配置未读取。');
    const p=provider();try{return await readPortfolioDustNonce({wallet:selected.provider,rpc:(method:string,params:unknown[])=>p.send(method,params),
      account:from,transactions:row?.transactions??{},onObservation:setNonceProof});}finally{p.destroy();}}
  async function send(step:'deploy'|'schedule',row:Json,selected:WalletOption) {
    const request=requestFor(step,row),accounts=await selected.provider.request({method:'eth_accounts'}),chainId=await selected.provider.request({method:'eth_chainId'});
    if(!Array.isArray(accounts)||!same(accounts[0],request.from)||Number(chainId)!==56)throw new Error('请连接页面指定的部署账户，并切换到 BSC 主网。');
    setMessage('正在核对钱包与链上的交易序号…');
    const liveNonce=await inspectNonce(selected,row,request.from);
    const intent={status:'uncertain',from:request.from,dataHash:keccak256(request.data),nonce:liveNonce.nonce};
    save({...row,transactions:{...row.transactions,[step]:intent}});setMessage(step==='deploy'?'请在钱包确认批量矿池补丁部署。':'补丁部署已确认。请在钱包确认 48 小时升级排程。');
    let hash:unknown;try{hash=await selected.provider.request({method:'eth_sendTransaction',params:[{...request,value:'0x0',nonce:toQuantity(BigInt(liveNonce.nonce))}]});}
    catch(e){if((e as any)?.code===4001||(e as any)?.code==='ACTION_REJECTED')save(row);throw e;}
    if(typeof hash!=='string'||!/^0x[\da-f]{64}$/i.test(hash))throw new Error('钱包没有返回交易哈希，原请求已保留。请使用核对原交易，不要重复部署。');
    const submitted={...row,transactions:{...row.transactions,[step]:{...intent,status:'submitted',txHash:hash}}};save(submitted);
    setMessage('交易已提交，正在核对链上回执…');
    for(let count=0;count<30;count++){const live=await checkOriginal(step,journalRef.current!,hash);if(live)return live;await new Promise(resolve=>setTimeout(resolve,3000));}
    throw new Error('交易仍待确认。哈希已保存，稍后点击继续即可核对原交易。');
  }
  async function start() {await withRun(async()=>{if(!config)throw new Error('部署产物未读取。');
    const selected=wallet??wallets[0];if(!selected)throw new Error('请在安装了 MetaMask 或 OneKey 的浏览器打开此网址。');
    await selected.provider.request({method:'eth_requestAccounts'});let state=await readWallet(selected.provider);
    if(state?.chainId!==56){await switchToBsc(selected.provider);state=await readWallet(selected.provider);}
    setWallet(selected);setAccount(state?.address??'');setChain(state?.chainId??0);
    if(!same(state?.address,config.deployer))throw new Error(`请切换部署账户 ${config.deployer}。`);
    await withLock(async()=>{const result=await runPortfolioDustFlow({getJournal:()=>journalRef.current,
      createJournal:(live:Json)=>newPortfolioDustJournal(config,salt(),Math.max(172800,Number(live.minDelay))),saveJournal:save,
      checkOriginal:verifyOriginal,inspect,send:(step:'deploy'|'schedule',row:Json)=>send(step,row,selected)});
      finish(result);
    });});}
  function finish(result:Json) {if(result.pending)return;
    const live=result.proof,time=live.readyAt?new Date(Number(live.readyAt)*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'';
    if(!['waiting','ready','done'].includes(live.operation))throw new Error('排程尚未在当前链上确认，原记录已保留。请核对进度。');
    setMessage(live.operation==='done'?'批量矿池补丁已经链上启用。':`补丁已部署并排程。最早启用时间：${time}（北京时间）。届时完成配套服务核对后启用。`);
  }
  const txs=journal?.transactions??{},pending=(['deploy','schedule'] as const).some(step=>txs[step]&&txs[step].status!=='confirmed');
  return <main><header><a href="https://bemine.cc.cd/">← 返回 BEMine</a><span>BSC 主网 · 独立补丁</span></header>
    <h1>批量矿池合约部署</h1><p>修复最后一台矿机售出后的结算尾差。<strong>你只需在钱包确认部署和排程两笔交易。</strong>现有项目与原升级排程保留。</p>
    <section><div className="steps"><span className={txs.deploy?.status==='confirmed'?'done':''}>1 部署补丁</span><span className={txs.schedule?.status==='confirmed'?'done':''}>2 排程升级</span><span>3 等待 48 小时</span></div>
      {error&&<p role="alert" className="message error">{error}</p>}<p role="status" className="message">{message}</p>
      <label>选择钱包<select aria-label="选择钱包" value={wallet?.id??wallets[0]?.id??''} disabled={busy} onChange={e=>setWallet(wallets.find(w=>w.id===e.target.value)??null)}>
        {!wallets.length&&<option value="">未发现扩展钱包，请使用 Chrome 或钱包浏览器</option>}{wallets.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
      <button className="primary" disabled={busy||!config} onClick={()=>void (txs.schedule?.status==='confirmed'?readSavedSchedule():start())}>{busy?'正在处理…':pending?'核对原交易并继续':txs.schedule?.status==='confirmed'?'核对部署进度':'开始部署并排程'}</button>
      <p className="detail">{account?`当前钱包 ${account} · ${chain===56?'BSC 主网':'请切换 BSC 主网'}`:`部署账户：${config?.deployer??'读取中'}`}</p>
      {(['deploy','schedule'] as const).map(step=>txs[step]?.txHash&&<div className="tx" key={step}>{step==='deploy'?'补丁部署':'升级排程'} · {txs[step].status==='confirmed'?'链上已确认':'待确认'} <a href={`https://bscscan.com/tx/${txs[step].txHash}`} target="_blank" rel="noreferrer">{short(txs[step].txHash)}</a></div>)}
      {pending&&<details open><summary>核对原交易</summary><p>交易记录保留在本浏览器。原请求未确认时不会重复发送。</p><input aria-label="原交易哈希" placeholder="原交易哈希 0x…（钱包未返回时填写）" value={recoveryHash} onChange={e=>setRecoveryHash(e.target.value)}/></details>}
      <details><summary>合约与进度</summary><p className="detail">Factory：{config?.manifest.portfolioFactory}<br/>升级对象：{config?.manifest.portfolioBeacon}<br/>实现：{txs.deploy?.address??'尚未部署'}<br/>来源：{release.sourceCommit}<br/>检查区块：{proof?.blockNumber??'开始时自动读取'}{nonceProof&&<><br/>交易序号：链上 {nonceProof.confirmed} / 待确认 {nonceProof.pending}；钱包 {nonceProof.walletLatest} / {nonceProof.walletPending}</>}</p>
        <button className="secondary" disabled={busy||!config} onClick={()=>void withRun(async()=>{const row=journalRef.current,live=await inspect(row);
          if(row?.transactions.schedule?.status==='confirmed'&&live.operation==='unscheduled')throw new Error('原升级排程已被取消或当前不可读取，记录保留；请核对原链上操作。');
          let nonce='';const selected=wallet??wallets[0];
          if(selected&&!pending&&txs.schedule?.status!=='confirmed') {const state=await readWallet(selected.provider);
            if(state?.chainId===56&&same(state.address,config?.deployer)) {const result=await inspectNonce(selected,row);nonce=` 钱包与链上交易序号已同步（${result.nonce}）。`;}}
          setMessage(`只读核对完成，区块 #${live.blockNumber}。${nonce}${live.readyAt?` 最早启用：${new Date(Number(live.readyAt)*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}（北京时间）。`:''}`);})}>只读核对进度</button>
      </details>
    </section><p>部署新实现不会立即改变旧项目；升级须经过链上等待期。此入口只提交本次批量矿池补丁，不发送资金认购或领取交易。</p>
  </main>;
}
createRoot(document.getElementById('root')!).render(<PortfolioDustUpgradeStandalone/>);
