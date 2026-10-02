'use client';
import { useEffect, useRef, useState } from 'react';
import { confirmUpgradeTransaction, executeUpgradeTransaction, readUpgradeStatus, scheduleUpgradeTransaction,
  reconcileUpgradeDeployments, submitUpgradeTransaction, upgradeDeployment, validateSaleUpgradeCatalog,
  verifyUpgradeDeploymentRuntime, readUpgradeWrapperRuntime } from '../lib/sale-policy-upgrade.mjs';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
const profile = process.env.NEXT_PUBLIC_BEMINE_PRODUCT_FAMILY === 'full-test' ? 'full-test' : 'formal';
const order = ['SaleGovernance', 'PoolVault', 'BudgetPortfolioVault', 'ShareMarket'];
const labels = { SaleGovernance: '出售规则', PoolVault: '单矿机规则', BudgetPortfolioVault: '多矿机规则', ShareMarket: '自动参考价入口', schedule: '提交升级', execute: '启用升级' };
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const hashPattern = /^0x[\da-f]{64}$/i;

export default function FreshSaleUpgradePanel() {
  const [catalog, setCatalog] = useState(null), [account, setAccount] = useState('');
  const [progress, setProgress] = useState(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [chainStatus, setChainStatus] = useState(null);
  const [recoveryHashes, setRecoveryHashes] = useState({});
  const live = useRef({}), provider = useRef(null), journal = useRef(null), lock = useRef(false);
  const life = useRef(null), networkEpoch = useRef(0);
  live.current = { catalog, account };

  useEffect(() => {
    const context = {}; life.current = context;
    const controller = new AbortController();
    fetch(`${basePath}/data/sale-policy-upgrade.${profile}.json`, { signal: controller.signal, cache: 'no-cache' })
      .then(response => { if (!response.ok) throw new Error('升级资料正在准备，请稍后刷新。'); return response.json(); })
      .then(value => { validateSaleUpgradeCatalog(value, { profile }); if (life.current === context) setCatalog(value); })
      .catch(problem => { if (!controller.signal.aborted && life.current === context) setError(problem.message); });
    provider.current = window.ethereum;
    const changed = accounts => { networkEpoch.current++; setAccount(accounts?.[0] || ''); setChainStatus(null); };
    const networkChanged = () => { networkEpoch.current++; setChainStatus(null); setNotice('网络已变化，进度已保存。'); };
    provider.current?.on?.('accountsChanged', changed); provider.current?.on?.('chainChanged', networkChanged);
    return () => { life.current = null; controller.abort(); provider.current?.removeListener?.('accountsChanged', changed); provider.current?.removeListener?.('chainChanged', networkChanged); };
  }, []);

  function key() { return `bemine.sale-upgrade.v1:${profile}:${catalog.bindings.factory.toLowerCase()}:${catalog.candidateArtifactDigest.toLowerCase()}:${account.toLowerCase()}`; }
  function save(next, destination = journal.current) {
    const storageKey = destination?.storageKey;
    if (!storageKey) throw new Error('升级进度保存失败，暂停操作。');
    window.localStorage.setItem(storageKey, JSON.stringify(next));
    destination.record = next;
    if (destination === journal.current) setProgress({ ...next });
  }
  useEffect(() => {
    if (!catalog || !account) { journal.current = null; setProgress(null); return; }
    const storageKey = key();
    try {
      const saved = JSON.parse(window.localStorage.getItem(storageKey) || 'null');
      const record = saved?.candidateArtifactDigest === catalog.candidateArtifactDigest && same(saved.account, account)
        ? saved : { candidateArtifactDigest: catalog.candidateArtifactDigest, account, steps: {}, deployed: {} };
      journal.current = { storageKey, record }; setProgress(record);
    } catch { setError('无法保存升级进度，请允许本站使用本地存储后再操作。'); }
  }, [catalog, account]);

  async function connect() {
    setError('');
    try {
      if (!provider.current) throw new Error('请在安装钱包插件的浏览器中打开。');
      const accounts = await provider.current.request({ method: 'eth_requestAccounts' });
      setAccount(accounts?.[0] || '');
    } catch (problem) { setError(problem?.message || '钱包连接未完成。'); }
  }

  function recoverHash(name) {
    const hash = recoveryHashes[name]?.trim();
    if (!hashPattern.test(hash)) { setError('请从钱包交易记录复制完整交易哈希。'); return; }
    const record = journal.current?.record;
    if (!record || busy) return;
    try {
      save({ ...record, steps: { ...record.steps, [name]: { ...record.steps[name], hash, status: 'submitted' } } });
      setError(''); setNotice('已保存交易哈希。点击继续，会核对这笔交易，不会重复发送。');
    } catch (problem) { setError(problem.message); }
  }

  async function run(retryStep = null) {
    if (lock.current || !catalog || !journal.current || !same(account, catalog.bindings.proposer)) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    const context = life.current, connected = provider.current, currentAccount = account, currentJournal = journal.current, epoch = networkEpoch.current;
    const current = () => life.current === context && provider.current === connected && journal.current === currentJournal
      && networkEpoch.current === epoch && same(live.current.account, currentAccount) && live.current.catalog === catalog;
    const persistStep = (name, step) => {
      const record = currentJournal.record;
      save({ ...record, steps: { ...record.steps, [name]: step } }, currentJournal);
    };
    let activeStep = null;
    let wrapperRuntime;
    const runtimeProof = () => wrapperRuntime ??= readUpgradeWrapperRuntime(connected);
    const confirmBatchStep = async (name, status) => {
      activeStep = name;
      const step = currentJournal.record.steps[name];
      if (!step?.hash) {
        persistStep(name, { ...step, status: 'unknown' });
        throw new Error(`升级已在链上${name === 'schedule' ? '提交' : '执行'}，请填写${labels[name]}的交易哈希后继续。`);
      }
      const delay = BigInt(currentJournal.record.steps.schedule?.scheduleDelay ?? status.delay);
      const transaction = name === 'schedule' ? scheduleUpgradeTransaction(catalog, status.batch, delay)
        : executeUpgradeTransaction(catalog, status.batch);
      const batchProof = { kind: name, batch: status.batch, ...(name === 'schedule' ? { delay } : {}) };
      setNotice(`正在确认${labels[name]}的链上结果；不会重复提交。`);
      await confirmUpgradeTransaction(connected, step, { from: currentAccount, ...transaction, batchProof }, { current, runtimeProof });
      if (!current()) throw new Error('钱包或页面已变化，升级进度已保存。');
      persistStep(name, { ...step, status: 'confirmed' });
    };
    const confirmActivated = async status => {
      await confirmBatchStep('schedule', status);
      await confirmBatchStep('execute', status);
      const latest = await readUpgradeStatus(connected, catalog, currentJournal.record.deployed);
      if (!current() || !latest.activated || latest.timestamp !== 1n) throw new Error('升级状态尚未同步，请稍后继续查询。');
      setChainStatus({ ...latest, batchConfirmed: true }); setNotice('升级已在链上启用；后台将自动更新 Firsto 参考价。');
    };
    const transact = async (name, transaction, batchProof) => {
      activeStep = name;
      let step = currentJournal.record.steps[name], failed = false;
      if (step?.hash) {
        try { return await confirmUpgradeTransaction(connected, step, { from: currentAccount, ...transaction, batchProof }, { current, runtimeProof }); }
        catch (problem) {
          if (!problem.confirmedFailure) throw problem;
          persistStep(name, { ...step, status: 'failed' });
          if (retryStep !== name) throw problem;
          failed = true;
        }
      } else if (step && step.status !== 'rejected') {
        throw new Error(`请先填写${labels[name]}在钱包中的交易哈希，核对后继续；不能重复发送未知交易。`);
      }
      if (!current()) throw new Error('钱包或页面已变化，升级进度已保存。');
      const previousHashes = failed ? [...(step.previousHashes || []), step.hash] : step?.previousHashes;
      setNotice(`请在钱包确认：${labels[name]}。`);
      step = await submitUpgradeTransaction(connected, currentAccount, transaction,
        value => persistStep(name, { ...value, ...(previousHashes ? { previousHashes } : {}),
          ...(name === 'schedule' ? { scheduleDelay: batchProof.delay.toString() } : {}) }), { current });
      setNotice(`正在等待${labels[name]}确认；不会重复提交。`);
      return await confirmUpgradeTransaction(connected, step, { from: currentAccount, ...transaction, batchProof }, { current, runtimeProof });
    };
    try {
      const [chain, accounts] = await Promise.all([connected.request({ method: 'eth_chainId' }), connected.request({ method: 'eth_accounts' })]);
      if (BigInt(chain) !== 56n || !accounts.some(value => same(value, currentAccount))) throw new Error('请连接指定部署钱包和 BNB 主网。');
      const recovered = await reconcileUpgradeDeployments(connected, catalog, currentJournal.record.steps, currentAccount,
        { current, retryStep, onChecking: name => { activeStep = name; setNotice(`正在核对已保存的${labels[name]}交易。`); },
          onConfirmed: (name, step) => persistStep(name, step) });
      if (!current()) return;
      save({ ...currentJournal.record, deployed: recovered.deployed });
      let status = await readUpgradeStatus(connected, catalog, recovered.deployed);
      if (!current()) return;
      setChainStatus(status);
      if (status.activated && status.timestamp === 1n) { await confirmActivated(status); return; }
      if (!status.proposer) throw new Error('指定钱包没有本次升级权限。');
      for (const name of order) {
        if (!current()) return;
        if (currentJournal.record.deployed[name]) continue;
        const data = upgradeDeployment(catalog, name, currentJournal.record.deployed);
        const receipt = await transact(name, { data });
        if (!current()) return;
        const address = await verifyUpgradeDeploymentRuntime(connected, catalog, name, receipt.contractAddress, currentJournal.record.deployed);
        if (!current()) return;
        persistStep(name, { ...currentJournal.record.steps[name], status: 'confirmed', address, blockNumber: receipt.blockNumber });
        save({ ...currentJournal.record, deployed: { ...currentJournal.record.deployed, [name]: address } });
      }
      status = await readUpgradeStatus(connected, catalog, currentJournal.record.deployed);
      if (!current()) return;
      setChainStatus(status);
      if (status.timestamp === 0n) {
        const transaction = scheduleUpgradeTransaction(catalog, status.batch, status.delay);
        await transact('schedule', transaction, { kind: 'schedule', batch: status.batch, delay: status.delay });
        if (!current()) return;
        persistStep('schedule', { ...currentJournal.record.steps.schedule, status: 'confirmed' });
        status = await readUpgradeStatus(connected, catalog, currentJournal.record.deployed);
        if (!current()) return;
        setChainStatus(status);
        if (status.timestamp === 0n) throw new Error('升级提交已确认，链上状态正在更新，请稍后继续。');
      } else {
        await confirmBatchStep('schedule', status);
      }
      if (status.timestamp === 1n) { await confirmActivated(status); return; }
      const block = await connected.request({ method: 'eth_getBlockByNumber', params: ['latest', false] });
      if (!current()) return;
      if (BigInt(block.timestamp) < status.timestamp) {
        setNotice(`升级已提交，可启用时间：${new Date(Number(status.timestamp) * 1000).toLocaleString('zh-CN')}。届时点击继续。`); return;
      }
      const transaction = executeUpgradeTransaction(catalog, status.batch);
      await transact('execute', transaction, { kind: 'execute', batch: status.batch });
      if (!current()) return;
      persistStep('execute', { ...currentJournal.record.steps.execute, status: 'confirmed' });
      status = await readUpgradeStatus(connected, catalog, currentJournal.record.deployed);
      if (!current()) return;
      if (!status.activated || status.timestamp !== 1n) throw new Error('升级状态尚未同步，请稍后继续查询。');
      setChainStatus({ ...status, batchConfirmed: true }); setNotice('升级已在链上启用；后台将自动更新 Firsto 参考价。');
    } catch (problem) {
      if (current()) {
        const name = problem.stepName || activeStep;
        if (problem.confirmedFailure && name && currentJournal.record.steps[name])
          persistStep(name, { ...currentJournal.record.steps[name], status: 'failed' });
        setError(problem?.shortMessage || problem?.message || '升级尚未完成。');
      }
    }
    finally { lock.current = false; if (life.current === context) setBusy(false); }
  }

  const journalComplete = [...order, 'schedule', 'execute'].every(name => progress?.steps?.[name]?.status === 'confirmed'
    && hashPattern.test(progress.steps[name].hash));
  const statusNotice = notice || (journalComplete ? '本次升级的6笔交易已确认，可以返回网站继续使用。' : '');
  return <main style={{ maxWidth: 760, margin: '40px auto', padding: 24 }}><section className="panel" style={{ padding: 28 }}>
    <p className="subtle-note">BEMine · {profile === 'full-test' ? '独立测试版' : '正式版'}</p>
    <h1>启用自动参考价</h1>
    <p>后台自动读取 Firsto 参考价并上链。售价低于参考价的 80% 才需管理员审核，正好 80% 无需审核。</p>
    <p>这次启用需部署 4 个合约，并提交、执行 1 个升级批次，共 6 笔钱包交易，只支付 Gas。{profile === 'full-test' ? '测试版无需等待。' : '正式版按原合约等待 48 小时后执行。'}</p>
    {catalog && <p>请使用部署钱包：<span style={{ overflowWrap: 'anywhere' }}>{catalog.bindings.proposer}</span></p>}
    {error && <p className="live-notice error" role="alert">{error}</p>}
    {statusNotice && <p className="live-notice" role="status">{statusNotice}</p>}
    <ol>{[...order, 'schedule', 'execute'].map(name => <li key={name} style={{ margin: '12px 0' }}>{labels[name]} · {progress?.steps?.[name]?.status === 'confirmed' ? '已确认' : progress?.steps?.[name]?.status === 'failed' ? '链上已失败' : progress?.steps?.[name]?.hash ? '等待确认' : '待完成'}
      {progress?.steps?.[name]?.hash && <> · <a href={`https://bscscan.com/tx/${progress.steps[name].hash}`} target="_blank" rel="noreferrer">交易记录</a></>}
      {progress?.steps?.[name]?.status === 'failed' && <button className="btn secondary" disabled={busy} onClick={() => void run(name)}>重试已失败交易</button>}
      {['unknown', 'awaiting-wallet'].includes(progress?.steps?.[name]?.status) && !progress?.steps?.[name]?.hash && <div>
        <p className="subtle-note">钱包结果尚未明确。请从钱包复制这一步的交易哈希，再继续核对。</p>
        <input aria-label={`${labels[name]}交易哈希`} value={recoveryHashes[name] || ''} disabled={busy}
          onChange={event => setRecoveryHashes({ ...recoveryHashes, [name]: event.target.value })} placeholder="0x…" />
        <button className="btn secondary" disabled={busy} onClick={() => recoverHash(name)}>保存交易哈希</button>
      </div>}</li>)}</ol>
    <div className="live-actions"><button className={journalComplete ? 'btn secondary' : 'btn primary'} disabled={busy} onClick={() => void connect()}>{account ? '切换或重连钱包' : '连接部署钱包'}</button>
      <button className={journalComplete ? 'btn secondary' : 'btn primary'} disabled={busy || !catalog || !same(account, catalog.bindings.proposer) || !journal.current
        || chainStatus?.batchConfirmed} onClick={() => void run()}>{busy ? '请完成钱包确认…' : chainStatus?.batchConfirmed ? '已启用' : journalComplete ? '同步升级状态' : progress && Object.keys(progress.steps).length ? '继续启用' : '开始启用'}</button>
      <a className={journalComplete ? 'btn primary' : 'btn secondary'} href={`${basePath}/`}>{journalComplete && profile === 'full-test' ? '返回测试网站' : '返回拼矿'}</a></div>
    {account && !same(account, catalog?.bindings?.proposer) && <p role="status">当前钱包没有这次升级权限，请切换到上方部署钱包。</p>}
    <details style={{ marginTop: 20 }}><summary>升级合约信息</summary>{catalog && <dl>{Object.entries(catalog.bindings).map(([name, value]) => <div key={name} style={{ overflowWrap: 'anywhere' }}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>}</details>
  </section></main>;
}
