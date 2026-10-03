import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Blocks, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Copy, ExternalLink, FileClock, Fingerprint, GitBranch, KeyRound, LoaderCircle, LockKeyhole, Menu, Network, OctagonAlert, PackageCheck, Play, RefreshCw, Rocket, ShieldCheck, Wallet, X } from 'lucide-react';
import WalletQrChoice from './WalletQrChoice';
import FreshActivationPanel from './FreshActivationPanel';
import { FRESH_ADMIN_ONE, FRESH_ADMIN_TWO, FRESH_GAS_WALLET } from './fresh-activation';
import { FRESH_DEPLOYER } from '../shared/fresh-roles.mjs';
import { ArchiveCompletedAction } from './ArchiveAction';
import { displayDecimal, displayUnits } from './display';
import { DeploymentEngine, LIBRARY_NAMES, INTEGRATED_TRANSACTION_COUNT, preflight, validateArtifacts, PROTOCOL_ADDRESSES, type ArtifactBundle, type DeploymentInput, type DeploymentSnapshot, type PreflightReport } from './deployment';
import { migrateLegacyDeployment } from './legacy-deployment';
import { deploymentManifest } from './manifest';
import { authenticateJournal, ServerJournal } from './server-journal';
import { discoverWallets, messageOf, readWallet, switchToBsc, type WalletOption, type WalletState } from './wallet';

