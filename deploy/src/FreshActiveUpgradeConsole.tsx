import { useEffect, useMemo, useRef, useState } from 'react';
import { BrowserProvider, Contract, JsonRpcProvider, getAddress, keccak256, type Provider } from 'ethers';
import { ArrowDownToLine, Check, ExternalLink, RefreshCw, ShieldCheck, Wallet } from 'lucide-react';
import trustedGenesisManifest from '../../web/public/data/frontend-manifest.json';
import { buildFreshActiveUpgradePlan, freshUpgradeDeploymentData, freshUpgradeDeploymentOrder,
  validateFreshActiveGraphAgainstChain, validateFreshActiveReplacementsAgainstChain,
  validateFreshActiveUpgradeAgainstChain, type FreshReplacementName, type FreshReplacements,
  type FreshActiveGraphProof, type FreshActiveUpgradeProof } from '../shared/fresh-active-upgrade-plan.mjs';
import { artifactDigest, validateArtifacts, type ArtifactBundle, type DeploymentSnapshot } from './deployment';
import { freshActiveUpgradeJournalKey, newFreshActiveUpgradeJournal, parseFreshActiveUpgradeJournal,
  type FreshActiveUpgradeJournal } from './fresh-active-upgrade-ui';
import { assertTrustedGenesis } from './upgrade-ui';
import { checkFreshActiveUpgradeExecutionRelease, requireFreshActiveUpgradeExecutionRelease,
  initialUpgradeExecutionRelease, type UpgradeExecutionRelease } from './upgrade-release';
import { type UpgradeTransaction } from './upgrade-journal';
import { sendUpgradeTransaction, UncertainUpgradeSubmission, verifyUpgradeReceipt } from './upgrade-transactions';
import { messageOf, type WalletProvider } from './wallet';
import './upgrade.css';

declare const __DEPLOYMENT_ARTIFACT_DIGEST__: string;
type Props = {
  wallet: WalletProvider | null; account: string | null; chainId: number | null;
  currentBundle: ArtifactBundle | null; currentRecord: DeploymentSnapshot | null;
  initialGenesisBundle?: ArtifactBundle | null; onConnect: () => void;
};
type Operation = 'unknown' | 'unscheduled' | 'waiting' | 'ready' | 'done';
const labels: Record<FreshReplacementName, string> = {
  PoolFunds: '资金结算库', FlexiblePurchase: '灵活购机库', SaleSettlement: '出售结算库',
  SaleGovernance: '出售治理库', FirstoSale: 'Firsto 出售库', PoolVault: '单机矿池实现',
  FreshPoolFactory: '正式单机 Factory 实现', ShareMarket: '份额市场实现',
  BudgetPortfolioVault: '多机项目实现', BudgetPortfolioFactory: '多机 Factory 实现',
};
const explorer = 'https://bscscan.com';
const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function rpcProvider() {
  return new JsonRpcProvider(new URL('api/rpc', window.location.href).href, 56,
    { batchMaxCount: 1, cacheTimeout: -1 });
}
function newSalt() {
  const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
  if (bytes.every(value => value === 0)) bytes[31] = 1;
  return `0x${Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')}`;
}

