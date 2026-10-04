import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Contract, JsonRpcProvider, getAddress, keccak256 } from 'ethers';
// The reviewed helpers are deliberately shared with the read-only product graph verifier.
// @ts-ignore ESM helper has runtime validation; this standalone entry supplies pinned JSON only.
import { buildTargetOwnerUpgradePlan, prepareTargetOwnerUpgradeDeployment, validateTargetOwnerUpgradeReview } from '../shared/target-owner-upgrade-plan.mjs';
// @ts-ignore ESM proof module is reviewed and tested independently of this wallet UI.
import { validateTargetOwnerUpgradePreflight } from '../shared/target-owner-upgrade-proof.mjs';
import { discoverWallets, messageOf, readWallet, switchToBsc, type WalletOption, type WalletState } from './wallet';
import { TARGET_OWNER_DEPLOYMENTS, confirmedTargetOwnerDeployments, newTargetOwnerJournal, parseTargetOwnerJournal,
  targetOwnerActionReady, targetOwnerJournalKey, targetOwnerNext, targetOwnerPending, submitTargetOwnerUpgrade, targetOwnerReviewedGas,
  verifyTargetOwnerRecoveryReceipt, VerifiedTargetOwnerTransactionFailure, archiveTargetOwnerFailure,
  type TargetOwnerJournal, type TargetOwnerName, type UpgradeTransaction } from './target-owner-upgrade-ui';
import './target-owner-upgrade.css';

type Json = Record<string, any>;
type Release = { kind: string; sourceCommit: string; sourceDiffDigest: string; candidateSourceCommit: string;
  pins: Record<string, string>; files: Record<string, { path: string; sha256: string }>; rpcPath: string; gasEvidenceDigest: string;
  liveReviewEvidenceDigest: string; liveReviewAnchor: { blockNumber: number; blockHash: string; checkedAt: string } };
