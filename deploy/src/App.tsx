import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Blocks, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Copy, ExternalLink, FileClock, Fingerprint, GitBranch, KeyRound, LoaderCircle, LockKeyhole, Menu, Network, OctagonAlert, PackageCheck, Play, RefreshCw, Rocket, ShieldCheck, Wallet, X } from 'lucide-react';
import MarketPage from './MarketPage';
import PricingPanel from './PricingPanel';
import { formatEther } from 'ethers';
import { DeploymentEngine, LIBRARY_NAMES, preflight, validateArtifacts, PROTOCOL_ADDRESSES, type ArtifactBundle, type DeploymentInput, type DeploymentSnapshot, type PreflightReport } from './deployment';
import { migrateLegacyDeployment } from './legacy-deployment';
import { deploymentManifest } from './manifest';
import { authenticateJournal, ServerJournal } from './server-journal';
import { discoverWallets, messageOf, readWallet, switchToBsc, type WalletOption, type WalletState } from './wallet';

const EXPLORER = 'https://bscscan.com';
const short = (value: string) => value.length > 17 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
const protocols = Object.entries(PROTOCOL_ADDRESSES);

function download(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Address({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return <span className="address"><a href={`${EXPLORER}/address/${value}`} target="_blank" rel="noreferrer" title={value}>{label || short(value)}<ArrowUpRight size={13}/></a><button className="icon-button" aria-label={`复制 ${label || value}`} onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { setCopied(false); } }}>{copied ? <Check size={14}/> : <Copy size={14}/>}</button></span>;
}

