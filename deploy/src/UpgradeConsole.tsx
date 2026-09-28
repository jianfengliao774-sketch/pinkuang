import { useEffect, useMemo, useState } from 'react';
import { BrowserProvider, Contract, JsonRpcProvider, getAddress, keccak256, type Provider } from 'ethers';
import { ArrowDownToLine, ArrowUpRight, Check, ExternalLink, LockKeyhole, RefreshCw, ShieldCheck, Wallet } from 'lucide-react';
import trustedGenesisManifest from '../../web/public/data/frontend-manifest.json';
import {
  buildIntegratedUpgradePlan, integratedUpgradeDeploymentData, integratedUpgradeDeploymentOrder,
  validateIntegratedUpgradeGenesisAgainstChain, validateIntegratedUpgradePlanAgainstChain,
  validateIntegratedUpgradePartialReplacementsAgainstChain,
  validateIntegratedUpgradeScheduledAgainstChain,
  validateIntegratedUpgradeResultAgainstChain,
  buildIntegratedTreasuryMigrationPlan,
  type IntegratedUpgradePreflight, type IntegratedGenesisPreflight, type IntegratedUpgradeResult,
  type IntegratedReplacementName, type IntegratedReplacements,
} from '../shared/integrated-upgrade-plan.mjs';
import { artifactDigest, validateArtifacts, type ArtifactBundle, type DeploymentSnapshot } from './deployment';
import { assertTrustedGenesis } from './upgrade-ui';
import { authorityAdministrators, stageTwoAddresses } from './upgrade-stage2';
import { newUpgradeJournal, parseUpgradeJournal, upgradeJournalKey, type UpgradeJournal, type UpgradeTransaction } from './upgrade-journal';
import { sendUpgradeTransaction, UncertainUpgradeSubmission, verifyUpgradeReceipt } from './upgrade-transactions';
import { messageOf, type WalletProvider } from './wallet';
import './upgrade.css';

declare const __DEPLOYMENT_ARTIFACT_DIGEST__: string;

type Props = {
  wallet: WalletProvider | null;
  account: string | null;
  chainId: number | null;
  currentBundle: ArtifactBundle | null;
  currentRecord: DeploymentSnapshot | null;
  onConnect: () => void;
};

type ChainOperation = 'unknown' | 'unscheduled' | 'waiting' | 'ready' | 'done';
const explorer = 'https://bscscan.com';
const timelockAbi = [
  'function isOperation(bytes32) view returns(bool)',
  'function isOperationReady(bytes32) view returns(bool)',
  'function isOperationDone(bytes32) view returns(bool)',
  'function getTimestamp(bytes32) view returns(uint256)',
];
const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;