declare const __TARGET_OWNER_RELEASE__: Release;
type Operation = 'unknown' | 'unscheduled' | 'waiting' | 'ready' | 'done';
type Preflight = { blockNumber: number; blockHash: string; [name: string]: any };
const release = __TARGET_OWNER_RELEASE__;
const names: Record<TargetOwnerName, string> = { PoolFunds: '资金结算库', FlexiblePurchase: '购机库', PoolVault: '矿池实现' };
const explorer = 'https://bscscan.com';
const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;
const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const json = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([json(value)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function newSalt() { const bytes = crypto.getRandomValues(new Uint8Array(32)); if (bytes.every(value => value === 0)) bytes[31] = 1;
  return `0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`; }
function rpc() { return new JsonRpcProvider(new URL(release.rpcPath, window.location.href).href, 56,
  { batchMaxCount: 1, cacheTimeout: -1 }); }
async function pinnedJson(name: string, signal: AbortSignal): Promise<Json> {
  const file = release.files[name]; if (!file) throw new Error(`发布包缺少已审查文件 ${name}。`);
  const response = await fetch(new URL(file.path, window.location.href), { signal, cache: 'no-store', redirect: 'error', credentials: 'same-origin' });
  if (!response.ok || !/\bapplication\/json\b/i.test(response.headers.get('content-type') || '')) throw new Error(`无法加载已审查文件 ${name}。`);
  const bytes = await response.arrayBuffer(); if (!bytes.byteLength || bytes.byteLength > 12_000_000 || !crypto.subtle) throw new Error('文件大小或安全上下文不允许核验。');
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== file.sha256) throw new Error(`文件 ${name} 与固定发布摘要不同。`);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function TargetOwnerUpgradeStandalone() {
  const [common, setCommon] = useState<Json | null>(null), [loadError, setLoadError] = useState('');
  const [gasLimits, setGasLimits] = useState<Record<TargetOwnerName, string> | null>(null);
  const [wallets, setWallets] = useState<WalletOption[]>([]), [wallet, setWallet] = useState<WalletOption | null>(null);
  const [walletState, setWalletState] = useState<WalletState | null>(null), [journal, setJournal] = useState<TargetOwnerJournal | null>(null);
  const [proof, setProof] = useState<Preflight | null>(null), [result, setResult] = useState<Preflight | null>(null);
  const [operation, setOperation] = useState<Operation>('unknown'), [readyAt, setReadyAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [recoveryHash, setRecoveryHash] = useState(''), [reviewed, setReviewed] = useState(false);
  const busyRef = useRef(false);
  const context = useMemo(() => common ? { factory: common.genesisRecord.addresses.factory,
    genesisRecordDigest: release.pins.trustedGenesisRecordDigest, genesisManifestDigest: release.pins.trustedGenesisManifestDigest,
    candidateArtifactDigest: release.pins.trustedUpgradeArtifactDigest, catalogDigest: release.pins.trustedReviewCatalogDigest } : null, [common]);
  const key = context ? targetOwnerJournalKey(context) : null;
  const account = walletState?.address, onBsc = !!wallet && !!account && walletState?.chainId === 56;
  const reviewedCatalog = common?.reviewCatalog;
  const deployer = reviewedCatalog?.deployer as string | undefined, proposer = reviewedCatalog?.bindings?.proposer as string | undefined;
  const pending = journal ? targetOwnerPending(journal) : null, nextName = journal ? targetOwnerNext(journal) : null;
  const completed = journal ? Object.keys(confirmedTargetOwnerDeployments(journal)).length : 0;
  const plan = useMemo(() => {
    if (!common || !journal || completed !== 3) return null;
    try { return buildTargetOwnerUpgradePlan({ ...common, replacements: Object.fromEntries(Object.entries(confirmedTargetOwnerDeployments(journal))
      .map(([name, item]) => [name, item.address])), salt: journal.salt, delaySeconds: journal.delaySeconds }); }
    catch (problem) { return { invalid: messageOf(problem) }; }
  }, [common, journal, completed]);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all(['genesisRecord', 'genesisBundle', 'trustedGenesisManifest', 'upgradeBundle', 'reviewCatalog', 'gasEvidence', 'liveReview'].map(name => pinnedJson(name, controller.signal)))
      .then(values => {
        const input = Object.fromEntries(['genesisRecord', 'genesisBundle', 'trustedGenesisManifest', 'upgradeBundle', 'reviewCatalog'].map((name, index) => [name, values[index]]));
        const reviewed: Json = { ...input, ...release.pins };
        validateTargetOwnerUpgradeReview(reviewed);
        if (reviewed.reviewCatalog.profile !== 'formal') throw new Error('此页面只接受正式部署图。');
        const gas = targetOwnerReviewedGas(values[5], release.pins, release.gasEvidenceDigest);
        if (!controller.signal.aborted) { setGasLimits(gas); setCommon(reviewed); }
      }).catch(problem => { if (!controller.signal.aborted) setLoadError(messageOf(problem)); });
    return () => controller.abort();
  }, []);
  useEffect(() => discoverWallets(setWallets), []);
  useEffect(() => {
    if (!wallet) return; let active = true;
    const changed = () => { setProof(null); setReviewed(false); void readWallet(wallet.provider).then(value => {
      if (active) setWalletState(value ? { ...value, address: getAddress(value.address) } : null);
    }).catch(problem => { if (active) { setWalletState(null); setError(messageOf(problem)); } }); };
    const disconnected = () => { if (active) { setWalletState(null); setProof(null); setReviewed(false); } };
    wallet.provider.on?.('accountsChanged', changed); wallet.provider.on?.('chainChanged', changed); wallet.provider.on?.('disconnect', disconnected);
    return () => { active = false; wallet.provider.removeListener?.('accountsChanged', changed);
      wallet.provider.removeListener?.('chainChanged', changed); wallet.provider.removeListener?.('disconnect', disconnected); };
  }, [wallet]);
  useEffect(() => {
    if (!key || !context) return;
    const restore = () => { try { const raw = localStorage.getItem(key); setJournal(raw ? parseTargetOwnerJournal(JSON.parse(raw), context) : null);
      setProof(null); setResult(null); setOperation('unknown'); setReviewed(false); }
    catch (problem) { setError(messageOf(problem)); } };
    restore(); const storage = (event: StorageEvent) => { if (event.key === key) restore(); };
    window.addEventListener('storage', storage); return () => window.removeEventListener('storage', storage);
  }, [key]);
  function save(item: TargetOwnerJournal) {
    if (!context || !key) throw new Error('固定发布证据尚未加载。');
    const checked = parseTargetOwnerJournal(item, context); localStorage.setItem(key, JSON.stringify(checked)); setJournal(checked); setProof(null); setReviewed(false);
  }
  async function run(label: string, action: () => Promise<void>) {
    if (busyRef.current) return; busyRef.current = true; setBusy(label); setError(''); setMessage('');
    try { await action(); } catch (problem) { setError(messageOf(problem)); } finally { busyRef.current = false; setBusy(''); }
  }
  async function exclusive(source: TargetOwnerJournal, action: () => Promise<void>) {
    if (!key || !navigator.locks) throw new Error('浏览器需要支持跨标签交易记录锁。请使用最新 Chrome、Edge 或 Safari。');
    await navigator.locks.request(key, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) throw new Error('另一标签正在处理本次升级，请先核对原交易。');
      if (localStorage.getItem(key) !== JSON.stringify(source)) throw new Error('本机记录已变化，请刷新后继续。');
      await action();
    });
  }
  async function operationState(provider: JsonRpcProvider, currentPlan: Json) {
    const block = await provider.getBlock('finalized'); if (!block?.hash) throw new Error('无法读取最终确认区块。');
    const chain = await provider.send('eth_chainId', []); if (BigInt(chain) !== 56n) throw new Error('只读节点不属于 BSC 主网。');
    const lock = new Contract(currentPlan.timelock, ['function getTimestamp(bytes32) view returns(uint256)'], provider);
    const timestamp = await lock.getTimestamp(currentPlan.operationId, { blockTag: block.number }) as bigint;
    const canonical = await provider.getBlock(block.number);
    if (!canonical?.hash || !same(canonical.hash, block.hash)) throw new Error('最终确认区块已变化。');
    return { operation: (timestamp === 0n ? 'unscheduled' : timestamp === 1n ? 'done'
      : timestamp <= BigInt(block.timestamp) ? 'ready' : 'waiting') as Operation,
    readyAt: timestamp > 1n ? Number(timestamp) : null, snapshot: block };
  }
  function planFor(source: TargetOwnerJournal) {
    const deployments = confirmedTargetOwnerDeployments(source);
    return Object.keys(deployments).length === 3 ? buildTargetOwnerUpgradePlan({ ...common,
      replacements: Object.fromEntries(Object.entries(deployments).map(([name, item]) => [name, item.address])),
      salt: source.salt, delaySeconds: source.delaySeconds }) : null;
  }
  async function preflight(source: TargetOwnerJournal | null, force?: 'prepared' | 'unscheduled' | 'scheduled' | 'done') {
    if (!common) throw new Error('已审查发布文件尚未加载。');
    const provider = rpc(), currentPlan = source ? planFor(source) : null;
    // Imported failure rows are claims too. Re-prove status0 before they can clear a retry gate.
    for (const failed of source?.failedTransactions ?? []) {
      const governance = failed.step === 'schedule' || failed.step === 'execute';
      const prior = source ? Object.fromEntries(TARGET_OWNER_DEPLOYMENTS.slice(0, TARGET_OWNER_DEPLOYMENTS.indexOf(failed.step as TargetOwnerName))
        .filter(name => source.deployments[name]?.status === 'confirmed').map(name => [name, source.deployments[name]!.address!])) : {};
      const data = governance ? currentPlan?.[`${failed.step}Data`]
        : prepareTargetOwnerUpgradeDeployment(failed.step, common, { deploymentsPrefix: prior }).data;
      if (!data || !same(keccak256(data), failed.transaction.dataHash)
        || !same(failed.transaction.from, governance ? proposer : deployer)) throw new Error('归档失败交易与本次固定步骤不符。');
      try {
        await verifyTargetOwnerRecoveryReceipt(provider, failed.evidence.txHash, { from: failed.transaction.from,
          dataHash: failed.transaction.dataHash, ...(governance ? { to: currentPlan.timelock } : {}) });
        throw new Error('归档交易没有已验证的最终失败回执。');
      } catch (problem) {
        if (!(problem instanceof VerifiedTargetOwnerTransactionFailure)) throw problem;
        if (!same(problem.evidence.blockHash, failed.evidence.blockHash) || problem.evidence.blockNumber !== failed.evidence.blockNumber)
          throw new Error('失败归档的规范区块已变化。');
      }
    }
    const currentState = currentPlan && force !== 'prepared' ? await operationState(provider, currentPlan)
      : { operation: 'unknown' as Operation, readyAt: null, snapshot: undefined };
    const phase = force || (currentState.operation === 'done' ? 'done'
      : ['waiting', 'ready'].includes(currentState.operation) ? 'scheduled' : currentPlan ? 'unscheduled' : 'prepared');
    setBusy(phase === 'done' ? '核验原 Beacon、候选代码与五笔最终回执'
      : '核验原部署图、Authority 角色和已确认候选回执');
    const checked = await validateTargetOwnerUpgradePreflight(provider, common, { phase,
      ...(currentState.snapshot ? { snapshot: currentState.snapshot } : {}),
      deployments: source ? confirmedTargetOwnerDeployments(source) : {}, ...(currentPlan ? { plan: currentPlan } : {}),
      ...(source?.schedule?.txHash ? { scheduleTxHash: source.schedule.txHash } : {}),
      ...(source?.execute?.txHash ? { executeTxHash: source.execute.txHash } : {}) });
    const state = { operation: (checked.operation || currentState.operation) as Operation,
      readyAt: checked.readyAt ?? currentState.readyAt };
    setProof(checked); setOperation(state.operation); setReadyAt(state.readyAt);
    if (phase === 'done') setResult(checked);
    return { checked, ...state };
  }
  async function connect(option: WalletOption) { await run('连接钱包', async () => {
    await option.provider.request({ method: 'eth_requestAccounts' }); const state = await readWallet(option.provider);
    if (!state) throw new Error('钱包没有提供账户。'); setWallet(option); setWalletState({ ...state, address: getAddress(state.address) });
  }); }
  async function refresh() { await run('只读核验正式图与本次回执', async () => {
    const checked = await preflight(journal); setMessage(`已在最终确认区块 #${checked.checked.blockNumber} 核对。每次钱包提交前会重新检查。`);
  }); }
  function createBatch() {
    if (!context || !key || !proof || journal) return;
    try { if (localStorage.getItem(key)) throw new Error('本机已有升级记录，请刷新并恢复。');
      save(newTargetOwnerJournal(context, newSalt())); setMessage('已保存本次唯一 salt；断线后从本机记录继续。'); }
    catch (problem) { setError(messageOf(problem)); }
  }
  function allowed(action: 'deploy' | 'schedule' | 'execute') {
    return !!journal && targetOwnerActionReady({ action, onBsc, signerAuthorized: same(account, action === 'deploy' ? deployer : proposer),
      pending: !!pending, graphVerified: !!proof, prefixVerified: !!proof, completedDeployments: completed,
      operation, scheduleConfirmed: journal.schedule?.status === 'confirmed' });
  }
  async function deploy(name: TargetOwnerName) { await run(`部署 ${name}`, async () => {
    if (!common || !gasLimits || !journal || !wallet || !account || !allowed('deploy') || nextName !== name) throw new Error('请先核验正式图、连接指定部署钱包并核对上一笔回执。');
    const source = journal, prefix = confirmedTargetOwnerDeployments(source);
    await exclusive(source, async () => {
      await preflight(source, 'prepared');
      const prepared = prepareTargetOwnerUpgradeDeployment(name, common, { deploymentsPrefix: prefix });
      const transaction: UpgradeTransaction = { status: 'uncertain', from: account, dataHash: keccak256(prepared.data) };
      await submitTargetOwnerUpgrade(wallet.provider, { from: account, data: prepared.data, gasLimit: gasLimits[name] }, {
        beforeRequest: () => save({ ...source, deployments: { ...source.deployments, [name]: transaction } }),
        definitelyRejected: () => save(source),
        submitted: hash => save({ ...source, deployments: { ...source.deployments, [name]: { ...transaction, status: 'submitted', txHash: hash } } }),
      });
      setMessage(`${name} 已提交。最终回执与精确运行代码验证后才能部署下一项。`);
    });
  }); }
  async function recover() { await run('核验原交易回执', async () => {
    if (!common || !context || !journal || !pending) throw new Error('没有待恢复的原交易。');
    const source = journal, name = pending;
    const transaction = name === 'schedule' || name === 'execute' ? source[name]! : source.deployments[name]!;
    if (!same(transaction.from, name === 'schedule' || name === 'execute' ? proposer : deployer)) throw new Error('原交易发送者与本页固定的钱包角色不同。');
    const hash = transaction.txHash || recoveryHash.trim(), currentPlan = planFor(source);
    const data = name === 'schedule' || name === 'execute' ? currentPlan?.[`${name}Data`]
      : prepareTargetOwnerUpgradeDeployment(name, common, { deploymentsPrefix: confirmedTargetOwnerDeployments(source) }).data;
    if (!data || !same(keccak256(data), transaction.dataHash)) throw new Error('本机记录与固定候选操作不一致。');
    await exclusive(source, async () => {
      let receipt;
      try { receipt = await verifyTargetOwnerRecoveryReceipt(rpc(), hash, { from: transaction.from, dataHash: transaction.dataHash,
        ...((name === 'schedule' || name === 'execute') ? { to: currentPlan.timelock } : {}) }); }
      catch (problem) {
        if (!(problem instanceof VerifiedTargetOwnerTransactionFailure)) throw problem;
        save(archiveTargetOwnerFailure(source, name, problem.evidence, context)); setOperation('unknown'); setRecoveryHash('');
        setMessage('原交易已最终失败，匹配的规范回执已归档。请只读核验当前状态后重试同一步；失败证据会保留在导出记录中。'); return;
      }
      if (!receipt) { setMessage('原交易尚未最终确认。保留记录，稍后继续核验。'); return; }
      const confirmed: UpgradeTransaction = { ...transaction, txHash: hash, status: 'confirmed',
        ...((name === 'schedule' || name === 'execute') ? {} : { address: getAddress(receipt.contractAddress!) }) };
      const candidate = name === 'schedule' || name === 'execute' ? { ...source, [name]: confirmed }
        : { ...source, deployments: { ...source.deployments, [name]: confirmed } };
      await preflight(candidate, name === 'schedule' ? 'scheduled' : name === 'execute' ? 'done' : 'prepared');
      save(candidate); setRecoveryHash('');
      setMessage(name === 'execute' ? '原 Beacon 升级及全部回执已验证。旧池历史 owner 迁移仍是另一步。'
        : name === 'schedule' ? '排程回执已确认，48 小时从链上排程区块开始计算。'
          : `${name} 部署及运行代码、依赖绑定已验证。请再次只读核验后继续。`);
    });
  }); }
  async function governance(which: 'schedule' | 'execute') { await run(which === 'schedule' ? '提交 48 小时排程' : '执行原 Beacon 升级', async () => {
    if (!journal || !wallet || !account || !reviewed || !allowed(which) || journal[which] || !plan || plan.invalid) throw new Error('钱包、已核验状态或本次升级批次尚未就绪。');
    const source = journal, currentPlan = planFor(source);
    await exclusive(source, async () => {
      const checked = await preflight(source, which === 'schedule' ? 'unscheduled' : 'scheduled');
      if (checked.operation !== (which === 'schedule' ? 'unscheduled' : 'ready')) throw new Error('链上排程状态已变化，请重新核验。');
      const data = currentPlan[`${which}Data`], transaction: UpgradeTransaction = { status: 'uncertain', from: account, dataHash: keccak256(data) };
      await submitTargetOwnerUpgrade(wallet.provider, { from: account, to: currentPlan.timelock, data }, {
        beforeRequest: () => save({ ...source, [which]: transaction }), definitelyRejected: () => save(source),
        submitted: hash => save({ ...source, [which]: { ...transaction, status: 'submitted', txHash: hash } }),
      });
      setMessage(which === 'schedule' ? '排程已提交，等待原交易最终回执。' : '执行已提交，验证 Beacon 当前指针后才会显示激活。');
    });
  }); }
  async function importJournal(file: File) { await run('恢复升级记录', async () => {
    if (!context || !key || file.size > 100_000) throw new Error('记录大小或本页证据未就绪。');
    const value = JSON.parse(await file.text()), imported = parseTargetOwnerJournal(value.journal || value, context);
    if (localStorage.getItem(key)) throw new Error('本机已有记录，不能用导入覆盖。请先导出并核对现有记录。');
    await preflight(imported); save(imported); setMessage('记录已恢复；签名前会重新读取原交易和运行代码。');
  }); }
  function exportRecord() { if (!journal) return; download('bemine-target-owner-upgrade-record.json', {
    schemaVersion: 1, kind: 'fixed-target-owner-upgrade-wallet-record-v1', exportedAt: new Date().toISOString(),
    release, journal, plan: plan?.invalid ? null : plan, preflight: proof, postUpgradeProof: result,
    deploymentComplete: completed === 3, activated: !!result && operation === 'done',
    legacyPoolOwnerMigrationComplete: false }); }

  const stateLabel = result && operation === 'done' ? 'Beacon 激活已验证' : pending ? '原交易待核验'
    : operation === 'waiting' ? '已排程 · 48 小时等待中' : operation === 'ready' ? '等待期结束 · 可执行'
      : completed === 3 ? '部署完成 · 尚未激活' : '候选合约尚未激活';
  return <main className="to-shell">
    <div className="to-top"><span className="to-mark">BEMINE / 合约升级</span><span className="to-status">BSC 主网 · 56</span></div>
    <h1>固定目标所有者保护</h1>
    <p className="to-lead">为固定目标矿池增加 owner 变化检查。按顺序部署三个候选合约，再由原 Timelock 排程原 Beacon 升级；48 小时后单独确认执行。</p>
    <div className={`to-note ${operation === 'waiting' ? 'to-wait' : result && operation === 'done' ? 'to-success' : ''}`}>
      <div className="to-state" data-testid="activation-state">{stateLabel}</div>
      {readyAt && <div>最早执行时间：{new Date(readyAt * 1000).toLocaleString('zh-CN')}（以最终确认区块时间为准）</div>}
    </div>
    {(loadError || error) && <p role="alert" className="to-note to-error">{loadError || error}</p>}
    {message && <p role="status" className="to-note">{message}</p>}{busy && <p role="status" className="to-busy">{busy}…</p>}
    <section className="to-card"><h2>1. 核对正式部署与钱包</h2>
      <div className="to-grid"><div><p className="to-small">每次提交前重新读取最终确认区块、原图运行代码、Authority 角色和已部署候选回执。</p>
        <button disabled={!!busy || !common} onClick={refresh}>只读核验</button>
        {proof && <p className="to-small">已核验区块 #{proof.blockNumber}<br/><code>{proof.blockHash}</code></p>}
      </div><div><p className="to-small">钱包：{account ? short(account) : '未连接'}{walletState ? ` · ${walletState.chainId === 56 ? 'BSC 主网' : '请切换 BSC'}` : ''}</p>
        <div className="to-actions">{wallets.map(option => <button key={option.id} disabled={!!busy} onClick={() => connect(option)}>{option.name}</button>)}
          {!wallets.length && <span className="to-small">安装并解锁 OneKey 或浏览器钱包后刷新。</span>}
          {wallet && !onBsc && <button disabled={!!busy} onClick={() => run('切换 BSC 主网', () => switchToBsc(wallet.provider))}>切换 BSC</button>}</div>
      </div></div>
      <p className="to-small">发布前已独立只读核验区块 #{release.liveReviewAnchor.blockNumber}。此报告不代替本次提交前核验。
        <a href={release.files.liveReview.path} target="_blank" rel="noreferrer"> 查看只读证据</a></p>
      {common && <dl className="to-meta"><dt>原 Factory</dt><dd><code>{context?.factory}</code></dd><dt>原 Beacon</dt><dd><code>{reviewedCatalog?.bindings?.beacon}</code></dd>
        <dt>原 Timelock</dt><dd><code>{reviewedCatalog?.bindings?.timelock}</code></dd><dt>指定部署钱包</dt><dd className="to-role"><code>{deployer}</code></dd>
        <dt>原排程 / 执行钱包</dt><dd className="to-role"><code>{proposer}</code></dd><dt>候选摘要</dt><dd><code>{release.pins.trustedUpgradeArtifactDigest}</code></dd></dl>}
      <div className="to-actions"><button disabled={!!busy || !proof || !!journal} onClick={createBatch}>建立本次升级记录</button>
        <button disabled={!journal || !!busy} onClick={exportRecord}>导出升级记录</button>
        <label className="to-import">导入恢复记录<input type="file" accept="application/json,.json" disabled={!!busy || !!journal || !common}
          onChange={event => { const file = event.target.files?.[0]; if (file) void importJournal(file); event.target.value = ''; }}/></label></div>
      {journal && <p className="to-small">本机记录已保存。关闭页面、断线或取消钱包都不会自动重复提交。<br/>本次 salt：<code>{journal.salt}</code></p>}
      {!!journal?.failedTransactions?.length && <p className="to-small">已归档 {journal.failedTransactions.length} 笔最终失败的原交易。失败证据随升级记录一起导出。</p>}
    </section>
    <section className="to-card"><h2>2. 部署三个候选合约</h2><p className="to-small">每项都需钱包单独确认；下一项只使用已验证的实际部署地址。PoolVault 构造参数固定为原 Factory。</p>
      {TARGET_OWNER_DEPLOYMENTS.map((name, index) => { const transaction = journal?.deployments[name]; return <div key={name} className={`to-row ${transaction?.status === 'confirmed' ? 'to-confirmed' : ''}`}>
        <span className="to-circle">{transaction?.status === 'confirmed' ? '✓' : index + 1}</span><div><h3>{name} · {names[name]}</h3>
          <small>{transaction?.status === 'confirmed' ? '运行代码与回执已验证' : transaction ? '已提交或发送结果待核验' : '尚未部署'}
            {gasLimits && ` · 固定 Gas 上限 ${Number(gasLimits[name]).toLocaleString('zh-CN')}`}</small>
          {transaction?.address && <div><code>{transaction.address}</code></div>}
          {transaction?.txHash && <a className="to-hash to-small" href={`${explorer}/tx/${transaction.txHash}`} target="_blank" rel="noreferrer">查看原交易 {short(transaction.txHash)}</a>}
        </div><button disabled={!!busy || nextName !== name || !allowed('deploy')} onClick={() => deploy(name)}>部署 {name}</button></div>; })}
    </section>
    {pending && <section className="to-card"><h2>恢复原交易：{pending}</h2><p className="to-small">若钱包未返回哈希，从钱包交易记录复制原交易哈希。该步骤不会再次发送交易。</p>
      <div className="to-recover"><input aria-label="原交易哈希" placeholder="0x… 原交易哈希" value={recoveryHash} onChange={event => setRecoveryHash(event.target.value)} disabled={!!busy}/>
        <button disabled={!!busy || (!recoveryHash && !(pending === 'schedule' || pending === 'execute' ? journal?.[pending]?.txHash : journal?.deployments[pending]?.txHash))} onClick={recover}>只读核验原回执</button></div></section>}
    <section className="to-card"><h2>3. 排程，等待 48 小时，再执行</h2><p className="to-small">该提案只有一条调用：原 Beacon.upgradeTo(新 PoolVault)。三个候选部署完成后仍需排程和执行。</p>
      {plan?.invalid && <p role="alert">{plan.invalid}</p>}{plan && !plan.invalid && <dl className="to-meta"><dt>操作 ID</dt><dd><code>{plan.operationId}</code></dd><dt>延迟</dt><dd>{journal?.delaySeconds} 秒（至少 48 小时）</dd></dl>}
      <label className="to-check"><input type="checkbox" checked={reviewed} disabled={!proof || completed !== 3 || !!busy} onChange={event => setReviewed(event.target.checked)}/>
        我已核对正式图、候选摘要、原 Beacon 与本次操作 ID，并理解部署不等于激活。</label>
      <div className="to-actions"><button disabled={!!busy || !reviewed || !allowed('schedule') || !!journal?.schedule} onClick={() => governance('schedule')}>钱包确认 48 小时排程</button>
        <button disabled={!!busy || !reviewed || !allowed('execute') || !!journal?.execute} onClick={() => governance('execute')}>钱包确认执行升级</button></div>
      {journal?.schedule?.txHash && <p className="to-small"><a href={`${explorer}/tx/${journal.schedule.txHash}`} target="_blank" rel="noreferrer">排程原交易</a></p>}
      {journal?.execute?.txHash && <p className="to-small"><a href={`${explorer}/tx/${journal.execute.txHash}`} target="_blank" rel="noreferrer">执行原交易</a></p>}
    </section>
    <section className="to-card"><h2>旧固定池的历史 owner 迁移</h2><p>Beacon 激活后，旧池仍需独立迁移原始 owner。必须基于建池事件与建池时历史所有权证据，由当前两位管理员分别签署同一份授权。此页不会把当前 NFT owner 当作建池时 owner。</p>
      <p className="to-small">迁移签名与提交入口尚未包含在本页；升级记录会明确保留“旧池迁移未完成”。新建池会直接记录创建时的 owner。</p></section>
    <p className="to-footer">静态发布源码 {short(release.sourceCommit)} · 候选编译源码 {short(release.candidateSourceCommit)}。本次已核验图固定绑定记录、manifest、逐合约产物和候选摘要。</p>
  </main>;
}
createRoot(document.getElementById('root')!).render(<TargetOwnerUpgradeStandalone/>);