export default function FreshActiveUpgradeConsole({ wallet, account, chainId, currentBundle: candidate,
  currentRecord: record, initialGenesisBundle: genesis, onConnect }: Props) {
  const [journal, setJournal] = useState<FreshActiveUpgradeJournal | null>(null);
  const [graphProof, setGraphProof] = useState<FreshActiveGraphProof | null>(null);
  const [planProof, setPlanProof] = useState<FreshActiveGraphProof | null>(null);
  const [resultProof, setResultProof] = useState<FreshActiveUpgradeProof | null>(null);
  const [operation, setOperation] = useState<Operation>('unknown');
  const [readyAt, setReadyAt] = useState<number | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState('');
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [recoveryHash, setRecoveryHash] = useState('');
  const [releaseGate, setReleaseGate] = useState<UpgradeExecutionRelease>(initialUpgradeExecutionRelease);
  const onBsc = !!wallet && !!account && chainId === 56;
  const trust = useMemo(() => {
    try {
      if (!record || !genesis || !candidate) throw new Error('正在加载已固定的正式 v5 记录和合约产物。');
      assertTrustedGenesis(record, genesis, trustedGenesisManifest as never);
      validateArtifacts(candidate);
      const digest = artifactDigest(candidate);
      if (digest.toLowerCase() !== __DEPLOYMENT_ARTIFACT_DIGEST__.toLowerCase()
        || digest.toLowerCase() === record.artifactDigest.toLowerCase()) {
        throw new Error('候选产物与本页独立编译的新版本摘要不符。');
      }
      const expected = { factory: record.addresses.factory,
        genesisArtifactDigest: record.artifactDigest, upgradeArtifactDigest: digest };
      return { ok: true, reason: '', expected, key: freshActiveUpgradeJournalKey(expected) };
    } catch (problem) { return { ok: false, reason: messageOf(problem), expected: null, key: null }; }
  }, [record, genesis, candidate]);
  const common = useMemo(() => trust.ok && record && genesis && candidate ? {
    genesisRecord: record, genesisBundle: genesis, trustedGenesisManifest,
    upgradeBundle: candidate, trustedUpgradeArtifactDigest: __DEPLOYMENT_ARTIFACT_DIGEST__,
  } : null, [trust.ok, record, genesis, candidate]);
  useEffect(() => {
    setGraphProof(null); setPlanProof(null); setResultProof(null); setReviewed(false);
    setOperation('unknown'); setReadyAt(null); setError(''); setRecoveryHash('');
    if (!trust.key || !trust.expected) { setJournal(null); return; }
    try {
      const raw = localStorage.getItem(trust.key);
      setJournal(raw ? parseFreshActiveUpgradeJournal(JSON.parse(raw), trust.expected) : null);
    } catch (problem) { setJournal(null); setError(messageOf(problem)); }
  }, [trust]);
  useEffect(() => { setPlanProof(null); setReviewed(false); }, [account, chainId]);
  const replacements = useMemo(() => {
    if (!journal || !freshUpgradeDeploymentOrder.every(name => journal.deployments[name]?.status === 'confirmed'
      && !!journal.deployments[name]?.address)) return null;
    return Object.fromEntries(freshUpgradeDeploymentOrder.map(name => [name, journal.deployments[name]!.address!])) as FreshReplacements;
  }, [journal?.deployments]);
  const planState = useMemo(() => {
    if (!common || !journal || !replacements) return { plan: null, reason: '' };
    try { return { plan: buildFreshActiveUpgradePlan({ ...common, replacements,
      salt: journal.salt, delaySeconds: journal.delaySeconds }), reason: '' }; }
    catch (problem) { return { plan: null, reason: messageOf(problem) }; }
  }, [common, journal?.salt, journal?.delaySeconds, replacements]);
  const plan = planState.plan;
  const releaseInputs = useMemo(() => plan && candidate && wallet && onBsc
    ? { candidateBundle: candidate, candidateDigest: __DEPLOYMENT_ARTIFACT_DIGEST__, plan, wallet } : null,
  [plan, candidate, wallet, onBsc]);
  useEffect(() => {
    setReleaseGate(initialUpgradeExecutionRelease);
    if (!releaseInputs) return;
    let active = true;
    void checkFreshActiveUpgradeExecutionRelease(releaseInputs).then(proof => { if (active) setReleaseGate(proof); });
    return () => { active = false; };
  }, [releaseInputs]);
  const pendingName = freshUpgradeDeploymentOrder.find(name => journal?.deployments[name]
    && journal.deployments[name]?.status !== 'confirmed');
  const nextName = freshUpgradeDeploymentOrder.find(name => journal?.deployments[name]?.status !== 'confirmed');
  const proposer = graphProof?.proposer || record?.input.ownerMultisig;
  const signerMatches = !!account && !!proposer && getAddress(account) === getAddress(proposer);
  const roles = graphProof?.authority || trustedGenesisManifest.freshAuthority;

  function save(next: FreshActiveUpgradeJournal, invalidate = true) {
    if (!trust.key || !trust.expected) throw new Error('正式 v5 和候选产物尚未通过可信来源检查。');
    parseFreshActiveUpgradeJournal(next, trust.expected);
    localStorage.setItem(trust.key, JSON.stringify(next)); setJournal(next);
    if (invalidate) setPlanProof(null);
  }
  async function run(label: string, action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(label); setError(''); setMessage('');
    try { await action(); }
    catch (problem) { setError(messageOf(problem)); }
    finally { busyRef.current = false; setBusy(''); }
  }
  async function exclusive(action: () => Promise<void>) {
    if (!journal || !trust.key || !navigator.locks) throw new Error('请使用支持跨标签交易记录保护的最新版浏览器。');
    await navigator.locks.request(trust.key, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) throw new Error('另一个标签正在处理该升级交易，请先核对原交易。');
      if (localStorage.getItem(trust.key!) !== JSON.stringify(journal)) {
        throw new Error('升级记录已由其他标签更新，请刷新后继续。');
      }
      await action();
    });
  }
  function receiptProvider(): Provider {
    if (!wallet || !onBsc) throw new Error('请连接 BSC 主网钱包后核对交易回执。');
    const read = rpcProvider(), walletRead = new BrowserProvider(wallet);
    return { send: read.send.bind(read), getBlock: read.getBlock.bind(read),
      getCode: read.getCode.bind(read), getStorage: read.getStorage.bind(read),
      getTransaction: walletRead.getTransaction.bind(walletRead),
      getTransactionReceipt: walletRead.getTransactionReceipt.bind(walletRead) } as unknown as Provider;
  }
  function deployedAddresses(source: FreshActiveUpgradeJournal, end: number = freshUpgradeDeploymentOrder.length): Partial<FreshReplacements> {
    return Object.fromEntries(freshUpgradeDeploymentOrder.slice(0, end)
      .filter(name => source.deployments[name]?.status === 'confirmed')
      .map(name => [name, source.deployments[name]!.address!])) as Partial<FreshReplacements>;
  }
  async function readGraph() {
    await run('读取正式 v5 链上状态', async () => {
      if (!common) throw new Error(trust.reason);
      if (plan && await refreshOperation() === 'done') {
        await verifyResult(); return;
      }
      const proof = await validateFreshActiveGraphAgainstChain(rpcProvider(), common);
      setGraphProof(proof);
      setMessage(`正式 v5 已在最终确认区块 #${proof.blockNumber} 核验。请使用当前升级钱包 ${proof.proposer}。`);
    });
  }
  function createJournal() {
    if (!trust.expected || !graphProof) return;
    try {
      if (trust.key && localStorage.getItem(trust.key)) throw new Error('本机已有本次升级记录，请刷新页面继续。');
      save(newFreshActiveUpgradeJournal(trust.expected, newSalt())); setMessage('已在本机保存本次升级批次。');
    }
    catch (problem) { setError(messageOf(problem)); }
  }
  async function deploy(name: FreshReplacementName) {
    await run(`部署${labels[name]}`, async () => {
      if (!common || !candidate || !record || !journal || !wallet || !account || !onBsc
        || !graphProof || !signerMatches || pendingName || nextName !== name) {
        throw new Error('请连接当前升级钱包并先核对上一笔部署。');
      }
      const prior = deployedAddresses(journal, freshUpgradeDeploymentOrder.indexOf(name));
      const proof = await validateFreshActiveReplacementsAgainstChain(rpcProvider(), { ...common, deployments: prior, signer: account });
      setGraphProof(proof);
      const data = freshUpgradeDeploymentData(name, candidate, { ...record.addresses, ...prior });
      const transaction: UpgradeTransaction = { status: 'uncertain', from: account, dataHash: keccak256(data) };
      await exclusive(async () => {
        save({ ...journal, deployments: { ...journal.deployments, [name]: transaction } });
        let hash: string;
        try { hash = await sendUpgradeTransaction(wallet, { from: account, data }); }
        catch (problem) {
          if (!(problem instanceof UncertainUpgradeSubmission)) {
            const deployments = { ...journal.deployments }; delete deployments[name];
            save({ ...journal, deployments });
          }
          throw problem;
        }
        save({ ...journal, deployments: { ...journal.deployments,
          [name]: { ...transaction, status: 'submitted', txHash: hash } } });
        setMessage(`${labels[name]}已提交。核对回执后继续下一项。`);
      });
    });
  }
  async function recoverDeployment(name: FreshReplacementName) {
    await run(`核对${labels[name]}回执`, async () => {
      if (!common || !candidate || !record || !journal) throw new Error('本次升级记录不可用。');
      const transaction = journal.deployments[name];
      if (!transaction || transaction.status === 'confirmed') throw new Error('没有待核对的部署。');
      const hash = transaction.txHash || recoveryHash.trim();
      const prior = deployedAddresses(journal, freshUpgradeDeploymentOrder.indexOf(name));
      const data = freshUpgradeDeploymentData(name, candidate, { ...record.addresses, ...prior });
      if (keccak256(data).toLowerCase() !== transaction.dataHash.toLowerCase()) throw new Error('已保存交易与本次候选字节码不同。');
      const receipt = await verifyUpgradeReceipt(receiptProvider(), hash, { from: transaction.from, dataHash: transaction.dataHash });
      if (!receipt) { setMessage('交易尚未最终确认，请稍后核对原交易。'); return; }
      if (!receipt.contractAddress) throw new Error('成功回执缺少合约地址。');
      await validateFreshActiveReplacementsAgainstChain(rpcProvider(), { ...common,
        deployments: { ...prior, [name]: getAddress(receipt.contractAddress) } });
      await exclusive(async () => {
        save({ ...journal, deployments: { ...journal.deployments, [name]: { ...transaction,
          status: 'confirmed', txHash: hash, address: getAddress(receipt.contractAddress!) } } });
      });
      setRecoveryHash(''); setMessage(`${labels[name]}运行代码和依赖关系已确认。`);
    });
  }
  async function refreshOperation(): Promise<Operation> {
    if (!record || !plan) return 'unknown';
    const read = rpcProvider(), block = await read.getBlock('finalized');
    if (!block || !block.hash) throw new Error('无法读取最终确认区块。');
    const lock = new Contract(record.addresses.timelock, ['function getTimestamp(bytes32) view returns(uint256)'], read);
    const timestamp = await lock.getTimestamp(plan.operationId, { blockTag: block.number }) as bigint;
    const canonical = await read.getBlock(block.number);
    if (canonical?.hash !== block.hash) throw new Error('最终确认区块已变化，请重新读取。');
    const status = timestamp === 0n ? 'unscheduled' : timestamp === 1n ? 'done'
      : timestamp <= BigInt(block.timestamp) ? 'ready' : 'waiting';
    setOperation(status); setReadyAt(timestamp > 1n ? Number(timestamp) : null); return status;
  }
  async function verifyPlan() {
    await run('核验完整升级批次', async () => {
      if (!plan || !common || !account || !onBsc || !signerMatches) throw new Error('请完成十个候选部署并连接当前升级钱包。');
      const status = await refreshOperation();
      if (status === 'done') { await verifyResult(); return; }
      const proof = status === 'waiting'
        ? await validateFreshActiveReplacementsAgainstChain(rpcProvider(), { ...common, deployments: plan.replacements, signer: account })
        : await validateFreshActiveUpgradeAgainstChain(rpcProvider(), plan, { ...common, proposer: account,
          phase: status === 'ready' ? 'scheduled' : 'unscheduled' });
      setPlanProof(proof); setGraphProof(proof);
      setMessage(status === 'waiting' ? '排程与候选合约已核对，等待 48 小时后执行。' : '当前链上批次和候选实现已核验，签名前会再次检查。');
    });
  }
  async function sendBatch(which: 'schedule' | 'execute') {
    await run(which === 'schedule' ? '提交 48 小时升级提案' : '执行升级批次', async () => {
      if (!plan || !common || !releaseInputs || !record || !journal || !account || !wallet || !onBsc
        || !signerMatches || !reviewed || !planProof || journal[which]
        || (which === 'execute' && journal.schedule?.status !== 'confirmed')) throw new Error('批次、钱包或当前交易记录尚未就绪。');
      const preflight = await validateFreshActiveUpgradeAgainstChain(rpcProvider(), plan,
        { ...common, proposer: account, phase: which === 'schedule' ? 'unscheduled' : 'scheduled' });
      const data = which === 'schedule' ? plan.scheduleData : plan.executeData;
      const transaction: UpgradeTransaction = { status: 'uncertain', from: account, dataHash: keccak256(data) };
      const prior = which === 'execute' ? { ...journal, preExecutionPreflight: preflight } : journal;
      await exclusive(async () => {
        await requireFreshActiveUpgradeExecutionRelease(releaseInputs);
        save({ ...prior, [which]: transaction });
        let hash: string;
        try { hash = await sendUpgradeTransaction(wallet, { from: account, to: record.addresses.timelock, data }); }
        catch (problem) {
          if (!(problem instanceof UncertainUpgradeSubmission)) save({ ...prior, [which]: undefined });
          throw problem;
        }
        save({ ...prior, [which]: { ...transaction, status: 'submitted', txHash: hash } });
        setMessage('时间锁交易已提交。请核对原交易回执后继续。');
      });
    });
  }
  async function recoverBatch(which: 'schedule' | 'execute') {
    await run('核对时间锁交易', async () => {
      if (!journal || !plan || !record || !common) throw new Error('本次升级记录不可用。');
      const transaction = journal[which];
      if (!transaction || transaction.status === 'confirmed') throw new Error('没有待核对的交易。');
      const hash = transaction.txHash || recoveryHash.trim();
      const data = which === 'schedule' ? plan.scheduleData : plan.executeData;
      if (keccak256(data).toLowerCase() !== transaction.dataHash.toLowerCase()) throw new Error('保存的时间锁交易与当前完整批次不符。');
      const receipt = await verifyUpgradeReceipt(receiptProvider(), hash,
        { from: transaction.from, to: record.addresses.timelock, dataHash: transaction.dataHash });
      if (!receipt) { setMessage('时间锁交易尚未最终确认，请稍后核对。'); return; }
      const status = await refreshOperation();
      if (which === 'schedule' && status === 'unscheduled') throw new Error('排程回执已确认，但批次当前未安排；请检查是否已撤销。');
      if (which === 'execute') {
        const proof = await validateFreshActiveUpgradeAgainstChain(rpcProvider(), plan,
          { ...common, proposer: plan.proposer, phase: 'done', preExecutionPreflight: journal.preExecutionPreflight });
        setResultProof(proof); setGraphProof(proof);
      }
      await exclusive(async () => {
        save({ ...journal, [which]: { ...transaction, status: 'confirmed', txHash: hash } });
      });
      setRecoveryHash(''); setMessage(which === 'schedule' ? '升级提案已确认。到期后重新打开本页执行。'
        : '合约升级已确认。下一步切换网站和后台版本，再恢复建池。');
    });
  }
  async function verifyResult() {
    if (!plan || !common || !journal) throw new Error('本次升级批次不可用。');
    const proof = await validateFreshActiveUpgradeAgainstChain(rpcProvider(), plan,
      { ...common, proposer: plan.proposer, phase: 'done', preExecutionPreflight: journal.preExecutionPreflight });
    setResultProof(proof); setGraphProof(proof); setOperation('done'); setReadyAt(null);
    setMessage(`合约升级已在区块 #${proof.blockNumber} 验证，两套 Factory 已暂停建池，等待网站和后台切换。`);
  }
  const transactionPending = !!journal?.schedule && journal.schedule.status !== 'confirmed'
    || !!journal?.execute && journal.execute.status !== 'confirmed';
  const operationLabels: Record<Operation, string> = { unknown: '尚未读取', unscheduled: '尚未提交', waiting: '等待中', ready: '可执行', done: '已执行' };

  return <div className="upgrade-page">
    <section className="card upgrade-intro"><div><h2>正式 v5 合约升级</h2>
      <p>连接当前升级钱包，部署十个候选合约，然后提交一笔升级提案。等待至少 48 小时后在本页执行。</p>
      <p>执行批次会同时暂停两套 Factory 建池并升级六个目标。合约核验完成后切换网站和后台，再恢复建池。</p>
    </div><span className="upgrade-state"><ShieldCheck size={13}/>BSC 主网</span></section>
    <section className="card"><div className="card-heading"><div><ShieldCheck size={19}/><h2>1. 当前合约与钱包</h2></div></div>
      <div className="upgrade-section"><div className="upgrade-meta">
        <div><span>当前升级钱包</span><b className="upgrade-code">{proposer || '加载中…'}</b></div>
        <div><span>管理员一</span><b className="upgrade-code">{roles.administratorOne}</b></div>
        <div><span>管理员二</span><b className="upgrade-code">{roles.administratorTwo}</b></div>
        <div><span>Gas 钱包</span><b className="upgrade-code">{roles.gasWallet}</b></div>
        <div><span>Authority</span><b className="upgrade-code">{roles.address}</b></div>
        <div><span>当前连接账户</span><b className="upgrade-code">{account || '未连接'}</b></div>
      </div>
      {!trust.ok && <div className="upgrade-alert note">{trust.reason}</div>}
      {onBsc && !signerMatches && <div className="upgrade-alert note">请在钱包中切换到上方“当前升级钱包”。</div>}
      <div className="upgrade-actions"><button className="small-button" disabled={!common || !!busy} onClick={() => void readGraph()}><RefreshCw size={14}/>{busy || '读取当前链上状态'}</button>
        {!onBsc && <button className="small-button" onClick={onConnect}><Wallet size={14}/>连接 BSC 钱包</button>}
        {!journal && <button className="small-button" disabled={!graphProof || !!busy} onClick={createJournal}>开始本次升级</button>}
      </div>
      {graphProof && <div className="upgrade-alert ok">已在最终确认区块 #{graphProof.blockNumber} 核验。单机项目 {graphProof.poolCount} 个，多机项目 {graphProof.portfolioCount} 个。</div>}
      <details className="upgrade-details"><summary>查看正式部署和候选产物摘要</summary><pre>{JSON.stringify({ factory: record?.addresses.factory,
        genesisArtifactDigest: record?.artifactDigest, upgradeArtifactDigest: candidate ? artifactDigest(candidate) : null }, null, 2)}</pre></details>
      </div></section>
    <section className="card"><div className="card-heading"><div><ShieldCheck size={19}/><h2>2. 部署候选合约</h2></div><span className="subtle-tag">{freshUpgradeDeploymentOrder.filter(name => journal?.deployments[name]?.status === 'confirmed').length} / 10</span></div>
      <div className="upgrade-section"><p>按依赖顺序逐笔确认。记录自动保存在本机；交易结果不明时填写原交易哈希，核对回执后继续。</p>
      <ol className="upgrade-step-list">{freshUpgradeDeploymentOrder.map((name, index) => {
        const transaction = journal?.deployments[name];
        return <li className="upgrade-step" key={name}><span className="upgrade-step-index">{transaction?.status === 'confirmed' ? <Check size={15}/> : index + 1}</span>
          <div><b>{labels[name]}</b><small>{name} · {transaction?.status === 'confirmed' ? '已核验' : transaction ? '已提交，待核对' : '待部署'}</small>
            {transaction?.address && <a className="upgrade-code" target="_blank" rel="noreferrer" href={`${explorer}/address/${transaction.address}`}>{short(transaction.address)}</a>}
            {transaction?.txHash && <small><a target="_blank" rel="noreferrer" href={`${explorer}/tx/${transaction.txHash}`}>查看原交易 <ExternalLink size={11}/></a></small>}
          </div>{transaction && transaction.status !== 'confirmed'
            ? <button className="small-button" disabled={!onBsc || !!busy} onClick={() => void recoverDeployment(name)}>核对回执</button>
            : transaction?.status === 'confirmed' ? null : <button className="small-button"
              disabled={!journal || !graphProof || !onBsc || !signerMatches || !!pendingName || name !== nextName || !!busy}
              onClick={() => void deploy(name)}>部署</button>}
        </li>;
      })}</ol>
      {pendingName && journal?.deployments[pendingName]?.status === 'uncertain' && <input className="upgrade-step-input"
        value={recoveryHash} onChange={event => setRecoveryHash(event.target.value)} placeholder="填写钱包中该笔原部署交易的完整哈希"/>}
      </div></section>
    <section className="card"><div className="card-heading"><div><ShieldCheck size={19}/><h2>3. 提交与执行升级</h2></div><span className="subtle-tag">至少 48 小时</span></div>
      <div className="upgrade-section"><p>同一批次包含两笔暂停建池和六笔实现升级，所有调用金额均为 0 BNB。</p>
      {planState.reason && <div className="upgrade-alert error">{planState.reason}</div>}
      {plan && <><div className="upgrade-meta"><div><span>批次状态</span><b>{operationLabels[operation]}</b></div>
        <div><span>最早执行时间</span><b>{readyAt ? new Date(readyAt * 1000).toLocaleString('zh-CN') : '—'}</b></div>
        <div><span>操作 ID</span><b className="upgrade-code">{plan.operationId}</b></div></div>
        <details className="upgrade-details"><summary>查看八笔调用和完整签署数据</summary><pre>{JSON.stringify(plan, null, 2)}</pre></details>
      </>}
      <div className="upgrade-actions"><button className="small-button" disabled={!plan || !onBsc || !signerMatches || !!busy}
        onClick={() => void verifyPlan()}><ShieldCheck size={14}/>核验批次与时间锁</button>
        {plan && <button className="small-button" disabled={!!busy} onClick={() => void run('刷新时间锁', async () => { await refreshOperation(); })}><RefreshCw size={14}/>刷新等待时间</button>}
      </div>
      {planProof && <div className="upgrade-alert ok">候选实现与链上批次已在区块 #{planProof.blockNumber} 核验。</div>}
      {plan && <><div className={`upgrade-alert ${releaseGate.ready ? 'ok' : 'note'}`}>{releaseGate.reason}</div>
        <div className="upgrade-actions"><button className="small-button" disabled={!releaseInputs || !!busy}
          onClick={() => void run('核验正式发布', async () => { if (releaseInputs) setReleaseGate(await checkFreshActiveUpgradeExecutionRelease(releaseInputs)); })}>刷新正式发布核验</button></div>
        <label className="upgrade-ack"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)}/>
          <span>已核对本次八笔调用、候选实现和操作 ID。执行后继续切换网站与后台版本。</span></label>
        <div className="upgrade-actions"><button className="primary-button" disabled={!releaseGate.ready || !planProof || !onBsc || !signerMatches || !reviewed
          || !!journal?.schedule || transactionPending || operation !== 'unscheduled' || !!busy}
          onClick={() => void sendBatch('schedule')}>提交 48 小时升级提案</button>
          <button className="primary-button" disabled={!releaseGate.ready || !planProof || !onBsc || !signerMatches || !reviewed
            || journal?.schedule?.status !== 'confirmed' || !!journal?.execute || transactionPending || operation !== 'ready' || !!busy}
            onClick={() => void sendBatch('execute')}>到期后执行升级</button></div>
      </>}
      {(['schedule', 'execute'] as const).map(which => journal?.[which] && journal[which]?.status !== 'confirmed'
        ? <div className="upgrade-actions" key={which}>{!journal[which]?.txHash && <input className="upgrade-step-input"
          value={recoveryHash} onChange={event => setRecoveryHash(event.target.value)} placeholder="填写该笔原时间锁交易的完整哈希"/>}
          <button className="small-button" disabled={!onBsc || !!busy} onClick={() => void recoverBatch(which)}>核对{which === 'schedule' ? '提案' : '执行'}回执</button>
        </div> : null)}
      {plan && operation === 'done' && <div className="upgrade-actions"><button className="small-button" disabled={!!busy}
        onClick={() => void run('核验升级结果', verifyResult)}>核验升级结果</button></div>}
      {resultProof && <div className="upgrade-alert ok">合约升级已验证。两套 Factory 暂停建池，等待网站和后台切换后恢复。</div>}
      {journal && <div className="upgrade-actions"><button className="small-button" onClick={() => download('bemine-v5-upgrade-evidence.json',
        { plan, journal, graphProof, planProof, resultProof, backendCutoverVerified: false, productCutoverVerified: false })}><ArrowDownToLine size={14}/>导出升级记录</button>
        <a className="small-button" target="_blank" rel="noreferrer" href={`${explorer}/address/${record?.addresses.timelock}`}><ExternalLink size={14}/>查看时间锁</a></div>}
      </div></section>
    {message && <div className="upgrade-alert ok" role="status">{message}</div>}
    {error && <div className="upgrade-alert error" role="alert">{error}</div>}
  </div>;
}