function download(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function localJson<T>(file: File): Promise<T> {
  if (file.size > 8_000_000 || file.size === 0) throw new Error('JSON 文件为空或超过 8 MB。');
  return JSON.parse(await file.text()) as T;
}

function rpcProvider() {
  return new JsonRpcProvider(new URL('api/rpc', window.location.href).href, 56,
    { batchMaxCount: 1, cacheTimeout: -1 });
}

function newSalt(): string {
  const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, part => part.toString(16).padStart(2, '0')).join('')}`;
}

export default function UpgradeConsole({wallet, account, chainId, currentBundle, currentRecord, onConnect}: Props) {
  const [uploadedRecord, setUploadedRecord] = useState<DeploymentSnapshot | null>(null);
  const [uploadedGenesisBundle, setUploadedGenesisBundle] = useState<ArtifactBundle | null>(null);
  const [journal, setJournal] = useState<UpgradeJournal | null>(null);
  const [genesisProof, setGenesisProof] = useState<IntegratedGenesisPreflight | null>(null);
  const [planProof, setPlanProof] = useState<IntegratedUpgradePreflight | null>(null);
  const [resultProof, setResultProof] = useState<IntegratedUpgradeResult | null>(null);
  const [hardwareWalletInput, setHardwareWalletInput] = useState('');
  const [gasWalletInput, setGasWalletInput] = useState('');
  const [authorityAddress, setAuthorityAddress] = useState('');
  const [migrationSalt, setMigrationSalt] = useState('');
  const [operation, setOperation] = useState<ChainOperation>('unknown');
  const [readyAt, setReadyAt] = useState<number | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [recoveryHash, setRecoveryHash] = useState('');

  const record = uploadedRecord || currentRecord;
  const oldBundle = uploadedGenesisBundle || (currentBundle && record
    && artifactDigest(currentBundle).toLowerCase() === record.artifactDigest.toLowerCase() ? currentBundle : null);
  const upgradeBundle = currentBundle;
  const oldTrust = useMemo(() => {
    if (!record || !oldBundle) return {ok: false, reason: '导入旧部署完整记录及当时的编译产物。'};
    try {
      assertTrustedGenesis(record, oldBundle, trustedGenesisManifest as never);
      return {ok: true, reason: ''};
    } catch (problem) { return {ok: false, reason: messageOf(problem)}; }
  }, [record, oldBundle]);
  const upgradeTrust = useMemo(() => {
    if (!upgradeBundle) return {ok: false, reason: '等待新版本合约产物加载。'};
    try {
      validateArtifacts(upgradeBundle);
      const digest = artifactDigest(upgradeBundle);
      if (digest.toLowerCase() !== __DEPLOYMENT_ARTIFACT_DIGEST__.toLowerCase()) {
        throw new Error('候选产物与页面构建时独立编译的摘要不一致。');
      }
      if (digest.toLowerCase() === trustedGenesisManifest.artifactDigest.toLowerCase()) {
        throw new Error('当前页面仍是旧版产物；尚未发布新的可升级编译包。');
      }
      return {ok: true, reason: ''};
    } catch (problem) { return {ok: false, reason: messageOf(problem)}; }
  }, [upgradeBundle]);

  const context = useMemo(() => {
    if (!record || !upgradeBundle || !oldTrust.ok || !upgradeTrust.ok) return null;
    const expected = {
      factory: record.addresses.factory,
      genesisArtifactDigest: record.artifactDigest,
      upgradeArtifactDigest: artifactDigest(upgradeBundle),
    };
    return {expected, key: upgradeJournalKey(expected.factory, expected.genesisArtifactDigest, expected.upgradeArtifactDigest)};
  }, [record, upgradeBundle, oldTrust.ok, upgradeTrust.ok]);
  useEffect(() => {
    setGenesisProof(null); setPlanProof(null); setResultProof(null); setOperation('unknown'); setReviewed(false);
    if (!context) { setJournal(null); return; }
    try {
      const raw = localStorage.getItem(context.key);
      setJournal(raw ? parseUpgradeJournal(JSON.parse(raw), context.expected) : null);
    } catch (problem) { setJournal(null); setError(messageOf(problem)); }
  }, [context]);
  useEffect(() => { setGenesisProof(null); setPlanProof(null); setReviewed(false); }, [account, chainId]);

  const save = (next: UpgradeJournal, invalidatePlanProof = true) => {
    if (!context) throw new Error('旧部署或新产物尚未通过核验。');
    localStorage.setItem(context.key, JSON.stringify(next));
    setJournal(next);
    if (invalidatePlanProof) setPlanProof(null);
  };
  async function exclusiveSend(action: () => Promise<void>) {
    if (!context || !journal || !navigator.locks) {
      throw new Error('浏览器不支持跨标签事务锁，或升级记录尚未准备好；请使用最新版 Chrome。');
    }
    await navigator.locks.request(context.key,{mode:'exclusive',ifAvailable:true},async lock => {
      if (!lock) throw new Error('另一个标签正在处理升级交易，已阻止重复签署。');
      if (localStorage.getItem(context.key) !== JSON.stringify(journal)) {
        throw new Error('另一标签已更新升级记录，请刷新页面并核对链上交易。');
      }
      await action();
    });
  }
  const completeAddresses = useMemo(() => {
    if (!journal) return null;
    const entries = integratedUpgradeDeploymentOrder.map(name => [name, journal.deployments[name]?.status === 'confirmed'
      ? journal.deployments[name].address : undefined] as const);
    if (entries.some(([, address]) => !address)) return null;
    return Object.fromEntries(entries) as IntegratedReplacements;
  }, [journal]);
  const planState = useMemo(() => {
    if (!record || !oldBundle || !upgradeBundle || !journal || !completeAddresses
      || !oldTrust.ok || !upgradeTrust.ok) return {plan: null, reason: ''};
    try {
      return {plan: buildIntegratedUpgradePlan({
        genesisRecord: record, genesisBundle: oldBundle, trustedGenesisManifest,
        upgradeBundle, trustedUpgradeArtifactDigest: __DEPLOYMENT_ARTIFACT_DIGEST__,
        replacements: completeAddresses, salt: journal.salt, delaySeconds: journal.delaySeconds,
      }), reason: ''};
    } catch (problem) { return {plan: null, reason: messageOf(problem)}; }
  }, [record, oldBundle, upgradeBundle, journal, completeAddresses, oldTrust.ok, upgradeTrust.ok]);
  const plan = planState.plan;
  const nextName = integratedUpgradeDeploymentOrder.find(name => journal?.deployments[name]?.status !== 'confirmed');
  const pendingName = integratedUpgradeDeploymentOrder.find(name => journal?.deployments[name]?.status === 'submitted'
    || journal?.deployments[name]?.status === 'uncertain');
  const onBsc = !!wallet && !!account && chainId === 56;
  function receiptProvider(): Provider {
    if (!wallet || !onBsc) throw new Error('请先连接 BSC 主网钱包，以读取交易及回执。');
    const read = rpcProvider(), walletRead = new BrowserProvider(wallet);
    return {
      send: read.send.bind(read), getBlock: read.getBlock.bind(read),
      getCode: read.getCode.bind(read), getStorage: read.getStorage.bind(read),
      getTransaction: walletRead.getTransaction.bind(walletRead),
      getTransactionReceipt: walletRead.getTransactionReceipt.bind(walletRead),
    } as unknown as Provider;
  }

  async function run(task: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(task); setError(''); setMessage('');
    try { await action(); }
    catch (problem) { setError(messageOf(problem)); }
    finally { setBusy(''); }
  }
  async function readOldRecord(file: File | undefined) {
    if (!file) return;
    await run('读取旧部署记录', async () => {
      setUploadedRecord(await localJson<DeploymentSnapshot>(file));
      setMessage('已在本机读取 JSON；须通过已发布清单与链上核验。');
    });
  }
  async function readOldBundle(file: File | undefined) {
    if (!file) return;
    await run('读取旧编译产物', async () => {
      setUploadedGenesisBundle(await localJson<ArtifactBundle>(file));
      setMessage('已在本机读取 JSON；旧产物摘要和链上代码仍需核验。');
    });
  }
  async function verifyGenesis() {
    await run('核验旧链上图', async () => {
      if (!record || !oldBundle || !oldTrust.ok || !upgradeTrust.ok) throw new Error('旧部署及候选产物尚未通过可信来源检查。');
      const proof = await validateIntegratedUpgradeGenesisAgainstChain(rpcProvider(),
        {genesisRecord: record, genesisBundle: oldBundle, trustedGenesisManifest});
      setGenesisProof(proof);
      setMessage(`旧图已在最终确认区块 #${proof.blockNumber} 核验；第一笔部署前仍会重新核验。`);
    });
  }
  function createJournal() {
    if (!context || !oldTrust.ok || !upgradeTrust.ok || !genesisProof) return;
    try { save(newUpgradeJournal(context.expected, newSalt())); }
    catch (problem) { setError(messageOf(problem)); }
  }
  async function confirmDeployment(name: IntegratedReplacementName, tx: UpgradeTransaction, hash: string) {
    if (!record || !upgradeBundle || !journal) throw new Error('升级记录不可用。');
    const addresses = { ...record.addresses,
      ...Object.fromEntries(integratedUpgradeDeploymentOrder.map(item => [item, journal.deployments[item]?.address]).filter(([, value]) => !!value)) };
    const data = integratedUpgradeDeploymentData(name, upgradeBundle, addresses);
    if (tx.dataHash.toLowerCase() !== keccak256(data).toLowerCase()) {
      throw new Error('保存的交易字节码与当前候选合约产物不同。');
    }
    const receipt = await verifyUpgradeReceipt(receiptProvider(), hash, {from: tx.from, dataHash: tx.dataHash});
    if (!receipt) { setMessage('交易尚未确认；记录已保存。稍后使用“核对回执”继续。'); return; }
    if (!receipt.contractAddress) throw new Error('部署回执缺少合约地址。');
    if (!oldBundle) throw new Error('旧编译产物不可用。');
    const index = integratedUpgradeDeploymentOrder.indexOf(name);
    const deployments = Object.fromEntries(integratedUpgradeDeploymentOrder.slice(0,index)
      .map(item => [item,journal.deployments[item]?.address]).concat([[name,receipt.contractAddress]]));
    await validateIntegratedUpgradePartialReplacementsAgainstChain(rpcProvider(),{
      genesisRecord:record,genesisBundle:oldBundle,trustedGenesisManifest,upgradeBundle,
      trustedUpgradeArtifactDigest:__DEPLOYMENT_ARTIFACT_DIGEST__,deployments,
    });
    save({ ...journal, deployments: { ...journal.deployments, [name]: {
      ...tx, status: 'confirmed', txHash: hash, address: getAddress(receipt.contractAddress),
    } } });
    setMessage(`${name} 已上链；完整运行代码和链接关系将在批次核验时再次逐项检查。`);
  }
  async function deployReplacement(name: IntegratedReplacementName) {
    await run(`部署 ${name}`, async () => {
      if (!wallet || !account || !onBsc || !record || !oldBundle || !upgradeBundle || !journal
        || !oldTrust.ok || !upgradeTrust.ok || !genesisProof || pendingName || name !== nextName) {
        throw new Error('部署步骤或钱包未准备好，或者上一笔交易尚未核对。');
      }
      const prior = Object.fromEntries(integratedUpgradeDeploymentOrder.slice(0,
        integratedUpgradeDeploymentOrder.indexOf(name)).map(item => [item,journal.deployments[item]?.address]));
      await validateIntegratedUpgradePartialReplacementsAgainstChain(rpcProvider(),{
        genesisRecord:record,genesisBundle:oldBundle,trustedGenesisManifest,upgradeBundle,
        trustedUpgradeArtifactDigest:__DEPLOYMENT_ARTIFACT_DIGEST__,deployments:prior,
      });
      const addresses = { ...record.addresses,
        ...Object.fromEntries(integratedUpgradeDeploymentOrder.map(item => [item, journal.deployments[item]?.address]).filter(([, value]) => !!value)) };
      const data = integratedUpgradeDeploymentData(name, upgradeBundle, addresses);
      await exclusiveSend(async () => {
        const tx: UpgradeTransaction = {status:'uncertain', from: account, dataHash: keccak256(data)};
        save({...journal, deployments:{...journal.deployments,[name]:tx}});
        let hash: string;
        try { hash = await sendUpgradeTransaction(wallet, {from:account, data}); }
        catch (problem) {
          if (!(problem instanceof UncertainUpgradeSubmission)) {
            save({...journal, deployments:{...journal.deployments,[name]:undefined as never}});
          }
          throw problem;
        }
        const submitted = {...tx,status:'submitted' as const,txHash:hash};
        save({...journal,deployments:{...journal.deployments,[name]:submitted}});
        setMessage(`已记录 ${name} 交易 ${hash}。请核对链上回执后继续。`);
      });
    });
  }
  async function recoverDeployment(name: IntegratedReplacementName) {
    await run(`核对 ${name} 回执`, async () => {
      if (!journal) throw new Error('升级记录不可用。');
      const tx = journal.deployments[name];
      if (!tx || tx.status === 'confirmed') throw new Error('没有待核对的交易。');
      const hash = tx.txHash || recoveryHash.trim();
      if (!hash) throw new Error('请输入钱包中该笔交易的完整哈希。');
      await confirmDeployment(name, tx, hash);
      setRecoveryHash('');
    });
  }

  async function refreshOperation(upgradePlan = plan): Promise<ChainOperation> {
    if (!upgradePlan || !record) return 'unknown';
    const rpc = rpcProvider();
    const lock = new Contract(record.addresses.timelock, timelockAbi, rpc);
    const [exists, ready, done, timestamp] = await Promise.all([
      lock.isOperation(upgradePlan.operationId) as Promise<boolean>,
      lock.isOperationReady(upgradePlan.operationId) as Promise<boolean>,
      lock.isOperationDone(upgradePlan.operationId) as Promise<boolean>,
      lock.getTimestamp(upgradePlan.operationId) as Promise<bigint>,
    ]);
    const status: ChainOperation = done ? 'done' : !exists ? 'unscheduled' : ready ? 'ready' : 'waiting';
    setOperation(status);
    setReadyAt(exists && !done ? Number(timestamp) : null);
    return status;
  }
  async function verifyPlan() {
    await run('核验升级批次', async () => {
      if (!plan || !record || !oldBundle || !upgradeBundle || !account || !onBsc) {
        throw new Error('需完成全部新实现部署并连接 BSC 主网管理钱包。');
      }
      const proof = await validateIntegratedUpgradePlanAgainstChain(rpcProvider(), plan, {
        genesisRecord:record, genesisBundle:oldBundle, trustedGenesisManifest,
        upgradeBundle, trustedUpgradeArtifactDigest:__DEPLOYMENT_ARTIFACT_DIGEST__, proposer:account,
      });
      setPlanProof(proof);
      if (!journal) throw new Error('本机升级记录不可用。');
      await refreshOperation(plan);
      setMessage(`批次已在最终确认区块 #${proof.blockNumber} 核验；签名前会重新核验。`);
    });
  }
  async function sendBatch(which: 'schedule' | 'execute') {
    await run(which === 'schedule' ? '提交 48 小时提案' : '执行已等待的升级', async () => {
      if (!wallet || !account || !onBsc || !plan || !record || !oldBundle || !upgradeBundle || !journal
        || !reviewed || (which === 'schedule' && !planProof)
        || (which === 'execute' && (!journal.preExecutionPreflight || journal.schedule?.status !== 'confirmed'))
        || journal[which]) {
        throw new Error('钱包、批次核验、人工审阅或交易记录未就绪。');
      }
      // No eth_call simulation or estimateGas: only canonical state and code checks.
      let scheduledProof: (IntegratedUpgradePreflight & {phase: 'scheduled'}) | undefined;
      if (which === 'schedule') {
        await validateIntegratedUpgradePlanAgainstChain(rpcProvider(), plan, {
          genesisRecord:record, genesisBundle:oldBundle, trustedGenesisManifest,
          upgradeBundle, trustedUpgradeArtifactDigest:__DEPLOYMENT_ARTIFACT_DIGEST__, proposer:account,
        });
      } else {
        scheduledProof = await validateIntegratedUpgradeScheduledAgainstChain(rpcProvider(),plan,{
          genesisRecord:record,genesisBundle:oldBundle,trustedGenesisManifest,upgradeBundle,
          trustedUpgradeArtifactDigest:__DEPLOYMENT_ARTIFACT_DIGEST__,proposer:account,
        });
        const status = await refreshOperation(plan);
        if (status !== 'ready') throw new Error('时间锁尚未进入可执行状态，请刷新链上状态。');
      }
      const data = which === 'schedule' ? plan.scheduleData : plan.executeData;
      const tx: UpgradeTransaction = {status:'uncertain',from:account,dataHash:keccak256(data)};
      const currentJournal = scheduledProof ? {...journal,preExecutionPreflight:scheduledProof} : journal;
      await exclusiveSend(async () => {
        save({...currentJournal,[which]:tx});
        let hash: string;
        try { hash = await sendUpgradeTransaction(wallet,{from:account,to:record.addresses.timelock,data}); }
        catch (problem) {
          if (!(problem instanceof UncertainUpgradeSubmission)) save({...currentJournal,[which]:undefined});
          throw problem;
        }
        save({...currentJournal,[which]:{...tx,status:'submitted',txHash:hash}});
        setMessage(`已记录时间锁交易 ${hash}。请核对回执与批次状态。`);
      });
    });
  }
  async function recoverBatch(which: 'schedule' | 'execute') {
    await run('核对时间锁交易', async () => {
      if (!journal || !plan || !record) throw new Error('升级记录不可用。');
      const tx = journal[which];
      if (!tx || tx.status === 'confirmed') throw new Error('没有待核对的时间锁交易。');
      const hash = tx.txHash || recoveryHash.trim();
      if (!hash) throw new Error('请输入钱包中的完整交易哈希。');
      const data = which === 'schedule' ? plan.scheduleData : plan.executeData;
      const receipt = await verifyUpgradeReceipt(receiptProvider(),hash,
        {from:tx.from,to:record.addresses.timelock,dataHash:keccak256(data)});
      if (!receipt) { setMessage('时间锁交易尚未在规范链确认，请稍后核对。'); return; }
      const current = {...journal,[which]:{...tx,status:'confirmed' as const,txHash:hash}};
      save(current);
      await refreshOperation(plan);
      setRecoveryHash('');
      setMessage(which === 'schedule' ? '升级批次已提交；等待至少 48 小时。' : '升级批次交易已确认，仍须完成后置图与角色迁移核验。');
    });
  }
  async function verifyResult() {
    await run('核验升级后置图', async () => {
      if (!plan || !record || !oldBundle || !upgradeBundle || !journal
        || !journal.preExecutionPreflight || journal.schedule?.status !== 'confirmed'
        || journal.execute?.status !== 'confirmed' || !journal.schedule.txHash || !journal.execute.txHash) {
        throw new Error('需先保存升级前快照及最终确认的 schedule/execute 交易。');
      }
      const proof = await validateIntegratedUpgradeResultAgainstChain(receiptProvider(),plan,{
        genesisRecord:record,genesisBundle:oldBundle,trustedGenesisManifest,upgradeBundle,
        trustedUpgradeArtifactDigest:__DEPLOYMENT_ARTIFACT_DIGEST__,
        preExecutionPreflight:journal.preExecutionPreflight,
        scheduleTxHash:journal.schedule.txHash,executeTxHash:journal.execute.txHash,
      });
      save({...journal,postProof:proof});
      setResultProof(proof);
      setMessage(`代码升级后置图已在最终确认区块 #${proof.blockNumber} 核验；权限迁移仍待完成。`);
    });
  }

  const deployed = journal ? integratedUpgradeDeploymentOrder.filter(name => journal.deployments[name]?.status === 'confirmed').length : 0;
  const allDeployed = !!journal && deployed === integratedUpgradeDeploymentOrder.length;
  const canDeploy = onBsc && oldTrust.ok && upgradeTrust.ok && !!genesisProof && !!journal && !pendingName && !busy;
  const stageTwoConfig = useMemo(() => {
    if (!record || !hardwareWalletInput || !gasWalletInput) return {value:null,reason:''};
    try { return {value:stageTwoAddresses(hardwareWalletInput,gasWalletInput,{
      timelock:record.addresses.timelock,factory:record.addresses.factory,
      portfolioFactory:record.addresses.portfolioFactory,oldOwner:record.input.ownerMultisig,
    }),reason:''}; }
    catch (problem) { return {value:null,reason:messageOf(problem)}; }
  }, [record,hardwareWalletInput,gasWalletInput]);
  const treasuryPlan = useMemo(() => {
    if (!resultProof || !record || !stageTwoConfig.value || !authorityAddress || !migrationSalt) return {plan:null,reason:''};
    try { return {plan:buildIntegratedTreasuryMigrationPlan({genesisRecord:record,codeResult:resultProof,
      authorityAddress,saltSeed:migrationSalt,delaySeconds:172800}),reason:''}; }
    catch (problem) { return {plan:null,reason:messageOf(problem)}; }
  }, [record,resultProof,stageTwoConfig.value,authorityAddress,migrationSalt]);

  return <div className="upgrade-page">
    <section className="card upgrade-intro">
      <div><h2>集成版合约升级</h2><p>页面按固定依赖顺序部署新库与实现，再提交一个不可拆分的 48 小时时间锁批次。所有操作均由连接的管理钱包在 BSC 主网签署；请在钱包设备上核对交易。本页不会请求私钥。</p><p className="upgrade-stage-warning">第二阶段正在接入 PlatformAuthority、角色和旧池金库迁移的链上预检。核验接口完成前签署保持锁定；代码升级完成也不能切换正式产品清单。</p></div>
      <span className="upgrade-state"><LockKeyhole size={14}/>主网 · 单批次时间锁</span>
    </section>
    <section className="card">
      <div className="card-heading"><div><ShieldCheck size={19}/><h2>1. 核对旧部署与候选代码</h2></div><span className="subtle-tag">只读</span></div>
      <div className="upgrade-section">
        <p>旧版本以当前产品已发布清单作为固定参照。导入文件只在浏览器本机读取，不上传；旧地址、初始化交易和每个运行代码哈希必须匹配链上。新产物必须等于本页面独立编译摘要。</p>
        <div className="upgrade-file-row"><div><b>旧部署完整记录</b><small>{record ? `记录 ${record.id} · ${record.status} · ${record.addresses.factory || '地址缺失'}` : '从原部署台导出的完整记录 JSON'}</small><input type="file" accept=".json,application/json" aria-label="导入旧部署完整记录" onChange={event => void readOldRecord(event.target.files?.[0])}/></div><span className="upgrade-state">{record ? '已读取' : '待导入'}</span></div>
        <div className="upgrade-file-row"><div><b>旧部署编译产物</b><small>{oldBundle ? artifactDigest(oldBundle) : '导入原版本 deployment-artifacts.json'}</small><input type="file" accept=".json,application/json" aria-label="导入旧部署编译产物" onChange={event => void readOldBundle(event.target.files?.[0])}/></div><span className="upgrade-state">{oldBundle ? '已读取' : '待导入'}</span></div>
        <div className="upgrade-meta"><div><span>旧图与已发布清单</span><b>{oldTrust.ok ? '地址、交易、源码、代码哈希一致' : oldTrust.reason}</b></div><div><span>候选产物</span><b>{upgradeTrust.ok ? '独立构建摘要一致' : upgradeTrust.reason}</b></div><div><span>旧链上图</span><b>{genesisProof ? `已核验 #${genesisProof.blockNumber}` : '尚未核验'}</b></div></div>
        <div className="upgrade-actions"><button className="small-button" disabled={!oldTrust.ok || !upgradeTrust.ok || !!busy} onClick={() => void verifyGenesis()}><RefreshCw size={14}/>{busy || '读取并核验旧链上图'}</button>{genesisProof && !journal && <button className="small-button" onClick={createJournal}>建立本机升级记录</button>}</div>
      </div>
    </section>
    <section className="card">
      <div className="card-heading"><div><Wallet size={19}/><h2>2. 用管理钱包部署新库与实现</h2></div><span className="subtle-tag">{deployed} / {integratedUpgradeDeploymentOrder.length}</span></div>
      <div className="upgrade-section">
        <p>每笔部署地址及交易哈希会保存在本机记录。刷新后逐笔核对链上回执；只有前一项已确认，下一项才会开放。钱包会自行显示 Gas 费用。</p>
        {!wallet ? <div className="upgrade-actions"><button className="small-button" onClick={onConnect}><Wallet size={14}/>连接部署钱包</button></div> : !onBsc ? <div className="upgrade-alert note">请把钱包切换到 BSC 主网（Chain ID 56）。</div> : null}
        <ol className="upgrade-step-list">{integratedUpgradeDeploymentOrder.map((name,index) => {
          const tx = journal?.deployments[name];
          const mayDeploy = canDeploy && name === nextName && !tx;
          return <li className="upgrade-step" key={name}><span className="upgrade-step-index">{tx?.status === 'confirmed' ? <Check size={15}/> : index + 1}</span><div><b>{name}</b><small>{tx?.status === 'confirmed' ? `已确认 ${tx.address}` : tx?.status === 'submitted' ? '交易已提交，等待链上回执' : tx?.status === 'uncertain' ? '发送结果不确定，禁止重复发送' : '待部署'}</small>{tx?.txHash && <a className="upgrade-code" href={`${explorer}/tx/${tx.txHash}`} target="_blank" rel="noreferrer">{short(tx.txHash)} <ArrowUpRight size={12}/></a>}{tx?.status === 'uncertain' && !tx.txHash && name === pendingName && <input className="upgrade-step-input" value={recoveryHash} placeholder="输入钱包中该笔交易的完整哈希" onChange={event => setRecoveryHash(event.target.value)}/>}</div>{tx && tx.status !== 'confirmed' ? <button className="small-button" disabled={!!busy} onClick={() => void recoverDeployment(name)}>核对回执</button> : <button className="small-button" disabled={!mayDeploy} onClick={() => void deployReplacement(name)}>发送部署交易</button>}</li>;
        })}</ol>
      </div>
    </section>
    <section className="card">
      <div className="card-heading"><div><LockKeyhole size={19}/><h2>3. 原子时间锁批次</h2></div><span className="subtle-tag">一个 scheduleBatch</span></div>
      <div className="upgrade-section">
        <p>六个代理/Beacon 升级调用必须在同一批次内安排和执行，金额均为 0 BNB。固定 salt、前置操作及操作 ID 可供钱包逐字核对。</p>
        {journal && <div className="upgrade-meta"><div><span>等待时间</span><b><input type="number" min={172800} step={3600} value={journal.delaySeconds} disabled={!!journal.schedule || !!busy} onChange={event => { const delaySeconds = Number(event.target.value); if (Number.isSafeInteger(delaySeconds) && delaySeconds >= 172800) save({...journal,delaySeconds}); }}/></b></div><div><span>Salt</span><b className="upgrade-code">{journal.salt}</b></div><div><span>Operation ID</span><b className="upgrade-code">{plan?.operationId || '待全部实现确认'}</b></div></div>}
        {plan && <><div className="upgrade-batch"><div><span>调用</span><span>链上目标</span><span>新实现</span></div>{plan.steps.map(step => <div key={step.name}><strong>{step.name}</strong><code>{step.target}</code><code>{step.implementation}</code></div>)}</div><details className="upgrade-details"><summary>查看完整 targets、values、payloads 与钱包 calldata</summary><pre>{JSON.stringify({targets:plan.targets,values:plan.values,payloads:plan.payloads,predecessor:plan.predecessor,salt:plan.salt,delaySeconds:plan.delaySeconds,operationId:plan.operationId,scheduleData:plan.scheduleData,executeData:plan.executeData},null,2)}</pre></details><div className="upgrade-alert note">旧 PoolLens 地址与代码保持原样。其 <code>passed</code>、<code>requiredYesShares</code>、<code>canExecute</code> 仍反映旧的折价门槛，升级后治理判断须直接读取 Vault 与市场，不能用旧 Lens 证明。</div></>}
        {planState.reason && <div className="upgrade-alert error">{planState.reason}</div>}
        <div className="upgrade-actions"><button className="small-button" disabled={!allDeployed || !onBsc || !!busy} onClick={() => void verifyPlan()}><ShieldCheck size={14}/>{busy || '核验新实现与完整批次'}</button>{plan && <button className="small-button" disabled={!!busy} onClick={() => void run('读取时间锁状态', async () => { await refreshOperation(); })}><RefreshCw size={14}/>刷新时间锁状态</button>}</div>
        {planProof && <div className="upgrade-alert ok">链上代码、绑定关系、提案人角色、批次 ID 已在最终确认区块 #{planProof.blockNumber} 核验。</div>}
        {plan && <div className="upgrade-meta"><div><span>批次状态</span><b>{operation === 'unknown' ? '尚未读取' : operation === 'unscheduled' ? '未提交' : operation === 'waiting' ? '等待中' : operation === 'ready' ? '可执行' : '已执行'}</b></div><div><span>最早执行</span><b>{readyAt ? new Date(readyAt * 1000).toLocaleString('zh-CN') : '—'}</b></div><div><span>批次交易</span><b>{journal?.schedule?.txHash ? short(journal.schedule.txHash) : '—'}</b></div></div>}
        <label className="upgrade-ack"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)}/><span>我已核对六笔调用目标、新实现、0 BNB 金额、salt 与 operation ID；明白代码升级和后续权限迁移是两个阶段。</span></label>
        <div className="upgrade-actions"><button className="primary-button" disabled={!plan || !planProof || !onBsc || !reviewed || !!journal?.schedule || operation !== 'unscheduled' || !!busy} onClick={() => void sendBatch('schedule')}>提交 48 小时提案</button><button className="primary-button" disabled={!plan || !onBsc || !reviewed || journal?.schedule?.status !== 'confirmed' || !!journal?.execute || operation !== 'ready' || !!busy} onClick={() => void sendBatch('execute')}>等待结束后执行批次</button></div>
        {journal?.schedule && journal.schedule.status !== 'confirmed' && <div className="upgrade-actions"><input className="upgrade-step-input" value={recoveryHash} placeholder="如未收到哈希，请输入钱包中的原交易哈希" onChange={event => setRecoveryHash(event.target.value)}/><button className="small-button" disabled={!!busy} onClick={() => void recoverBatch('schedule')}>核对提案交易</button></div>}
        {journal?.execute && journal.execute.status !== 'confirmed' && <div className="upgrade-actions"><input className="upgrade-step-input" value={recoveryHash} placeholder="如未收到哈希，请输入钱包中的原交易哈希" onChange={event => setRecoveryHash(event.target.value)}/><button className="small-button" disabled={!!busy} onClick={() => void recoverBatch('execute')}>核对执行交易</button></div>}
        {journal?.execute?.status === 'confirmed' && <div className="upgrade-alert note">升级交易已确认，仍须核验后置合约图与全部角色迁移；当前不能标记正式开放。</div>}
      </div>
    </section>
    <section className="card">
      <div className="card-heading"><div><ShieldCheck size={19}/><h2>4. 后置图与权限迁移</h2></div><span className="subtle-tag">独立阶段</span></div>
      <div className="upgrade-section">
        <p>代码升级与角色接线分别验收。旧矿池的金库地址在创建时写入，Factory 金库变更不会改变现有池；原金库已产生的应收费用仍归原地址。</p>
        <div className="upgrade-meta">
          <div><span>代码升级</span><b>{resultProof ? `本次已核验 #${resultProof.blockNumber}` : journal?.execute?.status === 'confirmed' ? '交易已执行，等待后置图证明' : '未完成'}</b></div>
          <div><span>PlatformAuthority 与双管理员</span><b>待独立部署与核验</b></div>
          <div><span>角色接线</span><b>待旧 owner / Timelock 授权迁移</b></div>
          <div><span>旧池金库</span><b>{resultProof ? `${resultProof.legacyTreasuryResidual.length} 个历史池待逐一处理` : '待后置图枚举'}</b></div>
        </div>
        <div className="upgrade-migration-preview">
          <b>第二阶段公开地址 · 待链上核验</b>
          <p>硬件钱包只用于部署、升级权限；Gas 钱包只用于后台代付。这里仅填写公开地址，不接受私钥或助记词。Gas 地址须与受保护服务配置或你已核对的公开地址一致。</p>
          <div className="upgrade-config-grid">
            <label>目标硬件钱包地址<input className="upgrade-step-input" value={hardwareWalletInput} placeholder="0x…  · 新 owner / proposer / canceller" onChange={event => setHardwareWalletInput(event.target.value)} autoComplete="off" spellCheck={false}/></label>
            <label>后台 Gas 钱包公开地址<input className="upgrade-step-input" value={gasWalletInput} placeholder="0x…  · 代付钱包" onChange={event => setGasWalletInput(event.target.value)} autoComplete="off" spellCheck={false}/></label>
          </div>
          {stageTwoConfig.reason && <div className="upgrade-alert error">{stageTwoConfig.reason}</div>}
          <div className="upgrade-meta">
            <div><span>当前 Factory owner</span><b className="upgrade-code">{record?.input.ownerMultisig || '待核对旧图'}</b></div>
            <div><span>管理员一</span><b className="upgrade-code">{authorityAdministrators[0]}</b></div>
            <div><span>管理员二</span><b className="upgrade-code">{authorityAdministrators[1]}</b></div>
          </div>
          {stageTwoConfig.value && <div className="upgrade-alert note">公开地址格式已核对；Authority 构造参数、完整运行代码、服务 Gas 配置及当前链上角色尚未验证，不能据此发交易。</div>}
        </div>
        {journal?.execute?.status === 'confirmed' && <div className="upgrade-actions"><button className="small-button" disabled={!!busy} onClick={() => void verifyResult()}><ShieldCheck size={14}/>核验最终链上图</button></div>}
        {resultProof && <div className="upgrade-alert ok">六个目标及十个新库/实现均已在最终确认区块核对；此证明只覆盖代码升级。</div>}
        <ol className="upgrade-handoff">
          <li><b>部署并核验 PlatformAuthority</b><span>构造参数绑定两套 Factory、两位已指定管理员和公开 Gas 地址；部署回执、完整代码及构造后配置均须核验。</span><em>待预检</em></li>
          <li><b>迁移两套 Factory 权限</b><span>由旧 owner 对两套 Factory 分别设置 operator、treasury 为 Authority，再转移 owner 到硬件钱包；每笔重新读取当前 owner 和目标。</span><em>待预检</em></li>
          <li><b>迁移 Timelock 角色</b><span>先授予新硬件钱包 proposer/canceller，再撤旧地址；分别核对提案人、执行人和 Timelock 管理权限。</span><em>待预检</em></li>
          <li><b>单独迁移历史池金库</b><span>逐池使用独立 48 小时 Timelock 提案；合约在迁移前结算挖矿收益，旧金库已入账欠款仍归旧地址。</span><em>待预检</em></li>
        </ol>
        {resultProof?.legacyTreasuryResidual.length ? <details className="upgrade-details"><summary>查看 {resultProof.legacyTreasuryResidual.length} 个历史池的旧金库</summary><pre>{JSON.stringify(resultProof.legacyTreasuryResidual,null,2)}</pre></details> : null}
        {resultProof && <div className="upgrade-migration-preview">
          <b>历史池金库迁移候选 · 只读预览</b>
          <p>输入已部署并通过链上核验的 PlatformAuthority 公开地址。此处只计算每池独立的 48 小时时间锁操作，不发交易；后续还需 Authority 代码与角色、旧池欠款的独立核验。</p>
          <div className="upgrade-actions"><input className="upgrade-step-input" aria-label="PlatformAuthority 候选地址" value={authorityAddress} placeholder="PlatformAuthority 合约地址 0x…" onChange={event => setAuthorityAddress(event.target.value)}/><button className="small-button" onClick={() => setMigrationSalt(newSalt())}>生成迁移 salt</button></div>
          {treasuryPlan.reason && <div className="upgrade-alert error">{treasuryPlan.reason}</div>}
          {treasuryPlan.plan && <><div className="upgrade-alert note">候选操作 {treasuryPlan.plan.operations.length} 笔。以下数据尚未通过第二阶段链上预检，不能签署。</div><details className="upgrade-details"><summary>查看每池 operation ID 与完整 calldata</summary><pre>{JSON.stringify(treasuryPlan.plan,null,2)}</pre></details></>}
        </div>}
        <div className="upgrade-alert note">权限迁移尚无完整链上预检与交易入口，页面保持阻断。未完成迁移前不能切换正式产品清单或宣称全部部署完成。</div>
        {plan && journal && <div className="upgrade-actions"><button className="small-button" onClick={() => download(`pinkuang-upgrade-${plan.operationId}.json`,{plan,journal,genesisProof,planProof,resultProof,treasuryCandidate:treasuryPlan.plan,roleMigration:'not-verified',productManifestSwitched:false})}><ArrowDownToLine size={14}/>导出当前升级证据</button><a className="small-button" target="_blank" rel="noreferrer" href={`${explorer}/address/${record?.addresses.timelock}`}><ExternalLink size={14}/>查看时间锁</a></div>}
      </div>
    </section>
    {message && <div className="upgrade-alert ok" role="status">{message}</div>}
    {error && <div className="upgrade-alert error" role="alert">{error}</div>}
  </div>;
}