export default function App() {
  const [tab, setTab] = useState<'deploy' | 'market' | 'pricing' | 'funding' | 'records' | 'governance'>('deploy');
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [selected, setSelected] = useState<WalletOption | null>(null);
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [journal, setJournal] = useState<ServerJournal | null>(null);
  const [walletDialog, setWalletDialog] = useState(false);
  const [bundle, setBundle] = useState<ArtifactBundle | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [customRoles, setCustomRoles] = useState(false);
  const [operator, setOperator] = useState('');
  const [treasury, setTreasury] = useState('');
  const [budget, setBudget] = useState('0.05');
  const [gasCap, setGasCap] = useState('1');
  const [recoveryHash, setRecoveryHash] = useState('');
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [snapshot, setSnapshot] = useState<DeploymentSnapshot | null>(null);
  const [archives, setArchives] = useState<DeploymentSnapshot[]>([]);
  const [confirmation, setConfirmation] = useState(false);
  const [governanceReviewed, setGovernanceReviewed] = useState(false);
  const [protocolReviewed, setProtocolReviewed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const running = useRef(false);

  useEffect(() => discoverWallets(setWallets), []);
  useEffect(() => {
    const abort = new AbortController();
    fetch(`${import.meta.env.BASE_URL}deployment-artifacts.json`, { signal: abort.signal, cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error('编译产物未加载，请运行 npm run artifacts 后重试。');
      const value = await response.json();
      if (value.schemaVersion !== 1 || !value.artifacts?.AtomicDeployment?.abi?.some((item: { name?: string }) => item.name === 'deploySingleOwner')) throw new Error('编译产物不支持单钱包部署，请重新生成。');
      validateArtifacts(value);
      setBundle(value);
    }).catch(err => { if (err.name !== 'AbortError') setLoadError(messageOf(err)); });
    return () => abort.abort();
  }, []);
  const refreshWallet = useCallback(async () => {
    if (!selected) return;
    try {
      const current = await readWallet(selected.provider);
      if (!current || (journal && current.address.toLowerCase() !== journal.account.toLowerCase())) {
        setSelected(null); setWallet(null); setJournal(null); setSnapshot(null); setArchives([]);
        setError('钱包账户已变化，请重新连接以读取对应钱包的服务器记录。');
      } else setWallet(current);
    }
    catch (err) { setError(messageOf(err)); }
  }, [selected, journal]);
  useEffect(() => {
    if (!selected) return;
    const change = () => { setReport(null); setConfirmation(false); void refreshWallet(); };
    selected.provider.on?.('accountsChanged', change);
    selected.provider.on?.('chainChanged', change);
    selected.provider.on?.('disconnect', change);
    return () => { selected.provider.removeListener?.('accountsChanged', change); selected.provider.removeListener?.('chainChanged', change); selected.provider.removeListener?.('disconnect', change); };
  }, [selected, refreshWallet]);
  useEffect(() => { setReport(null); setGovernanceReviewed(false); setProtocolReviewed(false); }, [operator, treasury, customRoles, budget, gasCap, wallet?.address, wallet?.chainId]);
  useEffect(() => { if (!confirmation && !walletDialog) return; const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setConfirmation(false); setWalletDialog(false); } }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [confirmation, walletDialog]);

  const activeInput: DeploymentInput = {
    governanceMode: 'single', ownerMultisig: wallet?.address || '',
    operator: customRoles ? operator : wallet?.address || '', treasury: customRoles ? treasury : wallet?.address || '',
    maxGasBudgetBnb: budget, gasPriceCapGwei: gasCap, governanceReviewed, protocolReviewed,
  };
  const confirmed = snapshot?.steps.filter(step => step.status === 'confirmed').length || 0;
  const total = snapshot?.steps.length || LIBRARY_NAMES.length + 5;
  const complete = snapshot?.status === 'complete';
  const aborted = snapshot?.status === 'aborted';
  const recoveryStep = snapshot?.steps.find(step =>
    ((step.status === 'uncertain' || step.status === 'signing') && !step.txHash) || (step.status === 'submitted' && !!step.txHash));
  const onBsc = wallet?.chainId === 56;
  const canStart = !!wallet && !!journal && onBsc && !!bundle && !busy && !snapshot;

  async function connect(option: WalletOption) {
    setWalletDialog(false); setError(''); setBusy('连接钱包并读取服务器记录');
    try {
      await option.provider.request({ method: 'eth_requestAccounts' });
      const connected = await readWallet(option.provider);
      if (!connected) throw new Error('钱包未返回账户。');
      const serverJournal = await authenticateJournal(option.provider, connected.address);
      let browserStorage: Storage | null = null;
      try { browserStorage = localStorage; } catch { /* Browser storage is optional for new server-backed sessions. */ }
      if (browserStorage) await migrateLegacyDeployment(serverJournal, browserStorage);
      const state = await serverJournal.loadDeployment();
      setSelected(option); setWallet(connected); setJournal(serverJournal);
      setSnapshot(state.record); setArchives(state.archives);
      if (state.record) {
        const saved = state.record;
        setBudget(saved.input.maxGasBudgetBnb); setGasCap(saved.input.gasPriceCapGwei);
        setOperator(saved.input.operator); setTreasury(saved.input.treasury);
        setCustomRoles(saved.input.operator.toLowerCase() !== saved.account.toLowerCase() || saved.input.treasury.toLowerCase() !== saved.account.toLowerCase());
      }
    } catch (err) { setError(messageOf(err)); } finally { setBusy(''); }
  }
  async function requestConnection() {
    if (wallets.length === 1) return connect(wallets[0]);
    setWalletDialog(true);
  }
  async function checkConfig() {
    if (!selected || !bundle) return;
    setError(''); setReport(null); setBusy('检查配置');
    try { setReport(await preflight(selected.provider, bundle, activeInput)); }
    catch (err) { setError(messageOf(err)); } finally { setBusy(''); }
  }
  const createEngine = () => {
    if (!selected || !bundle || !journal) throw new Error('请先连接钱包，认证服务器记录并等待合约产物加载。');
    return new DeploymentEngine(selected.provider, bundle, {
      readLatest: () => journal.readLatestDeployment(),
      persist: (value: DeploymentSnapshot) => journal.saveDeployment(value),
      onUpdate: (value: DeploymentSnapshot) => { setSnapshot(JSON.parse(JSON.stringify(value))); },
    });
  };
  async function deploy() {
    if (running.current) return;
    running.current = true; setConfirmation(false); setError(''); setBusy('部署进行中');
    try { await createEngine().start(activeInput); }
    catch (err) { setError(messageOf(err)); }
    finally { running.current = false; setBusy(''); await refreshWallet(); }
  }
  async function resume(readOnly = false) {
    if (!snapshot || running.current) return;
    running.current = true; setError(''); setBusy(readOnly ? '核对链上回执' : '继续部署');
    try { const engine = createEngine(); if (readOnly) await engine.reconcile(snapshot); else await engine.resume(snapshot); }
    catch (err) { setError(messageOf(err)); }
    finally { running.current = false; setBusy(''); await refreshWallet(); }
  }
  async function recoverMinedTransaction() {
    if (!snapshot || running.current) return;
    running.current = true; setError(''); setBusy('核对交易哈希');
    try {
      await createEngine().recoverMinedTransaction(snapshot, recoveryHash);
      setRecoveryHash('');
    } catch (err) { setError(messageOf(err)); }
    finally { running.current = false; setBusy(''); await refreshWallet(); }
  }
  async function archiveAborted() {
    if (!snapshot || !journal || running.current) return;
    running.current = true; setError(''); setBusy('核对并保存旧部署');
    try {
      const checked = await createEngine().reconcile(snapshot);
      if (checked.status !== 'aborted') throw new Error('旧部署尚未核实终止，不能新建部署。');
      const current = await journal.readLatestDeployment();
      if (!current || current.id !== checked.id || current.status !== 'aborted') throw new Error('部署记录已被其他页面更新，请刷新后重试。');
      const state = await journal.archiveDeployment(checked.id);
      setArchives(state.archives); setSnapshot(null); setRecoveryHash(''); setReport(null);
    } catch (err) { setError(messageOf(err)); }
    finally { running.current = false; setBusy(''); }
  }
  async function adjustBudget() {
    if (!snapshot || running.current) return;
    running.current = true; setError(''); setBusy('核对预算');
    try { await createEngine().adjustLimits(snapshot, { maxGasBudgetBnb: budget, gasPriceCapGwei: gasCap }); }
    catch (err) { setError(messageOf(err)); }
    finally { running.current = false; setBusy(''); }
  }
  async function changeNetwork() { if (!selected) return; setBusy('切换网络'); setError(''); try { await switchToBsc(selected.provider); await refreshWallet(); } catch (err) { setError(messageOf(err)); } finally { setBusy(''); } }
  function exportRecord() { if (snapshot) download(`pinkuang-bsc-${snapshot.id}.json`, snapshot); }
  function exportManifest() {
    if (!snapshot || !bundle) return;
    try { download(`pinkuang-bsc-public-contracts-${snapshot.id}.json`, deploymentManifest(snapshot, bundle)); }
    catch (err) { setError(messageOf(err)); }
  }

  return <div className="app-shell">
    <aside className={`sidebar ${menuOpen ? 'mobile-open' : ''}`}>
      <a className="brand" href="#" onClick={e => { e.preventDefault(); setTab('deploy'); }}><span className="brand-symbol"><i/><i/><i/></span><span>拼矿<span className="brand-english">PINKUANG</span></span></a>
      <div className="workspace-label">项目工作台<span>V 0.1</span></div>
      <nav aria-label="主导航">
        {([{ id: 'deploy', icon: Rocket, title: '合约部署' }, { id: 'market', icon: Blocks, title: '份额市场' }, { id: 'pricing', icon: Network, title: '矿机报价' }, { id: 'records', icon: FileClock, title: '部署记录' }, { id: 'governance', icon: ShieldCheck, title: '升级与权限' }] as const).map(item => <button key={item.id} className={`nav-item ${tab === item.id ? 'active' : ''}`} onClick={() => { setTab(item.id); setMenuOpen(false); }}><item.icon size={19}/>{item.title}{tab === item.id && <ChevronRight size={15}/>}</button>)}
      </nav>
      <div className="sidebar-bottom"><div className="network-mini"><span className="green-dot"/> BNB Smart Chain <span>56</span></div><a href="https://github.com/jianfengliao774-sketch/pinkuang" target="_blank" rel="noreferrer"><GitBranch size={15}/> 项目源码 <ArrowUpRight size={15}/></a><p>合约与资产，由你掌控。</p></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setMenuOpen(!menuOpen)}><Menu size={20}/></button><span>拼矿协议</span><ChevronRight size={14}/><strong>{tab === 'deploy' ? '合约部署' : tab === 'market' ? '份额市场' : tab === 'pricing' ? '矿机报价' : tab === 'funding' ? '筹款与购机' : tab === 'records' ? '部署记录' : '升级与权限'}</strong></div><div className="topbar-actions"><span className="chain-tag"><span className="bnb-icon">◆</span>BSC 主网</span><button className={`wallet-button ${wallet ? 'connected' : ''}`} onClick={requestConnection} disabled={!!busy}><Wallet size={17}/>{wallet ? short(wallet.address) : '连接钱包'}{wallet && <span className="green-dot"/>}</button></div></header>
      <main>
        <div className="page-heading"><div><div className="eyebrow">{tab === 'deploy' ? 'DEPLOYMENT CONSOLE' : tab === 'market' ? 'SHARE MARKET' : tab === 'pricing' ? 'FIRSTO MINER QUOTES' : tab === 'funding' ? 'FUNDING & PURCHASE' : tab === 'records' ? 'ON-CHAIN RECORDS' : 'UPGRADE GOVERNANCE'}</div><h1>{tab === 'deploy' ? '部署你的拼矿合约' : tab === 'market' ? '让每一份算力，自由流转' : tab === 'pricing' ? '以真实矿机报价，为筹款定价' : tab === 'funding' ? '一起筹款，按约定买矿机' : tab === 'records' ? '每一笔部署，都有记录' : '可升级，也有等待期'}</h1><p>{tab === 'deploy' ? '连接钱包，核对配置，将可升级合约部署到 BSC 主网。' : tab === 'market' ? '查看真实挂单，交易整数份额，领取成交卖款。' : tab === 'pricing' ? '参考 Firsto 产能价，保留报价时间与资金预算。' : tab === 'funding' ? '锁定矿机条件与购机预算，余款按份额计入可领取余额。' : tab === 'records' ? '读取服务器保存的记录，核对链上交易和合约地址。' : 'Factory、交易市场和资金池通过同一时间锁管理升级。'}</p></div><span className="test-label"><span/>主网小额测试</span></div>
        {(error || loadError || snapshot?.error) && <div className="alert alert-error" role="alert"><OctagonAlert size={20}/><div><strong>操作未完成</strong><p>{error || loadError || snapshot?.error}</p></div>{error && <button className="icon-button" aria-label="关闭提示" onClick={() => setError('')}><X size={16}/></button>}</div>}
        {wallet && !onBsc && <div className="alert alert-warning"><Network size={20}/><div><strong>钱包当前连接的不是 BSC 主网</strong><p>当前 Chain ID：{wallet.chainId}。切换到 56 后才能继续。</p></div><button className="small-button" onClick={changeNetwork} disabled={!!busy}>切换网络<ArrowRight size={15}/></button></div>}

        {tab === 'deploy' && <>
          <div className="journey"><div className={wallet ? 'finished' : 'current'}><span>{wallet ? <Check size={16}/> : '01'}</span><section><b>连接钱包</b><small>{wallet ? '钱包已连接' : '确认部署账户'}</small></section></div><i/><div className={report || snapshot ? 'finished' : wallet ? 'current' : ''}><span>{report || snapshot ? <Check size={16}/> : '02'}</span><section><b>检查配置</b><small>核对角色与链上依赖</small></section></div><i/><div className={complete ? 'finished' : snapshot ? 'current' : ''}><span>{complete ? <Check size={16}/> : '03'}</span><section><b>部署与验证</b><small>{complete ? '已完成链上核验' : '确认交易，保存结果'}</small></section></div></div>
          <div className="deploy-layout"><div className="left-column">
            <section className="card config-card"><div className="card-heading"><div><span className="section-icon"><Blocks size={19}/></span><h2>部署配置</h2></div><span className="subtle-tag">单钱包模式</span></div>
              <div className="network-select"><span className="network-logo">◆</span><div><b>BNB Smart Chain</b><small>主网 · Chain ID 56</small></div><span className="live-tag">MAINNET</span><LockKeyhole size={15}/></div>
              <div className="field-label"><label htmlFor="owner">管理钱包</label><span>拥有升级提案权</span></div><div className={`wallet-field ${wallet ? 'filled' : ''}`}><Wallet size={18}/><input id="owner" value={snapshot?.input.ownerMultisig || wallet?.address || ''} placeholder="连接后自动使用当前钱包" readOnly/><span className="field-badge">自动</span></div>
              <p className="field-help">升级由此钱包发起，等待至少 48 小时后执行。</p>
              <label className="toggle-row"><input type="checkbox" checked={!customRoles} disabled={!!snapshot || !!busy} onChange={event => { setCustomRoles(!event.target.checked); setOperator(wallet?.address || ''); setTreasury(wallet?.address || ''); }}/><span><b>运营和金库使用同一个钱包</b><small>适合当前单钱包小额测试。</small></span><span className="toggle-track"/></label>
              {customRoles && <div className="custom-roles"><label>运营地址<input aria-label="运营地址" className="text-input mono" value={operator} onChange={e => setOperator(e.target.value.trim())} placeholder="0x…" disabled={!!busy || !!snapshot}/></label><label>金库地址<input aria-label="金库地址" className="text-input mono" value={treasury} onChange={e => setTreasury(e.target.value.trim())} placeholder="0x…" disabled={!!busy || !!snapshot}/></label></div>}
              <div className="budget-row"><div><label htmlFor="budget">部署 Gas 总预算</label><div className="unit-input"><input id="budget" value={budget} inputMode="decimal" onChange={e => setBudget(e.target.value)} disabled={!!busy || !!complete || !!aborted}/><span>BNB</span></div></div><div className="balance"><span>钱包可用余额</span><b>{wallet ? Number(wallet.balance).toLocaleString('en-US', { maximumFractionDigits: 6 }) : '—'} <small>BNB</small></b></div></div>
              <details className="advanced"><summary>高级配置与协议地址<ChevronDown size={15}/></summary><div className="advanced-body"><label htmlFor="gas-price">Gas 单价上限（Gwei）</label><input id="gas-price" className="text-input" value={gasCap} inputMode="decimal" disabled={!!complete || !!aborted || !!busy} onChange={e => setGasCap(e.target.value)}/><p>每笔广播前实时估算 Gas；累计已花费与下一笔估算上限超过预算时暂停。钱包手动加价可能超出页面预算。</p><div className="protocol-list">{protocols.map(([name, address]) => <div key={name}><span>{name}</span><Address value={address}/></div>)}</div><p>链上有代码不代表已证明协议安全，请核对上述协议的来源与代码。</p></div></details>
              {snapshot && !complete && !aborted && <div className="budget-recovery"><button className="small-button" disabled={!!busy || !wallet || !onBsc} onClick={() => void adjustBudget()}><RefreshCw size={14}/>保存提高后的预算并检查</button><p>仅提高费用上限；保留角色、已确认交易和合约代码。保存后再点击继续部署。</p></div>}
              <div className="config-footer"><Fingerprint size={15}/><span>Solidity 0.8.24</span><span>·</span><span>本地编译产物{bundle ? '已就绪' : '加载中'}</span></div>
            </section>

            <section className="card progress-card"><div className="card-heading"><div><span className="section-icon"><PackageCheck size={19}/></span><h2>部署进度</h2></div><span className="progress-count">{confirmed}<span> / {total} 笔</span></span></div><div className="progress-track"><div style={{ width: `${confirmed / total * 100}%` }}/></div>
              {!snapshot ? <div className="progress-empty"><div className="step-grid"><span>01 — {LIBRARY_NAMES.length.toString().padStart(2, '0')}<b>部署基础库</b></span><span>{LIBRARY_NAMES.length + 1} — {LIBRARY_NAMES.length + 4}<b>部署协调器与实现</b></span><span>{LIBRARY_NAMES.length + 5}<b>原子初始化</b></span></div><p><CircleHelp size={15}/>一键开始后，按顺序在钱包中确认每笔交易。</p></div> : <><ol className="transaction-list">{snapshot.steps.map((step, index) => <li key={index} className={`tx-${step.status}`}><span className="tx-icon">{step.status === 'confirmed' ? <Check size={15}/> : ['submitted', 'signing'].includes(step.status) ? <LoaderCircle className="spin" size={15}/> : index + 1}</span><div><b>{step.label}</b><small>{step.status === 'confirmed' ? '已确认' : step.status === 'submitted' ? '已广播，等待确认' : step.status === 'signing' ? '等待钱包签名' : step.status === 'cancelled' ? '钱包取消已最终确认，旧部署终止' : step.status === 'replaced' ? '钱包替换已最终确认，旧部署终止' : step.status === 'failed' ? '链上失败，禁止自动重发' : step.status === 'rejected' ? '签名已取消，可继续' : step.status === 'uncertain' ? '发送结果不明，禁止重发' : '待处理'}</small></div>{step.txHash && <a href={`${EXPLORER}/tx/${step.txHash}`} target="_blank" rel="noreferrer" title={step.txHash}><span>{short(step.txHash)}</span><ArrowUpRight size={14}/></a>}{step.replacementHash && step.replacementHash !== step.txHash && <a href={`${EXPLORER}/tx/${step.replacementHash}`} target="_blank" rel="noreferrer" title={step.replacementHash}>替换交易<ArrowUpRight size={14}/></a>}</li>)}</ol>{recoveryStep && <div className="budget-recovery"><label htmlFor="recovery-hash" className="field-label">核对 {recoveryStep.label} 的交易（nonce {recoveryStep.nonce}）</label><input id="recovery-hash" className="text-input mono" value={recoveryHash} placeholder="原交易、加速或取消交易的完整哈希" spellCheck={false} autoComplete="off" disabled={!!busy} onChange={event => setRecoveryHash(event.target.value)}/><button className="small-button" disabled={!!busy || !onBsc || !bundle || !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash.trim())} onClick={() => void recoverMinedTransaction()}><ShieldCheck size={14}/>只读核验并恢复</button><p>原交易与同 nonce 加速、取消或替换均只读核验。同内容且执行成功可继续；取消、其他内容或链上失败最终确认后，旧部署终止并保存实际 Gas。不会自动重发。</p></div>}{aborted && <div className="budget-recovery"><p>此部署已终止。先前部署的合约地址和实际 Gas 保留在记录中；新部署需要重新支付后续 Gas。</p></div>}{complete && <div className="success-inline"><CheckCheck size={20}/><span>部署及权限核验完成，地址已保存。</span></div>}</>}
            </section>
          </div><aside className="right-column">
            <section className="architecture-card"><div className="architecture-top"><span className="gold-icon"><GitBranch size={19}/></span><span>为后续升级做好准备</span></div><h2>代码可升级。<br/><span>权限有边界。</span></h2><div className="governance-flow"><div><Wallet size={17}/><span>你的管理钱包</span><small>发起提案</small></div><i/><div><LockKeyhole size={17}/><span>时间锁</span><strong>48h</strong></div><i/><div className="flow-contracts"><span>Factory<small>UUPS</small></span><span>Market<small>UUPS</small></span><span>Vault<small>Beacon</small></span></div></div><p>资金池通过共享 Beacon 升级，<br/>一次升级会影响所有关联池。</p><button onClick={() => setTab('governance')}>查看升级与权限<ArrowUpRight size={16}/></button></section>
            <section className="card deployment-summary"><h2>本次部署</h2><dl><div><dt>目标网络</dt><dd>BSC 主网</dd></div><div><dt>治理方式</dt><dd>单钱包 + 时间锁</dd></div><div><dt>钱包确认</dt><dd>{total} 笔交易</dd></div><div><dt>业务资金转入</dt><dd>0 BNB</dd></div><div><dt>Gas 总预算</dt><dd>{snapshot?.input.maxGasBudgetBnb || budget || '—'} BNB</dd></div>{snapshot && <div><dt>实际已花费</dt><dd>{Number(formatEther(snapshot.spentWei || '0')).toFixed(6)} BNB</dd></div>}</dl>
              {report && !snapshot && <div className="preflight-passed"><ShieldCheck size={17}/><span>链上配置检查通过</span></div>}
              {!wallet ? <button className="primary-button" onClick={requestConnection} disabled={!!busy}><Wallet size={18}/>连接钱包开始<ArrowRight size={18}/></button> : !onBsc ? <button className="primary-button" onClick={changeNetwork} disabled={!!busy}>切换至 BSC 主网<ArrowRight size={18}/></button> : snapshot ? aborted ? <><button className="primary-button" disabled={!!busy || !bundle} onClick={() => void archiveAborted()}><FileClock size={18}/>保存旧记录并新建部署</button><button className="text-button" disabled={!!busy} onClick={exportRecord}><ArrowDownToLine size={14}/>导出旧记录 JSON</button></> : <><button className="primary-button" disabled={!!busy || !bundle} onClick={() => complete ? exportRecord() : void resume()}>{busy ? <LoaderCircle className="spin" size={18}/> : complete ? <ArrowDownToLine size={18}/> : <Play size={17}/>} {busy || (complete ? '导出部署记录' : '核对并继续部署')}</button>{!complete && <button className="text-button" onClick={() => void resume(true)} disabled={!!busy}><RefreshCw size={14}/>只核对链上回执</button>}</> : <button className="primary-button" disabled={!canStart} onClick={() => report ? setConfirmation(true) : void checkConfig()}>{busy ? <LoaderCircle className="spin" size={18}/> : report ? <Rocket size={18}/> : <ShieldCheck size={18}/>} {busy || (report ? '开始一键部署' : '检查部署配置')}<ArrowRight size={18}/></button>}
              <p className="signer-note"><LockKeyhole size={12}/>签名始终在你的钱包中完成</p></section>
            <div className="risk-note"><OctagonAlert size={17}/><p>这是主网操作，会消耗真实 BNB。单钱包私钥持有人拥有升级权，请先用小额资产验证完整业务流程。</p></div>
          </aside></div>
        </>}

        {tab === 'pricing' && <PricingPanel onSavePlan={journal ? record => journal.saveQuote(record) : undefined}/>}
        {tab === 'market' && <MarketPage wallet={selected?.provider || null} account={wallet?.address || null} journal={journal?.marketStorage() ?? null} factoryAddress={complete ? snapshot?.addresses.factory : undefined} onConnect={() => void requestConnection()}/>}
        {tab === 'records' && <section className="card records-card"><div className="card-heading"><div><FileClock size={21}/><h2>部署记录</h2></div>{snapshot && <div className="record-actions"><button className="small-button" onClick={exportRecord}><ArrowDownToLine size={16}/>导出完整记录</button>{complete && <button className="small-button" disabled={!bundle} onClick={exportManifest}><ArrowDownToLine size={16}/>导出前端合约清单</button>}</div>}</div>{!snapshot ? <div className="large-empty"><FileClock size={36}/><h2>{archives.length ? '当前没有进行中的部署' : '还没有部署记录'}</h2><p>{wallet ? archives.length ? '历史终止记录见下方。' : '开始部署后，交易记录会保存在服务器。' : '连接钱包后读取该钱包在服务器保存的记录。'}</p><button className="small-button" onClick={() => setTab('deploy')}>前往合约部署<ArrowRight size={16}/></button></div> : <div className="records-body"><div className="record-meta"><span className={complete ? 'status-success' : 'status-pending'}>{complete ? '已完成核验' : '部署未完成'}</span><span>{new Date(snapshot.createdAt).toLocaleString('zh-CN')}</span><span>Chain ID 56</span><Address value={snapshot.account}/></div><div className="address-table">{Object.entries(snapshot.addresses).map(([name, value]) => <div key={name}><b>{name}</b><Address value={value}/></div>)}</div>{!Object.keys(snapshot.addresses).length && <p>暂未确认合约地址。请回到部署页核对交易回执。</p>}<details className="record-json"><summary>完整部署记录与核验结果<ChevronDown size={16}/></summary><pre>{JSON.stringify(snapshot, null, 2)}</pre></details><p className="field-help">完整记录保存在服务器，并按钱包隔离。建议另行导出备份，以便核对交易及后续升级。</p></div>}</section>}

        {tab === 'records' && archives.length > 0 && <section className="card records-card"><div className="card-heading"><div><FileClock size={21}/><h2>已保存的终止部署</h2></div></div><div className="records-body"><div className="address-table">{archives.map(item => <div key={item.id}><b>{new Date(item.createdAt).toLocaleString('zh-CN')}</b><Address value={item.account}/><span>已花费 {Number(formatEther(item.spentWei)).toFixed(6)} BNB</span><button className="small-button" onClick={() => download(`pinkuang-bsc-aborted-${item.id}.json`, item)}><ArrowDownToLine size={14}/>导出</button></div>)}</div><p className="field-help">旧部署的交易哈希、合约地址和实际 Gas 已留存。新部署不会复用旧合约。</p></div></section>}
        {tab === 'governance' && <div className="governance-page"><section className="card"><div className="card-heading"><div><ShieldCheck size={22}/><h2>谁可以升级合约</h2></div><span className="subtle-tag">单钱包管理</span></div><div className="governance-content"><div className="governance-banner"><KeyRound size={28}/><div><b>你的管理钱包发起升级</b><p>提案需要经过至少 48 小时等待。管理钱包可以在执行前取消；等待结束后，任何账户都可执行已批准的操作。</p></div></div><table><thead><tr><th>合约</th><th>升级方式</th><th>授权执行者</th></tr></thead><tbody><tr><td>PoolFactory</td><td>UUPS 代理</td><td>固定时间锁</td></tr><tr><td>ShareMarket</td><td>UUPS 代理</td><td>固定时间锁</td></tr><tr><td>所有 PoolVault</td><td>共享 Beacon</td><td>时间锁持有 Beacon</td></tr></tbody></table><div className="governance-points"><div><LockKeyhole size={19}/><b>48 小时等待下限</b><p>当前时间锁不允许将调度等待降到 48 小时以下。</p></div><div><Blocks size={19}/><b>原子初始化</b><p>代理创建与初始化在同一笔交易完成，避免未初始化代理暴露。</p></div><div><GitBranch size={19}/><b>保持资金池绑定</b><p>Beacon 新实现必须保持同一个官方 Factory 地址。</p></div></div><div className="alert alert-warning"><OctagonAlert size={21}/><div><strong>升级能力不等于安全保证</strong><p>有权限的钱包仍可提议恶意实现。时间锁提供反应时间；每次升级仍需审查代码、验证存储布局，并执行完整业务回归测试。</p></div></div><p className="governance-disclaimer">部署台核验的是部署图与权限配置，不能替代对业务逻辑、外部协议和未来实现的独立审计。修改实现时须继续保留当前的时间锁授权限制。</p></div></section></div>}
        <footer className="page-footer"><span><span className="tiny-brand">◆</span>拼矿协议<span className="footer-divider">/</span>部署工作台</span><a href="https://github.com/jianfengliao774-sketch/pinkuang/blob/codex/t1e-voting-sale/docs/deployment.md" target="_blank" rel="noreferrer">合约部署说明<ExternalLink size={13}/></a></footer>
      </main>
    </div>
    {walletDialog && <div className="modal-backdrop" onClick={() => setWalletDialog(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="wallet-title" onClick={event => event.stopPropagation()}><button autoFocus className="icon-button modal-close" aria-label="关闭钱包选择" onClick={() => setWalletDialog(false)}><X size={20}/></button><span className="modal-emblem"><Wallet size={25}/></span><h2 id="wallet-title">连接你的钱包</h2>{wallets.length ? <div className="wallet-options">{wallets.map(option => <button key={option.id} onClick={() => void connect(option)}><Wallet size={21}/>{option.name}<ArrowRight size={18}/></button>)}</div> : <><p>当前浏览器未检测到钱包。请在已安装钱包扩展的 Chrome、Edge，或钱包内置浏览器中打开此页面。</p><p className="muted">在 Codex 内预览时，可以先查看页面，再复制页面地址到你的钱包浏览器。</p></>}<p className="modal-note">连接后会要求一次无 Gas 签名，用于读取你在服务器保存的操作记录；不收集私钥或助记词。</p></section></div>}
    {confirmation && <div className="modal-backdrop"><section className="modal confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title"><button autoFocus className="icon-button modal-close" aria-label="返回检查配置" onClick={() => setConfirmation(false)}><X size={20}/></button><span className="modal-emblem"><Rocket size={25}/></span><h2 id="confirm-title">准备部署到 BSC 主网</h2><p>将依次请求 {LIBRARY_NAMES.length + 5} 笔交易签名，仅支付 Gas。请保持页面打开，并逐笔核对钱包中的网络和交易内容。</p><div className="confirm-summary"><div><span>管理钱包</span><b>{short(activeInput.ownerMultisig)}</b></div><div><span>Gas 总预算</span><b>{budget} BNB</b></div><div><span>升级等待</span><b>至少 48 小时</b></div></div><label className="acknowledgment"><input type="checkbox" checked={governanceReviewed} onChange={e => setGovernanceReviewed(e.target.checked)}/><span>我已核对管理、运营和金库地址，理解单钱包拥有升级权及私钥保管责任。</span></label><label className="acknowledgment"><input type="checkbox" checked={protocolReviewed} onChange={e => setProtocolReviewed(e.target.checked)}/><span>我已核对协议地址与代码，理解这是消耗真实 BNB 的主网测试，部署检查不等同于安全审计。</span></label><button className="primary-button" disabled={!governanceReviewed || !protocolReviewed || !!busy} onClick={() => void deploy()}>开始部署，在钱包中确认<ArrowRight size={18}/></button><button className="text-button" onClick={() => setConfirmation(false)}>返回检查配置</button></section></div>}
  </div>;
}
