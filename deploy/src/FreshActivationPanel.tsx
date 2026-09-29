import { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, Check, ExternalLink, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { BrowserProvider, Contract, getAddress } from 'ethers';
import type { Eip1193Provider, ArtifactBundle, DeploymentSnapshot } from './deployment';
import { activationEvidence, FRESH_ADMIN_ONE, FRESH_ADMIN_TWO, FRESH_GAS_WALLET,
  FreshActivationEngine, type FreshActivationRecord } from './fresh-activation';
import type { ServerJournal } from './server-journal';

const explorer = 'https://bscscan.com';
const oldFactories = [
  { name: '第一版 Factory', address: '0xcB24E7F96D81037086A268d6ea63c53f91D412A2' },
  { name: '旧版 v2 Factory', address: '0x2995B10d19056c8C24C57b281C22562a603C571F' },
] as const;
const oldFactoryAbi = [
  'function owner() view returns(address)', 'function creationPaused() view returns(bool)',
  'function poolCount() view returns(uint256)',
];
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const activationCanRequestSignature = (status?: string) => status === 'waiting' || status === 'rejected';
export const activationStepStatusText = (status: string) => status === 'confirmed' ? '规范链已确认'
  : status === 'waiting' ? '等待钱包确认'
  : status === 'rejected' ? '发送前停止或钱包拒签；核对后可手动重试'
  : status === 'submitted' ? '已广播，等待最终确认'
  : status === 'signing' || status === 'uncertain' ? '结果不明，只能核对交易哈希'
  : '计划已终止';

export default function FreshActivationPanel({ wallet, account, chainId, bundle, journal, genesis }: {
  wallet: Eip1193Provider | null; account: string | null; chainId: number | null;
  bundle: ArtifactBundle | null; journal: ServerJournal | null; genesis: DeploymentSnapshot | null;
}) {
  const [record, setRecord] = useState<FreshActivationRecord | null>(null);
  const [budget, setBudget] = useState('0.05');
  const [gasCap, setGasCap] = useState('3');
  const [gasWallet, setGasWallet] = useState(FRESH_GAS_WALLET);
  const [recoveryHash, setRecoveryHash] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [oldStatus, setOldStatus] = useState<null | { name: string; address: string;
    owner: string; paused: boolean; poolCount: string }[]>(null);
  const [credential, setCredential] = useState<{credentialVerified:boolean;gasWallet:string|null}|null>(null);
  const enabled = !!(wallet && account && chainId === 56 && bundle && journal && genesis?.status === 'complete'
    && genesis.kind === 'integrated-v2' && genesis.account.toLowerCase() === account.toLowerCase());
  const refresh = useCallback(async () => {
    if (!journal) { setRecord(null); setCredential(null); return; }
    setLoading(true);
    try {
      const [saved, configuration] = await Promise.all([
        journal.loadFreshActivation(), journal.freshActivationCredentialStatus(),
      ]);
      setRecord(saved); setCredential(configuration);
    }
    catch (err) { setError(String(err)); }
    finally { setLoading(false); }
  }, [journal]);
  useEffect(() => { void refresh(); }, [refresh, genesis?.id]);

  const engine = () => {
    if (!wallet || !bundle || !journal || !genesis) throw new Error('必须连接原始部署硬件钱包并读取已完成的新部署。');
    return new FreshActivationEngine(wallet, bundle, journal, genesis, setRecord);
  };
  async function act(label: string, action: () => Promise<FreshActivationRecord>) {
    if (busy) return;
    setBusy(label); setError(''); setInfo('');
    try { const next = await action(); setRecord(next); setInfo(`${label}已完成，记录保存在服务器。`); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); await refresh(); }
    finally { setBusy(''); }
  }
  async function exportActivatedManifest() {
    if (!record || busy) return;
    setBusy('核验并导出前端清单'); setError(''); setInfo('');
    try {
      const manifest = await engine().verifiedManifest(record);
      download(`pinkuang-fresh-frontend-manifest-${record.deploymentId}.json`, manifest);
      setInfo('已根据当前链上代码和权限导出前端清单。');
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(''); }
  }
  async function inspectOldFactories() {
    if (!wallet || busy) return;
    setBusy('核验旧 Factory 状态'); setError('');
    try {
      const provider = new BrowserProvider(wallet, 'any', { cacheTimeout: -1 });
      if ((await provider.getNetwork()).chainId !== 56n) throw new Error('请切换至 BSC 主网。');
      const block = await provider.getBlock('finalized');
      if (!block?.hash) throw new Error('无法读取 BSC 最终确认区块。');
      const state = await Promise.all(oldFactories.map(async item => {
        const contract = new Contract(item.address, oldFactoryAbi, provider);
        const [owner, paused, count] = await Promise.all([
          contract.owner({blockTag:block.number}), contract.creationPaused({blockTag:block.number}),
          contract.poolCount({blockTag:block.number}),
        ]);
        return {name:item.name,address:getAddress(item.address),owner:getAddress(owner),
          paused:Boolean(paused),poolCount:count.toString()};
      }));
      if ((await provider.getBlock(block.number))?.hash !== block.hash)
        throw new Error('旧 Factory 核验期间区块发生重组。');
      setOldStatus(state);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(''); }
  }
  if (!genesis || genesis.kind !== 'integrated-v2') return null;
  const next = record?.steps.find(step => step.status !== 'confirmed');
  const unresolved = next && ['signing','submitted','uncertain'].includes(next.status);
  return <section className="card progress-card" aria-label="新合约平台权限激活" style={{ marginTop: 24 }}>
    <div className="card-heading"><div><ShieldCheck size={20}/><h2>新合约权限激活</h2></div>
      <span className="subtle-tag">第二阶段 · 硬件钱包 7 笔</span></div>
    <div style={{ padding: '16px 24px 24px' }}>
      <p>第一阶段只建立单机与多机合约。第二阶段部署平台权限合约，把两套 Factory 的运营和手续费地址交给它，再把 Factory 所有权移交 48 小时时间锁。两位管理员可签名审核及领取费用；Gas 钱包只代付，不能自行审核或领取。</p>
      <p><b>硬件钱包：</b>{genesis.account}<br/><b>管理员一：</b>{FRESH_ADMIN_ONE}<br/><b>管理员二：</b>{FRESH_ADMIN_TWO}<br/><b>Gas 钱包：</b>{record?.gasWallet || gasWallet}</p>
      <p className={credential?.credentialVerified && credential.gasWallet?.toLowerCase() === (record?.gasWallet || gasWallet).toLowerCase()
        ? 'alert alert-success' : 'alert alert-warning'}>
        {credential?.credentialVerified && credential.gasWallet?.toLowerCase() === (record?.gasWallet || gasWallet).toLowerCase()
          ? `服务器凭据已派生并核对 Gas 公钥：${credential.gasWallet}`
          : '服务器 Gas 钱包凭据尚未核验，或派生公钥与本页地址不同；此状态下不能发起新的权限交易。'}</p>
      <p className="field-help">只使用这些公开地址。网页不接收私钥。原有 Factory、池子、份额和订单不会被迁移；新图必须在独立验收后切换服务配置。</p>
      <p className="alert alert-warning">上线门槛：旧版两套 Factory 必须停建；其中旧 v2 Factory 已有真实矿池，需旧 owner 钱包单独执行并核验 pauseCreation(true)。此外新版 Factory.operator 切换为 Authority 后，创建矿池须管理员 EIP-712 签名和 Gas 钱包中继；该运营流程通过完整测试前不得开放新图。</p>
      <div className="budget-recovery"><b>旧 Factory 建池状态（只读）</b>
        <p>旧 v2 的 owner 必须另用旧钱包调用 <code>pauseCreation(true)</code>；新硬件钱包不能替它签名。旧池、份额及订单会保留。链上确认后重新核验，服务端也会独立检查两套旧 Factory 均已停建。</p>
        <button className="small-button" disabled={!wallet || !!busy} onClick={() => void inspectOldFactories()}>
          <RefreshCw size={15}/>读取两套旧 Factory</button>
        {oldStatus?.map(item => <p key={item.address}><b>{item.name}：</b>{item.paused ? '已暂停建池' : '仍可建池'}，已有 {item.poolCount} 个池。<br/>
          <b>owner：</b>{item.owner}　<a href={`${explorer}/address/${item.address}`} target="_blank" rel="noreferrer">查看合约 <ExternalLink size={12}/></a></p>)}
      </div>
      {!record && <><label htmlFor="activation-gas-wallet">Gas 钱包公开地址（42 字符）</label>
        <input id="activation-gas-wallet" className="text-input mono" value={gasWallet} onChange={e => setGasWallet(e.target.value)}
          placeholder="0x…" autoComplete="off" spellCheck={false} disabled={!!busy}/>
        <p className="field-help">已预填你重新提供并校验的完整公开地址。请再从钱包核对，服务器配置必须与此地址一致。</p>
        <div className="budget-row"><div><label htmlFor="activation-budget">第二阶段 Gas 预算（BNB）</label>
        <input id="activation-budget" className="text-input" value={budget} inputMode="decimal" onChange={e => setBudget(e.target.value)} disabled={!!busy}/></div>
        <div><label htmlFor="activation-gas-cap">Gas 单价上限（Gwei）</label>
          <input id="activation-gas-cap" className="text-input" value={gasCap} inputMode="decimal" onChange={e => setGasCap(e.target.value)} disabled={!!busy}/></div></div></>}
      {record && <><p><b>状态：</b>{record.status === 'complete' ? '全部权限已通过链上核验' : record.status === 'aborted' ? '交易终止，禁止自动重发' : '待逐笔确认'}
        {record.authorityAddress && <>　<b>Authority：</b><a href={`${explorer}/address/${record.authorityAddress}`} target="_blank" rel="noreferrer">{record.authorityAddress}<ExternalLink size={12}/></a></>}</p>
        <ol className="transaction-list">{record.steps.map((step, index) => <li key={step.id} className={`tx-${step.status}`}>
          <span className="tx-icon">{step.status === 'confirmed' ? <Check size={15}/> : index + 1}</span>
          <div><b>{step.label}</b><small>{activationStepStatusText(step.status)}</small></div>
          {step.txHash && <a href={`${explorer}/tx/${step.txHash}`} target="_blank" rel="noreferrer">查看交易 <ExternalLink size={13}/></a>}
        </li>)}</ol></>}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {info && <div className="alert alert-success" role="status">{info}</div>}
      {unresolved && <div className="budget-recovery"><label htmlFor="activation-recovery">钱包交易哈希（原交易或相同内容加速交易）</label>
        <input id="activation-recovery" className="text-input mono" value={recoveryHash} onChange={e => setRecoveryHash(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false}/>
        <p>结果不明时不会重发。已有哈希可直接核验；钱包加速后在此填入新的哈希。</p></div>}
      <div className="record-actions" style={{ marginTop: 20, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {!record && <button className="primary-button" disabled={!enabled || !!busy || loading || !credential?.credentialVerified
          || credential.gasWallet?.toLowerCase() !== gasWallet.trim().toLowerCase()
          || !/^0x[0-9a-fA-F]{40}$/.test(gasWallet.trim())} onClick={() => void act('初始链上核验', () => engine().prepare(budget, gasCap, gasWallet))}>
          {busy ? <LoaderCircle className="spin" size={17}/> : <ShieldCheck size={17}/>}核验新图并建立七笔交易记录</button>}
        {record && activationCanRequestSignature(next?.status) && <button className="primary-button" disabled={!enabled || !!busy || loading
          || !credential?.credentialVerified || credential.gasWallet?.toLowerCase() !== record.gasWallet.toLowerCase()}
          onClick={() => void act('硬件钱包交易', () => engine().sendNext(record))}>
          {busy ? <LoaderCircle className="spin" size={17}/> : <ShieldCheck size={17}/>}核对后在硬件钱包确认第 {record.steps.indexOf(next) + 1} 笔</button>}
        {record && (unresolved || record.steps.every(step => step.status === 'confirmed') && record.status !== 'complete')
          && <button className="small-button" disabled={!enabled || !!busy || loading || !!recoveryHash && !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash.trim())}
            onClick={() => void act('链上回执核验', () => engine().reconcile(record, recoveryHash))}>
              <RefreshCw size={15}/>只读核验链上交易</button>}
        {record?.status === 'complete' && <button className="small-button" onClick={() => download(`pinkuang-fresh-activation-${record.deploymentId}.json`, activationEvidence(record))}>
          <ArrowDownToLine size={15}/>导出七笔激活证据</button>}
        {record?.status === 'complete' && <button className="small-button" disabled={!enabled || !!busy || loading}
          onClick={() => void exportActivatedManifest()}><ArrowDownToLine size={15}/>链上核验并导出前端清单</button>}
        {journal && <button className="small-button" disabled={!!busy || loading} onClick={() => void refresh()}><RefreshCw size={15}/>刷新服务器记录</button>}
      </div>
    </div>
  </section>;
}