const EXPLORER = 'https://bscscan.com';
const IS_FRESH = import.meta.env.MODE === 'fresh';
// The new deployment console must not expose the old product's market or
// persist its browser intents into the new deployment journal.
const MarketPage = IS_FRESH ? null : lazy(() => import('./MarketPage'));
const PricingPanel = IS_FRESH ? null : lazy(() => import('./PricingPanel'));
// The fresh console has no legacy upgrade signing route. Vite removes this
// dynamic import entirely from the reviewed fresh-mode bundle.
const UpgradeConsole = IS_FRESH ? null : lazy(() => import('./UpgradeConsole'));
const LegacyCutover = IS_FRESH ? null : lazy(() => import('./LegacyCutover'));
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
  const [walletScan, setWalletScan] = useState(0);
  const [selected, setSelected] = useState<WalletOption | null>(null);
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [journal, setJournal] = useState<ServerJournal | null>(null);
  const [walletDialog, setWalletDialog] = useState(false);
  const [qrPending, setQrPending] = useState(false);
  const [bundle, setBundle] = useState<ArtifactBundle | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
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
  const [archiveCursor, setArchiveCursor] = useState<string | null>(null);
  const [latestArchivedComplete, setLatestArchivedComplete] = useState<DeploymentSnapshot | null>(null);
  const [confirmation, setConfirmation] = useState(false);
  const [governanceReviewed, setGovernanceReviewed] = useState(false);
  const [protocolReviewed, setProtocolReviewed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const running = useRef(false);
  const connecting = useRef(false);
  const advancedRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => discoverWallets(setWallets), [walletScan]);
  useEffect(() => {
    const abort = new AbortController();
    fetch(`${import.meta.env.BASE_URL}deployment-artifacts.json`, { signal: abort.signal, cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error('编译产物未加载，请运行 npm run artifacts 后重试。');
      const value = await response.json();
      if (value.schemaVersion !== 1 || !value.artifacts?.AtomicDeployment?.abi?.some((item: { name?: string }) => item.name === 'deployIntegratedSingleOwner')) throw new Error('编译产物不支持单机与多机项目完整部署，请重新生成。');
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
        setArchiveCursor(null); setLatestArchivedComplete(null);
        setError('钱包账户已变化，请重新连接以读取对应钱包的服务器记录。');
      } else setWallet(current);
    }
    catch (err) { setError(messageOf(err)); }
  }, [selected, journal]);
  useEffect(() => {
    if (!selected) return;
    const change = () => { setReport(null); setConfirmation(false); setInfo(''); void refreshWallet(); };
    selected.provider.on?.('accountsChanged', change);
    selected.provider.on?.('chainChanged', change);
    selected.provider.on?.('disconnect', change);
    return () => { selected.provider.removeListener?.('accountsChanged', change); selected.provider.removeListener?.('chainChanged', change); selected.provider.removeListener?.('disconnect', change); };
  }, [selected, refreshWallet]);
  useEffect(() => { setReport(null); setGovernanceReviewed(false); setProtocolReviewed(false); }, [operator, treasury, customRoles, budget, gasCap, wallet?.address, wallet?.chainId]);
  useEffect(() => { if (!confirmation && !walletDialog) return; const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setConfirmation(false); setWalletDialog(false); } }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [confirmation, walletDialog]);

  const activeInput: DeploymentInput = {
    governanceMode: 'single', ownerMultisig: wallet?.address || '',
    operator: !IS_FRESH && customRoles ? operator : wallet?.address || '',
    treasury: !IS_FRESH && customRoles ? treasury : wallet?.address || '',
    maxGasBudgetBnb: budget, gasPriceCapGwei: gasCap, governanceReviewed, protocolReviewed,
  };
  const confirmed = snapshot?.steps.filter(step => step.status === 'confirmed').length || 0;
  const total = snapshot?.steps.length || INTEGRATED_TRANSACTION_COUNT;
  const complete = snapshot?.status === 'complete';
  const aborted = snapshot?.status === 'aborted';
  const latestCompleted = complete ? snapshot : latestArchivedComplete;
  const recoveryStep = snapshot?.steps.find(step =>
    ((step.status === 'uncertain' || step.status === 'signing') && !step.txHash) || (step.status === 'submitted' && !!step.txHash));
  const invalidEnvelopeStep = recoveryStep?.id === 'initialize' && recoveryStep.status === 'uncertain' &&
    recoveryStep.error?.includes('Invalid transaction envelope type: specified type "0x4" but included a gasPrice instead of maxFeePerGas and maxPriorityFeePerGas');
  const onBsc = wallet?.chainId === 56;
  const canStart = !!wallet && !!journal && onBsc && !!bundle && !busy && !snapshot;
  const nextStep = snapshot?.steps.find(step => step.status !== 'confirmed');
  const needsReceiptCheck = !!recoveryStep || snapshot?.status === 'failed';
  function deploymentError(err: unknown) {
    const message = messageOf(err);
    if (/Gas 单价.*(?:高于|超过).*上限/.test(message)) {
      if (advancedRef.current) advancedRef.current.open = true;
      return `${message} 可在“高级配置与协议地址”提高 Gas 单价上限；若已开始部署，先保存提高后的预算再继续。`;
    }
    return message;
  }

  function applyServerDeployment(state: Awaited<ReturnType<ServerJournal['loadDeployment']>>) {
    setSnapshot(state.record); setArchives(state.archives);
    setArchiveCursor(state.archiveNextCursor); setLatestArchivedComplete(state.latestCompleted);
    if (state.record) {
      const saved = state.record;
      setBudget(saved.input.maxGasBudgetBnb); setGasCap(saved.input.gasPriceCapGwei);
      setOperator(saved.input.operator); setTreasury(saved.input.treasury);
      setCustomRoles(saved.input.operator.toLowerCase() !== saved.account.toLowerCase() || saved.input.treasury.toLowerCase() !== saved.account.toLowerCase());
    }
  }

  async function connect(option: WalletOption) {
    if (connecting.current || running.current || busy) return;
    connecting.current = true;
    setWalletDialog(false); setError(''); setInfo(''); setBusy('连接钱包并读取服务器记录');
    try {
      await option.provider.request({ method: 'eth_requestAccounts' });
      const connected = await readWallet(option.provider);
      if (!connected) throw new Error('钱包未返回账户。');
      if (IS_FRESH && connected.address.toLowerCase() !== FRESH_DEPLOYER.toLowerCase())
        throw new Error(`当前连接的是 ${connected.address}。此独立部署台仅接受已确认的部署钱包 ${FRESH_DEPLOYER}；请在钱包扩展中切换账户。`);
      const serverJournal = await authenticateJournal(option.provider, connected.address);
      let browserStorage: Storage | null = null;
      try { browserStorage = localStorage; } catch { /* Browser storage is optional for new server-backed sessions. */ }
      if (import.meta.env.MODE !== 'fresh' && browserStorage)
        await migrateLegacyDeployment(serverJournal, browserStorage);
      const state = await serverJournal.loadDeployment();
      setSelected(option); setWallet(connected); setJournal(serverJournal);
      applyServerDeployment(state);
    } catch (err) { setError(messageOf(err)); } finally { connecting.current = false; setBusy(''); }
  }
  async function requestConnection() {
    if (connecting.current || running.current || busy) return;
    setWalletScan(value => value + 1);
    setWalletDialog(true);
  }
  async function refreshServerDeployment() {
    if (!journal || running.current || busy) return;
    setError(''); setInfo(''); setBusy('读取服务器记录');
    try {
      applyServerDeployment(await journal.loadDeployment());
      setReport(null); setRecoveryHash('');
      setInfo('已读取该钱包在服务器保存的最新部署记录。');
    } catch (err) { setError(messageOf(err)); }
    finally { setBusy(''); }
  }
  async function checkConfig() {
    if (!selected || !bundle) return;
    setError(''); setInfo(''); setReport(null); setBusy('检查配置');
    try { setReport(await preflight(selected.provider, bundle, activeInput)); }
    catch (err) { setError(deploymentError(err)); } finally { setBusy(''); }
  }
  const createEngine = () => {
    if (!selected || !bundle || !journal) throw new Error('请先连接钱包，认证服务器记录并等待合约产物加载。');
    return new DeploymentEngine(selected.provider, bundle, {
      readLatest: () => journal.readLatestDeployment(),
      persist: (value: DeploymentSnapshot) => journal.saveDeployment(value),
      assertCurrentArtifact: digest => journal.assertCurrentArtifact(digest),
      readCurrentNonce: () => journal.readCurrentNonce(),
      releaseInvalidEnvelope: nonce => journal.releaseInvalidEnvelope(nonce),
      onUpdate: (value: DeploymentSnapshot) => { setSnapshot(JSON.parse(JSON.stringify(value))); },
    });
  };
  async function deploy() {
    if (running.current) return;
    running.current = true; setConfirmation(false); setError(''); setInfo(''); setBusy('部署进行中');
    try { await createEngine().start(activeInput, report ?? undefined); }
    catch (err) { setError(deploymentError(err)); }
    finally { running.current = false; setBusy(''); await refreshWallet(); }
  }
  async function resume(readOnly = false) {
    if (!snapshot || running.current) return;
    running.current = true; setError(''); setInfo(''); setBusy(readOnly ? '核对链上回执' : '继续部署');
    try { const engine = createEngine(); if (readOnly) await engine.reconcile(snapshot); else await engine.resume(snapshot); }
    catch (err) { setError(deploymentError(err)); }
    finally { running.current = false; setBusy(''); await refreshWallet(); }
  }
  async function recoverMinedTransaction() {
    if (!snapshot || running.current) return;
    running.current = true; setError(''); setInfo(''); setBusy('核对交易哈希');
    try {
      await createEngine().recoverMinedTransaction(snapshot, recoveryHash);
      setRecoveryHash('');
    } catch (err) { setError(messageOf(err)); }
    finally { running.current = false; setBusy(''); await refreshWallet(); }
  }
  async function releaseInvalidEnvelope() {
    if (!snapshot || running.current) return;
    running.current = true; setError(''); setInfo(''); setBusy('核对未发送交易');
    try {
      await createEngine().releaseInvalidEnvelope(snapshot);
      setInfo('已核对独立节点和钱包 nonce，交易格式错误未发送；可以继续最后一笔初始化。');
    } catch (err) { setError(messageOf(err)); }
    finally { running.current = false; setBusy(''); await refreshWallet(); }
  }
  function showArchivedDeployment(state: Awaited<ReturnType<ServerJournal['loadDeployment']>>) {
    setArchives(state.archives); setArchiveCursor(state.archiveNextCursor); setLatestArchivedComplete(state.latestCompleted);
    setSnapshot(null); setRecoveryHash(''); setReport(null);
    setGovernanceReviewed(false); setProtocolReviewed(false);
  }
  async function archiveCurrent() {
    if (!snapshot || !journal || running.current) return;
    if (snapshot.status === 'complete' && snapshot.steps.some(step => step.id === 'FreshPoolFactory')) {
      setError('新合约创世记录必须与第二阶段权限激活记录一起保留，当前不能归档。');
      return;
    }
    running.current = true; setError(''); setBusy('核对并保存旧部署');
    try {
      if (snapshot.status !== 'complete' && snapshot.status !== 'aborted') throw new Error('部署尚未完成或终止，不能归档。');
      const checked = snapshot.status === 'aborted' ? await createEngine().reconcile(snapshot) : snapshot;
      if (checked.status !== 'complete' && checked.status !== 'aborted') throw new Error('旧部署状态未核实，不能新建部署。');
      const current = await journal.readLatestDeployment();
      if (!current || current.id !== checked.id || current.status !== checked.status) throw new Error('部署记录已被其他页面更新，请刷新后重试。');
      const state = await journal.archiveDeployment(checked.id);
      showArchivedDeployment(state);
    } catch (err) {
      try {
        const state = await journal.loadDeployment();
        if (state.record === null && state.archives.some(item => item.id === snapshot.id)) {
          showArchivedDeployment(state);
          return;
        }
        setSnapshot(state.record); setArchives(state.archives);
        setArchiveCursor(state.archiveNextCursor); setLatestArchivedComplete(state.latestCompleted);
      } catch { /* Keep the original archive failure when server readback also fails. */ }
      setError(messageOf(err));
    }
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
  async function exportManifest(record = snapshot) {
    if (!record || !bundle || !selected || !journal || busy) return;
    setError(''); setBusy('核对当前链上合约');
    try {
      const inspected = await createEngine().inspectGraphForManifest(record);
      download(`pinkuang-bsc-public-contracts-${record.id}.json`, deploymentManifest(inspected, bundle));
    } catch (err) { setError(messageOf(err)); }
    finally { setBusy(''); }
  }
  async function loadMoreArchives() {
    if (!archiveCursor || !journal || busy) return;
    setError(''); setBusy('读取更早部署');
    try {
      const page = await journal.loadArchivedDeployments(archiveCursor);
      setArchives(previous => {
        const ids = new Set(previous.map(item => item.id));
        return [...previous, ...page.items.filter(item => !ids.has(item.id))];
      });
      setArchiveCursor(page.nextCursor);
    } catch (err) { setError(messageOf(err)); }
    finally { setBusy(''); }
  }

  return <div className="app-shell">
    <aside className={`sidebar ${menuOpen ? 'mobile-open' : ''}`}>
      <a className="brand" href="#" onClick={e => { e.preventDefault(); setTab('deploy'); }}><span className="brand-symbol"><i/><i/><i/></span><span>拼矿<span className="brand-english">PINKUANG</span></span></a>
      <div className="workspace-label">项目工作台<span>V 0.1</span></div>
      <nav aria-label="主导航">
        {([{ id: 'deploy', icon: Rocket, title: '合约部署' }, ...(!IS_FRESH ? [{ id: 'market' as const, icon: Blocks, title: '份额市场' }, { id: 'pricing' as const, icon: Network, title: '矿机报价' }] : []), { id: 'records', icon: FileClock, title: '部署记录' }, { id: 'governance', icon: ShieldCheck, title: '升级与权限' }] as const).map(item => <button key={item.id} className={`nav-item ${tab === item.id ? 'active' : ''}`} onClick={() => { setTab(item.id); setMenuOpen(false); }}><item.icon size={19}/>{item.title}{tab === item.id && <ChevronRight size={15}/>}</button>)}
      </nav>
      <div className="sidebar-bottom"><div className="network-mini"><span className="green-dot"/> BNB Smart Chain <span>56</span></div><a href="https://github.com/jianfengliao774-sketch/pinkuang" target="_blank" rel="noreferrer"><GitBranch size={15}/> 项目源码 <ArrowUpRight size={15}/></a><p>合约与资产，由你掌控。</p></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setMenuOpen(!menuOpen)}><Menu size={20}/></button><span>拼矿协议</span><ChevronRight size={14}/><strong>{tab === 'deploy' ? '合约部署' : tab === 'market' ? '份额市场' : tab === 'pricing' ? '矿机报价' : tab === 'funding' ? '筹款与购机' : tab === 'records' ? '部署记录' : '升级与权限'}</strong></div><div className="topbar-actions"><span className="chain-tag"><span className="bnb-icon">◆</span>BSC 主网</span><button className={`wallet-button ${wallet ? 'connected' : ''}`} onClick={requestConnection} disabled={!!busy}><Wallet size={17}/>{wallet ? short(wallet.address) : '连接钱包'}{wallet && <span className="green-dot"/>}</button></div></header>
      <main>
        <div className="page-heading"><div><div className="eyebrow">{tab === 'deploy' ? 'DEPLOYMENT CONSOLE' : tab === 'market' ? 'SHARE MARKET' : tab === 'pricing' ? 'FIRSTO MINER QUOTES' : tab === 'funding' ? 'FUNDING & PURCHASE' : tab === 'records' ? 'ON-CHAIN RECORDS' : 'UPGRADE GOVERNANCE'}</div><h1>{tab === 'deploy' ? '部署你的拼矿合约' : tab === 'market' ? '让每一份算力，自由流转' : tab === 'pricing' ? '以真实矿机报价，为筹款定价' : tab === 'funding' ? '一起筹款，按约定买矿机' : tab === 'records' ? '每一笔部署，都有记录' : '可升级，也有等待期'}</h1><p>{tab === 'deploy' ? '连接钱包，核对配置，将可升级合约部署到 BSC 主网。' : tab === 'market' ? '查看真实挂单，交易整数份额，领取成交卖款。' : tab === 'pricing' ? '参考 Firsto 产能价，保留报价时间与资金预算。' : tab === 'funding' ? '锁定矿机条件与购机预算，余款按份额计入可领取余额。' : tab === 'records' ? '读取服务器保存的记录，核对链上交易和合约地址。' : 'Factory、交易市场和资金池通过同一时间锁管理升级。'}</p></div><span className="test-label"><span/>{IS_FRESH ? '新正式版部署' : '主网小额测试'}</span></div>
        {(error || loadError || snapshot?.error) && <div className="alert alert-error" role="alert"><OctagonAlert size={20}/><div><strong>操作未完成</strong><p>{error || loadError || snapshot?.error}</p></div>{error && <button className="icon-button" aria-label="关闭提示" onClick={() => setError('')}><X size={16}/></button>}</div>}
        {info && <div className="alert alert-success" role="status"><CheckCheck size={20}/><div><strong>服务器记录已同步</strong><p>{info}</p></div><button className="icon-button" aria-label="关闭提示" onClick={() => setInfo('')}><X size={16}/></button></div>}
        {wallet && !onBsc && <div className="alert alert-warning"><Network size={20}/><div><strong>钱包当前连接的不是 BSC 主网</strong><p>当前 Chain ID：{wallet.chainId}。切换到 56 后才能继续。</p></div><button className="small-button" onClick={changeNetwork} disabled={!!busy}>切换网络<ArrowRight size={15}/></button></div>}

        {tab === 'deploy' && <>
          <div className="journey"><div className={wallet ? 'finished' : 'current'}><span>{wallet ? <Check size={16}/> : '01'}</span><section><b>连接钱包</b><small>{wallet ? '钱包已连接' : '确认部署账户'}</small></section></div><i/><div className={report || snapshot ? 'finished' : wallet ? 'current' : ''}><span>{report || snapshot ? <Check size={16}/> : '02'}</span><section><b>检查配置</b><small>核对角色与链上依赖</small></section></div><i/><div className={complete ? 'finished' : snapshot ? 'current' : ''}><span>{complete ? <Check size={16}/> : '03'}</span><section><b>部署与验证</b><small>{complete ? '已完成链上核验' : '确认交易，保存结果'}</small></section></div></div>
          {LegacyCutover && (complete || (!snapshot && latestArchivedComplete))
            && latestCompleted?.kind !== 'integrated-v2'
            && <Suspense fallback={null}><LegacyCutover wallet={selected?.provider || null}
              account={wallet?.address || null} chainId={wallet?.chainId || null}/></Suspense>}
          <div className="deploy-layout"><div className="left-column">
            <section className="card config-card"><div className="card-heading"><div><span className="section-icon"><Blocks size={19}/></span><h2>部署配置</h2></div><span className="subtle-tag">{IS_FRESH ? '第一阶段硬件钱包' : '单钱包模式'}</span></div>
              <div className="network-select"><span className="network-logo">◆</span><div><b>BNB Smart Chain</b><small>主网 · Chain ID 56</small></div><span className="live-tag">MAINNET</span><LockKeyhole size={15}/></div>
              <div className="field-label"><label htmlFor="owner">{IS_FRESH ? '指定硬件钱包' : '管理钱包'}</label><span>拥有升级提案权</span></div><div className={`wallet-field ${wallet ? 'filled' : ''}`}><Wallet size={18}/><input id="owner" value={snapshot?.input.ownerMultisig || wallet?.address || ''} placeholder="连接后自动使用当前钱包" readOnly/><span className="field-badge">自动</span></div>
              <p className="field-help">{IS_FRESH ? '第一阶段由此钱包部署并暂持初始角色；第二阶段完成后保留时间锁提案与取消权限。' : '升级由此钱包发起，等待至少 48 小时后执行。'}</p>
              {IS_FRESH ? <div className="fresh-role-plan" aria-label="新部署两阶段角色安排">
                <b>第一阶段 · 指定硬件钱包临时持有角色</b>
                <p><span className="mono">{FRESH_DEPLOYER}</span> 同时担任两套 Factory 的 owner、operator 和 treasury。</p>
                <b>第二阶段 · 完成权限激活后</b>
                <p>PlatformAuthority 接管运营和金库；48 小时 Timelock 接管两套 Factory 的所有权。</p>
                <p>管理员：<span className="mono">{FRESH_ADMIN_ONE}</span>、<span className="mono">{FRESH_ADMIN_TWO}</span></p>
                <p>独立 Gas 钱包公开地址：<span className="mono">{FRESH_GAS_WALLET}</span></p>
                <p>整机出售冷却：3 天。出售表决：24 小时。</p>
              </div> : <>
                <label className="toggle-row"><input type="checkbox" checked={!customRoles} disabled={!!snapshot || !!busy} onChange={event => { setCustomRoles(!event.target.checked); setOperator(wallet?.address || ''); setTreasury(wallet?.address || ''); }}/><span><b>运营和金库使用同一个钱包</b><small>适合当前单钱包小额测试。</small></span><span className="toggle-track"/></label>
                {customRoles && <div className="custom-roles"><label>运营地址<input aria-label="运营地址" className="text-input mono" value={operator} onChange={e => setOperator(e.target.value.trim())} placeholder="0x…" disabled={!!busy || !!snapshot}/></label><label>金库地址<input aria-label="金库地址" className="text-input mono" value={treasury} onChange={e => setTreasury(e.target.value.trim())} placeholder="0x…" disabled={!!busy || !!snapshot}/></label></div>}
              </>}
              <div className="budget-row"><div><label htmlFor="budget">部署 Gas 总预算</label><div className="unit-input"><input id="budget" value={budget} inputMode="decimal" onChange={e => setBudget(e.target.value)} disabled={!!busy || !!complete || !!aborted}/><span>BNB</span></div></div><div className="balance"><span>钱包可用余额</span><b>{wallet ? displayDecimal(wallet.balance) : '—'} <small>BNB</small></b></div></div>
              <details className="advanced" ref={advancedRef}><summary>高级配置与协议地址<ChevronDown size={15}/></summary><div className="advanced-body"><label htmlFor="gas-price">Gas 单价上限（Gwei）</label><input id="gas-price" className="text-input" value={gasCap} inputMode="decimal" disabled={!!complete || !!aborted || !!busy} onChange={e => setGasCap(e.target.value)}/><p>{IS_FRESH ? '每笔使用已核对的固定 Gas 上限与当前 Gas 单价计算最高费用；累计已花费加该笔最高费用超过总预算时暂停。钱包手动加价可能超出页面预算。' : '每笔广播前实时估算 Gas；累计已花费与下一笔估算上限超过预算时暂停。钱包手动加价可能超出页面预算。'}</p><div className="protocol-list">{protocols.map(([name, address]) => <div key={name}><span>{name}</span><Address value={address}/></div>)}</div><p>链上有代码不代表已证明协议安全，请核对上述协议的来源与代码。</p></div></details>
              {snapshot && !complete && !aborted && <div className="budget-recovery"><button className="small-button" disabled={!!busy || !wallet || !onBsc} onClick={() => void adjustBudget()}><RefreshCw size={14}/>保存提高后的预算并检查</button><p>仅提高费用上限；保留角色、已确认交易和合约代码。保存后再点击继续部署。</p></div>}
              <div className="config-footer"><Fingerprint size={15}/><span>Solidity 0.8.24</span><span>·</span><span>部署产物{bundle ? '已校验' : loadError ? '校验失败' : '加载中'}</span></div>
            </section>

            {report && !snapshot && <section className="card preflight-card" aria-label="部署预检结果"><div className="card-heading"><div><span className="section-icon"><ShieldCheck size={19}/></span><h2>部署预检已通过</h2></div><span className="subtle-tag">{new Date(report.checkedAt).toLocaleTimeString('zh-CN')}</span></div><div className="preflight-facts"><div><span>可用余额</span><b>{displayUnits(report.balanceWei)} BNB</b></div><div><span>当前 Gas 单价</span><b>{displayUnits(report.gasPriceWei, 9)} Gwei</b></div><div><span>链上依赖</span><b>{Object.keys(report.protocols).length} 个地址有代码</b></div></div><p>点击开始后仍会核对钱包、余额、Gas 和待确认交易，再逐笔请求签名。预检快照超过 60 秒时会自动重查。</p><details><summary>查看部署前须知<ChevronDown size={15}/></summary><ul>{report.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details></section>}

            <section className="card progress-card"><div className="card-heading"><div><span className="section-icon"><PackageCheck size={19}/></span><h2>部署进度</h2></div><div className="progress-actions"><span className="progress-count">{confirmed}<span> / {total} 笔</span></span>{journal && <button className="small-button" disabled={!!busy} onClick={() => void refreshServerDeployment()} title="从服务器重新读取该钱包的部署记录"><RefreshCw size={14}/>刷新记录</button>}</div></div><div className="progress-track"><div style={{ width: `${confirmed / total * 100}%` }}/></div>
              {!snapshot ? <div className="progress-empty"><div className="step-grid"><span>01 — {LIBRARY_NAMES.length.toString().padStart(2, '0')}<b>部署基础库</b></span><span>{LIBRARY_NAMES.length + 1} — {LIBRARY_NAMES.length + 6}<b>部署协调器与实现</b></span><span>{INTEGRATED_TRANSACTION_COUNT}<b>同时初始化单机与多机项目</b></span></div><p><CircleHelp size={15}/>一键开始后，按顺序在钱包中确认每笔交易。进度逐步保存到服务器，保存失败即停止。</p></div> : <>{!complete && !aborted && nextStep && <div className={`next-action ${needsReceiptCheck ? 'needs-check' : ''}`}><b>{busy ? nextStep.status === 'signing' ? `第 ${confirmed + 1} 笔：请在钱包确认 ${nextStep.label}` : nextStep.status === 'submitted' ? `第 ${confirmed + 1} 笔：等待链上确认` : `${busy} · 第 ${confirmed + 1} 笔 ${nextStep.label}` : needsReceiptCheck ? `第 ${confirmed + 1} 笔需要先核对链上结果` : `下一笔：${nextStep.label}`}</b><span>{needsReceiptCheck ? '不会自动重发结果不明的交易。' : busy ? '请保持页面打开；中断后可从服务器记录继续。' : '点击“核对并继续部署”从此步骤继续。'}</span></div>}<ol className="transaction-list">{snapshot.steps.map((step, index) => <li key={index} className={`tx-${step.status}`}><span className="tx-icon">{step.status === 'confirmed' ? <Check size={15}/> : ['submitted', 'signing'].includes(step.status) && !!busy ? <LoaderCircle className="spin" size={15}/> : index + 1}</span><div><b>{step.label}</b><small>{step.status === 'confirmed' ? '已确认' : step.status === 'submitted' ? step.receipt?.status === 1 ? '已上链，待完成部署核验' : '已广播，等待确认' : step.status === 'signing' ? '等待钱包签名；若页面已中断请先核对交易' : step.status === 'cancelled' ? '钱包取消已最终确认，旧部署终止' : step.status === 'replaced' ? '钱包替换已最终确认，旧部署终止' : step.status === 'failed' ? '链上失败，禁止自动重发' : step.status === 'rejected' ? step.rejectionKind === 'pre-send' ? '发送前已停止，可继续' : '签名已取消，可继续' : step.status === 'uncertain' ? '发送结果不明，禁止重发' : '待处理'}</small></div>{step.txHash && <a href={`${EXPLORER}/tx/${step.txHash}`} target="_blank" rel="noreferrer" title={step.txHash}><span>{short(step.txHash)}</span><ArrowUpRight size={14}/></a>}{step.replacementHash && step.replacementHash !== step.txHash && <a href={`${EXPLORER}/tx/${step.replacementHash}`} target="_blank" rel="noreferrer" title={step.replacementHash}>替换交易<ArrowUpRight size={14}/></a>}</li>)}</ol>{recoveryStep && <div className="budget-recovery"><label htmlFor="recovery-hash" className="field-label">核对 {recoveryStep.label} 的交易（nonce {recoveryStep.nonce}）</label><input id="recovery-hash" className="text-input mono" value={recoveryHash} placeholder="原交易、加速或取消交易的完整哈希" spellCheck={false} autoComplete="off" disabled={!!busy} onChange={event => setRecoveryHash(event.target.value)}/><button className="small-button" disabled={!!busy || !onBsc || !bundle || !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash.trim())} onClick={() => void recoverMinedTransaction()}><ShieldCheck size={14}/>只读核验并恢复</button>{invalidEnvelopeStep && <button className="small-button" disabled={!!busy || !onBsc || !bundle} onClick={() => void releaseInvalidEnvelope()}><ShieldCheck size={14}/>核对 nonce 并解除格式错误</button>}<p>原交易与同 nonce 加速、取消或替换均只读核验。同内容且执行成功可继续；取消、其他内容或链上失败最终确认后，旧部署终止并保存实际 Gas。不会自动重发。</p></div>}{aborted && <div className="budget-recovery"><p>此部署已终止。先前部署的合约地址和实际 Gas 保留在记录中；新部署需要重新支付后续 Gas。</p></div>}{complete && <div className="success-inline"><CheckCheck size={20}/><span>第一阶段合约部署已核验；请继续完成下方七笔权限激活。</span></div>}</>}
            </section>
          </div><aside className="right-column">
            <section className="architecture-card"><div className="architecture-top"><span className="gold-icon"><GitBranch size={19}/></span><span>为后续升级做好准备</span></div><h2>代码可升级。<br/><span>权限有边界。</span></h2><div className="governance-flow"><div><Wallet size={17}/><span>{IS_FRESH ? '指定硬件钱包' : '你的管理钱包'}</span><small>发起提案</small></div><i/><div><LockKeyhole size={17}/><span>时间锁</span><strong>48h</strong></div><i/><div className="flow-contracts"><span>Factory<small>UUPS</small></span><span>Market<small>UUPS</small></span><span>Vault<small>Beacon</small></span></div></div><p>单机与多机使用各自的 Beacon，<br/>升级只影响对应类型的关联池。</p><button onClick={() => setTab('governance')}>查看升级与权限<ArrowUpRight size={16}/></button></section>
            <section className="card deployment-summary"><h2>本次部署</h2><dl><div><dt>目标网络</dt><dd>BSC 主网</dd></div><div><dt>治理方式</dt><dd>{IS_FRESH ? '硬件钱包 + Authority + 48 小时时间锁' : '单钱包 + 时间锁'}</dd></div><div><dt>钱包确认</dt><dd>{total} 笔交易</dd></div><div><dt>业务资金转入</dt><dd>0.00000 BNB</dd></div><div><dt>Gas 总预算</dt><dd>{displayDecimal(snapshot?.input.maxGasBudgetBnb || budget || '')} BNB</dd></div>{snapshot && <div><dt>实际已花费</dt><dd>{displayUnits(snapshot.spentWei || '0')} BNB</dd></div>}</dl>
              {report && !snapshot && <div className="preflight-passed"><ShieldCheck size={17}/><span>链上配置检查通过</span></div>}
              {!wallet ? <button className="primary-button" onClick={requestConnection} disabled={!!busy}><Wallet size={18}/>连接钱包开始<ArrowRight size={18}/></button> : !onBsc ? <button className="primary-button" onClick={changeNetwork} disabled={!!busy}>切换至 BSC 主网<ArrowRight size={18}/></button> : snapshot ? aborted ? <><button className="primary-button" disabled={!!busy || !bundle} onClick={() => void archiveCurrent()}><FileClock size={18}/>保存旧记录并新建部署</button><button className="text-button" disabled={!!busy} onClick={exportRecord}><ArrowDownToLine size={14}/>导出旧记录 JSON</button></> : complete ? <><button className="primary-button" disabled={!!busy || !bundle} onClick={() => void exportManifest()}>{busy ? <LoaderCircle className="spin" size={18}/> : <ArrowDownToLine size={18}/>} {busy || '核验并导出合约清单'}</button><button className="text-button" disabled={!!busy} onClick={exportRecord}><ArrowDownToLine size={14}/>导出完整部署记录 JSON</button></> : <><button className="primary-button" disabled={!!busy || !bundle} onClick={() => void resume(needsReceiptCheck)}>{busy ? <LoaderCircle className="spin" size={18}/> : needsReceiptCheck ? <RefreshCw size={17}/> : <Play size={17}/>} {busy || (needsReceiptCheck ? '先核对链上回执' : '核对并继续部署')}</button>{!needsReceiptCheck && <button className="text-button" onClick={() => void resume(true)} disabled={!!busy}><RefreshCw size={14}/>只核对链上回执</button>}</> : <button className="primary-button" disabled={!canStart} onClick={() => report ? setConfirmation(true) : void checkConfig()}>{busy ? <LoaderCircle className="spin" size={18}/> : report ? <Rocket size={18}/> : <ShieldCheck size={18}/>} {busy || (report ? '开始一键部署' : '检查部署配置')}<ArrowRight size={18}/></button>}
              <ArchiveCompletedAction snapshot={snapshot} busy={!!busy} journalReady={!!journal}
                onBsc={onBsc} onArchive={() => void archiveCurrent()}/>
              <p className="signer-note"><LockKeyhole size={12}/>签名始终在你的钱包中完成</p></section>
            <div className="risk-note"><OctagonAlert size={17}/><p>{IS_FRESH ? '这是主网操作，会消耗真实 BNB。第一阶段角色由指定硬件钱包临时持有；完成第二阶段权限激活前，不开放新站建池。' : '这是主网操作，会消耗真实 BNB。单钱包私钥持有人拥有升级权，请先用小额资产验证完整业务流程。'}</p></div>
          </aside></div>
          <FreshActivationPanel wallet={selected?.provider || null} account={wallet?.address || null}
            chainId={wallet?.chainId || null} bundle={bundle} journal={journal} genesis={complete ? snapshot : null}/>
        </>}

        {tab === 'pricing' && PricingPanel && <Suspense fallback={<section className="card records-card">正在加载矿机报价…</section>}><PricingPanel onSavePlan={journal ? record => journal.saveQuote(record) : undefined}/></Suspense>}
        {tab === 'market' && MarketPage && <Suspense fallback={<section className="card records-card">正在加载份额市场…</section>}><MarketPage wallet={selected?.provider || null} account={wallet?.address || null} journal={journal?.marketStorage() ?? null} factoryAddress={latestCompleted?.addresses.factory} onConnect={() => void requestConnection()}/></Suspense>}
        {tab === 'records' && <section className="card records-card"><div className="card-heading"><div><FileClock size={21}/><h2>部署记录</h2></div>{snapshot && <div className="record-actions"><button className="small-button" onClick={exportRecord}><ArrowDownToLine size={16}/>导出完整记录</button>{complete && <button className="small-button" disabled={!bundle || !!busy || !onBsc} onClick={() => void exportManifest()}><ArrowDownToLine size={16}/>核验并导出合约清单</button>}</div>}</div>{!snapshot ? <div className="large-empty"><FileClock size={36}/><h2>{archives.length ? '当前没有进行中的部署' : '还没有部署记录'}</h2><p>{wallet ? archives.length ? '历史部署记录见下方。' : '开始部署后，交易记录会保存在服务器。' : '连接钱包后读取该钱包在服务器保存的记录。'}</p><button className="small-button" onClick={() => setTab('deploy')}>前往合约部署<ArrowRight size={16}/></button></div> : <div className="records-body"><div className="record-meta"><span className={complete ? 'status-success' : 'status-pending'}>{complete ? '已完成核验' : '部署未完成'}</span><span>{new Date(snapshot.createdAt).toLocaleString('zh-CN')}</span><span>Chain ID 56</span><Address value={snapshot.account}/></div><div className="address-table">{Object.entries(snapshot.addresses).map(([name, value]) => <div key={name}><b>{name}</b><Address value={value}/></div>)}</div>{!Object.keys(snapshot.addresses).length && <p>暂未确认合约地址。请回到部署页核对交易回执。</p>}<details className="record-json"><summary>完整部署记录与核验结果<ChevronDown size={16}/></summary><pre>{JSON.stringify(snapshot, null, 2)}</pre></details><p className="field-help">完整记录保存在服务器，并按钱包隔离。建议另行导出备份，以便核对交易及后续升级。</p></div>}</section>}

        {tab === 'records' && archives.length > 0 && <section className="card records-card">
          <div className="card-heading"><div><FileClock size={21}/><h2>历史部署</h2></div></div>
          <div className="records-body"><div className="address-table">{archives.map(item => <div key={item.id}>
            <b>{new Date(item.createdAt).toLocaleString('zh-CN')} · {item.status === 'complete' ? '已完成' : '已终止'}</b>
            <Address value={item.account}/><span>已花费 {displayUnits(item.spentWei)} BNB</span>
            <button className="small-button" onClick={() => download(`pinkuang-bsc-${item.status}-${item.id}.json`, item)}><ArrowDownToLine size={14}/>导出记录</button>
            {item.status === 'complete' && <button className="small-button" disabled={!bundle || !!busy || !onBsc} onClick={() => void exportManifest(item)}><ArrowDownToLine size={14}/>核验并导出合约清单</button>}
          </div>)}</div>{archiveCursor && <button className="small-button" disabled={!!busy} onClick={() => void loadMoreArchives()}>{busy || '读取更早部署'}<ArrowRight size={14}/></button>}<p className="field-help">每次部署的交易哈希、合约地址和实际 Gas 均留在服务器。清单导出前会重新核对当前链上合约；前端接入时仍须按链复核。</p></div>
        </section>}
        {tab === 'governance' && (UpgradeConsole ? <Suspense fallback={<section className="card records-card">正在加载治理页面…</section>}>
          <UpgradeConsole wallet={selected?.provider || null} account={wallet?.address || null}
            chainId={wallet?.chainId || null} currentBundle={bundle} currentRecord={latestCompleted}
            onConnect={() => void requestConnection()}/></Suspense>
          : <section className="card records-card"><div className="records-body"><h2>新合约治理</h2>
            <p>第一阶段部署后，在部署页逐笔完成平台权限激活。两套 Factory 的所有权随后交给 48 小时时间锁；硬件钱包保留提案和取消权限。新版本不提供旧版合约升级签名入口。</p>
            <button className="small-button" onClick={() => setTab('deploy')}>查看新部署与权限激活<ArrowRight size={14}/></button>
          </div></section>)}
        <footer className="page-footer"><span><span className="tiny-brand">◆</span>拼矿协议<span className="footer-divider">/</span>部署工作台</span>{bundle && <a href={`https://github.com/jianfengliao774-sketch/pinkuang/blob/${bundle.sourceCommit}/deploy/README.md`} target="_blank" rel="noreferrer">构建时部署说明<ExternalLink size={13}/></a>}</footer>
      </main>
    </div>
    {walletDialog && <div className="modal-backdrop" onClick={() => setWalletDialog(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="wallet-title" onClick={event => event.stopPropagation()}><button autoFocus className="icon-button modal-close" aria-label="关闭钱包选择" onClick={() => setWalletDialog(false)}><X size={20}/></button><span className="modal-emblem"><Wallet size={25}/></span><h2 id="wallet-title">连接你的钱包</h2>{wallets.length ? <div className="wallet-options">{wallets.map(option => <button key={option.id} disabled={qrPending} onClick={() => void connect(option)}><Wallet size={21}/>{option.name}<ArrowRight size={18}/></button>)}</div> : <><p>{IS_FRESH ? '当前浏览器未检测到钱包。请在已安装 MetaMask 等钱包扩展的 Chrome、Edge，或钱包内置浏览器中打开此页面。' : '当前浏览器未检测到钱包。请在已安装 OneKey 扩展的 Chrome、Edge，或钱包内置浏览器中打开此页面。'}</p><p className="muted">{IS_FRESH ? '在 Codex 内预览时，可以先查看页面，再复制页面地址到安装了 MetaMask 等钱包扩展的浏览器。' : '在 Codex 内预览时，可以先查看页面，再复制页面地址到安装了 OneKey 的浏览器。'}</p></>}<button className="small-button" type="button" onClick={() => setWalletScan(value => value + 1)}><RefreshCw size={15}/>重新检测扩展钱包</button><WalletQrChoice onConnect={connect} onPending={setQrPending}/><p className="modal-note">连接后会要求一次无 Gas 签名，用于读取你在服务器保存的操作记录；不收集私钥或助记词。</p></section></div>}
    {confirmation && <div className="modal-backdrop"><section className="modal confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title"><button autoFocus className="icon-button modal-close" aria-label="返回检查配置" onClick={() => setConfirmation(false)}><X size={20}/></button><span className="modal-emblem"><Rocket size={25}/></span><h2 id="confirm-title">准备部署到 BSC 主网</h2><p>将依次请求 {INTEGRATED_TRANSACTION_COUNT} 笔交易签名，仅支付 Gas。请保持页面打开，并逐笔核对钱包中的网络和交易内容。</p><div className="confirm-summary"><div><span>{IS_FRESH ? '第一阶段硬件钱包' : '管理钱包'}</span><b>{short(activeInput.ownerMultisig)}</b></div><div><span>Gas 总预算</span><b>{budget} BNB</b></div><div><span>升级等待</span><b>至少 48 小时</b></div></div><label className="acknowledgment"><input type="checkbox" checked={governanceReviewed} onChange={e => setGovernanceReviewed(e.target.checked)}/><span>{IS_FRESH ? '我已核对第一阶段硬件钱包的临时角色，以及第二阶段 Authority、时间锁、管理员和 Gas 钱包的地址安排。' : '我已核对管理、运营和金库地址，理解单钱包拥有升级权及私钥保管责任。'}</span></label><label className="acknowledgment"><input type="checkbox" checked={protocolReviewed} onChange={e => setProtocolReviewed(e.target.checked)}/><span>我已核对协议地址与代码，理解这是消耗真实 BNB 的{IS_FRESH ? '主网部署' : '主网测试'}，部署检查不等同于安全审计。</span></label><button className="primary-button" disabled={!governanceReviewed || !protocolReviewed || !!busy} onClick={() => void deploy()}>开始部署，在钱包中确认<ArrowRight size={18}/></button><button className="text-button" onClick={() => setConfirmation(false)}>返回检查配置</button></section></div>}
  </div>;
}
