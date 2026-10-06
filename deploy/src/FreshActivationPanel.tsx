import { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, Check, ExternalLink, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import type { Eip1193Provider, ArtifactBundle, DeploymentSnapshot } from './deployment';
import { activationEvidence, FRESH_ADMIN_ONE, FRESH_ADMIN_TWO, FRESH_GAS_WALLET,
  FreshActivationEngine, type FreshActivationRecord } from './fresh-activation';
import type { ServerJournal } from './server-journal';

const explorer = 'https://bscscan.com';
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const activationCanRequestSignature = (status?: string) => status === 'waiting' || status === 'rejected';
export const activationCanReconcile = ({ held, enabled, busy, loading, recoveryHash }: {
  held: boolean; enabled: boolean; busy: boolean; loading: boolean; recoveryHash: string;
}) => !held && enabled && !busy && !loading
  && (!recoveryHash.trim() || /^0x[0-9a-fA-F]{64}$/.test(recoveryHash.trim()));
export const activationStepStatusText = (status: string) => status === 'confirmed' ? '规范链已确认'
  : status === 'waiting' ? '等待钱包确认'
  : status === 'rejected' ? '发送前停止或钱包拒签；核对后可手动重试'
  : status === 'submitted' ? '已广播，等待最终确认'
  : status === 'signing' ? '签名结果不明；可核对哈希，或在双重 nonce 核对后手动恢复'
  : status === 'uncertain' ? '结果不明，只能核对交易哈希'
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
  const [credential, setCredential] = useState<{credentialVerified:boolean;gasWallet:string|null;stage2Held:boolean}|null>(null);
  const stage2Held = credential?.stage2Held !== false;
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
  if (!genesis || genesis.kind !== 'integrated-v2') return null;
  const next = record?.steps.find(step => step.status !== 'confirmed');
  const unresolved = next && ['signing','submitted','uncertain'].includes(next.status);
  return <section className="card progress-card" aria-label="新合约平台权限激活" style={{ marginTop: 24 }}>
    <div className="card-heading"><div><ShieldCheck size={20}/><h2>新合约权限激活</h2></div>
      <span className="subtle-tag">第二阶段 · 硬件钱包 7 笔</span></div>
    <div style={{ padding: '16px 24px 24px' }}>
      <p>第一阶段只建立单机与多机合约。第二阶段部署平台权限合约，把两套 Factory 的运营和手续费地址交给它，再把 Factory 所有权移交 48 小时时间锁。两位管理员可签名审核及领取费用；Gas 钱包只代付，不能自行审核或领取。</p>
      <p><b>部署钱包：</b>{genesis.account}<br/><b>管理员一：</b>{FRESH_ADMIN_ONE}<br/><b>管理员二：</b>{FRESH_ADMIN_TWO}<br/><b>独立 Gas 钱包：</b>{record?.gasWallet || gasWallet}</p>
      <p className={credential?.credentialVerified && credential.gasWallet?.toLowerCase() === (record?.gasWallet || gasWallet).toLowerCase()
        ? 'alert alert-success' : 'alert alert-warning'}>
        {credential?.credentialVerified && credential.gasWallet?.toLowerCase() === (record?.gasWallet || gasWallet).toLowerCase()
          ? `签名服务已证明 Gas 钱包公钥：${credential.gasWallet}`
          : `控制台已保存 Gas 钱包公开地址${credential?.gasWallet ? `：${credential.gasWallet}` : ''}，正在等待签名服务证明。`}</p>
      <p className="field-help">只使用这些公开地址。网页不接收私钥。新合约和新站独立运行；旧池、份额和订单仍留在旧站，不会导入新图。</p>
      {stage2Held && <p className="alert alert-warning" role="status">第二阶段权限交易已冻结，链上回执核验也暂不可用，因为核验结果需要写回服务器。可刷新并查看已保存的记录；服务端解除冻结后才能继续核验或签名。</p>}
      <p className="alert alert-warning">新版 Factory 只维护自己的矿机登记，不读取旧合约。独立系统无法保证新旧站之间的矿机编号不会重复，运营方仍须核对矿机实际所有权。Authority 接线后，管理员签名和 Gas 代发流程须先通过完整测试再开放建池。</p>
      {!record && <><label htmlFor="activation-gas-wallet">Gas 钱包公开地址（42 字符）</label>
        <input id="activation-gas-wallet" className="text-input mono" value={gasWallet} onChange={e => setGasWallet(e.target.value)}
          placeholder="0x…" autoComplete="off" spellCheck={false} disabled={!!busy}/>
        <p className="field-help">已自动填入正式配置中的 Gas 钱包公开地址。</p>
        <div className="budget-row"><div><label htmlFor="activation-budget">第二阶段 Gas 预算（BNB）</label>
        <input id="activation-budget" className="text-input" value={budget} inputMode="decimal" onChange={e => setBudget(e.target.value)} disabled={!!busy}/></div>
        <div><label htmlFor="activation-gas-cap">Gas 单价上限（Gwei）</label>
          <input id="activation-gas-cap" className="text-input" value={gasCap} inputMode="decimal" onChange={e => setGasCap(e.target.value)} disabled={!!busy}/></div></div></>}
      {record && <><p><b>状态：</b>{record.status === 'complete' ? '全部权限已通过链上核验' : record.status === 'aborted' ? '交易终止，禁止自动重发' : '待逐笔确认'}
        {record.authorityAddress && <>　<b>Authority：</b><a href={`${explorer}/address/${record.authorityAddress}`} target="_blank" rel="noreferrer">{record.authorityAddress}<ExternalLink size={12}/></a></>}</p>
        <ol className="transaction-list">{record.steps.map((step, index) => <li key={step.id} className={`tx-${step.status}`}>
          <span className="tx-icon">{step.status === 'confirmed' ? <Check size={15}/> : index + 1}</span>
          <div><b>{step.label}</b><small>{activationStepStatusText(step.status)}</small>
            {step.attempts?.map((attempt, attemptIndex) => <small key={`${attempt.nonce}-${attemptIndex}`}>
              已归档失败尝试 {attemptIndex + 1} · nonce {attempt.nonce} ·
              <a href={`${explorer}/tx/${attempt.recovery.winnerHash}`} target="_blank" rel="noreferrer">
                最终确认交易</a> · 区块 {attempt.recovery.finalizedBlockNumber}
            </small>)}
          </div>
          {step.txHash && <a href={`${explorer}/tx/${step.txHash}`} target="_blank" rel="noreferrer">查看交易 <ExternalLink size={13}/></a>}
        </li>)}</ol></>}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {info && <div className="alert alert-success" role="status">{info}</div>}
      {unresolved && <div className="budget-recovery"><label htmlFor="activation-recovery">钱包交易哈希（原交易或相同内容加速交易）</label>
        <input id="activation-recovery" className="text-input mono" value={recoveryHash} onChange={e => setRecoveryHash(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false}/>
        <p>结果不明时不会重发。已有哈希可直接核验；钱包加速后在此填入新的哈希。无哈希的签名意图须先关闭旧钱包确认弹窗，再由服务器及钱包核对 nonce；解除后仍须人工确认原交易。</p></div>}
      <div className="record-actions" style={{ marginTop: 20, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {!record && <button className="primary-button" disabled={stage2Held || !enabled || !!busy || loading || !credential?.credentialVerified
          || credential.gasWallet?.toLowerCase() !== gasWallet.trim().toLowerCase()
          || !/^0x[0-9a-fA-F]{40}$/.test(gasWallet.trim())} onClick={() => void act('初始链上核验', () => engine().prepare(budget, gasCap, gasWallet))}>
          {busy ? <LoaderCircle className="spin" size={17}/> : <ShieldCheck size={17}/>}核验新图并建立七笔交易记录</button>}
        {record && activationCanRequestSignature(next?.status) && <button className="primary-button" disabled={stage2Held || !enabled || !!busy || loading
          || !credential?.credentialVerified || credential.gasWallet?.toLowerCase() !== record.gasWallet.toLowerCase()}
          onClick={() => void act('硬件钱包交易', () => engine().sendNext(record))}>
          {busy ? <LoaderCircle className="spin" size={17}/> : <ShieldCheck size={17}/>}核对后在硬件钱包确认第 {record.steps.indexOf(next) + 1} 笔</button>}
        {record && (unresolved || record.steps.every(step => step.status === 'confirmed') && record.status !== 'complete')
          && <button className="small-button" disabled={!activationCanReconcile({ held: stage2Held, enabled,
            busy: !!busy, loading, recoveryHash })}
            onClick={() => void act('链上回执核验', () => engine().reconcile(record, recoveryHash))}>
              <RefreshCw size={15}/>只读核验链上交易</button>}
        {record && next?.status === 'signing' && !next.txHash && <button className="small-button"
          disabled={stage2Held || !enabled || !!busy || loading}
          onClick={() => void act('双重 nonce 核对', () => engine().releaseUnusedSigning(record))}>
            <ShieldCheck size={15}/>核对未使用 nonce 并解除签名意图</button>}
        {record?.status === 'aborted' && record.steps.indexOf(next!) >= 0
          && (next?.status === 'failed' || next?.status === 'replaced')
          && <button className="small-button" disabled={stage2Held || !enabled || !!busy || loading}
            onClick={() => void act('最终确认失败交易与权限前缀', () => engine().recoverFinalizedAttempt(record))}>
              <RefreshCw size={15}/>核对并归档失败尝试</button>}
        {record?.status === 'complete' && <button className="small-button" onClick={() => download(`pinkuang-fresh-activation-${record.deploymentId}.json`, activationEvidence(record))}>
          <ArrowDownToLine size={15}/>导出七笔激活证据</button>}
        {record?.status === 'complete' && <button className="small-button" disabled={!enabled || !!busy || loading}
          onClick={() => void exportActivatedManifest()}><ArrowDownToLine size={15}/>链上核验并导出前端清单</button>}
        {journal && <button className="small-button" disabled={!!busy || loading} onClick={() => void refresh()}><RefreshCw size={15}/>刷新服务器记录</button>}
      </div>
    </div>
  </section>;
}
