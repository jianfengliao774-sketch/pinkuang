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
  validateIntegratedUpgradePreparationAgainstChain,
  buildIntegratedProposerBootstrapPlan, validateIntegratedProposerBootstrapAgainstChain,
  integratedAuthorityDeploymentData, validateIntegratedPostCodeGraphAgainstChain,
  validateIntegratedAuthorityAgainstChain, buildIntegratedRoleMigrationPlan,
  validateIntegratedRoleMigrationStateAgainstChain, validateIntegratedRoleMigrationActionAgainstChain,
  validateIntegratedTreasuryMigrationActionAgainstChain,
  validateIntegratedTreasuryMigrationResultAgainstChain,
  validateIntegratedOnChainMigrationCompleteAgainstChain,
  type IntegratedUpgradePreflight, type IntegratedGenesisPreflight, type IntegratedUpgradeResult,
  type IntegratedReplacementName, type IntegratedReplacements,
  type IntegratedProposerBootstrapPlan, type IntegratedAuthorityProof,
  type IntegratedRoleMigrationPlan, type IntegratedRoleState,
  type IntegratedTreasuryMigrationPlan,
} from '../shared/integrated-upgrade-plan.mjs';
import { artifactDigest, validateArtifacts, type ArtifactBundle, type DeploymentSnapshot } from './deployment';
import { assertTrustedGenesis } from './upgrade-ui';
import { inspectPauseTargets, pauseCreationData, pauseFactoryNames, type PauseFactoryName,
  type PauseTargetProof } from './upgrade-pause';
import { authorityAdministrators, stageTwoAddresses } from './upgrade-stage2';
import {checkUpgradeExecutionRelease,initialUpgradeExecutionRelease,requireUpgradeExecutionRelease,
  type UpgradeExecutionRelease,type UpgradeReleaseInputs} from './upgrade-release';
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
  initialGenesisBundle?: ArtifactBundle | null;
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

export default function UpgradeConsole({wallet, account, chainId, currentBundle, currentRecord,
  initialGenesisBundle, onConnect}: Props) {
  const [uploadedRecord, setUploadedRecord] = useState<DeploymentSnapshot | null>(null);
  const [uploadedGenesisBundle, setUploadedGenesisBundle] = useState<ArtifactBundle | null>(null);
  const [journal, setJournal] = useState<UpgradeJournal | null>(null);
  const [pauseProof, setPauseProof] = useState<PauseTargetProof | null>(null);
  const [bootstrapProof, setBootstrapProof] = useState<Awaited<ReturnType<typeof validateIntegratedProposerBootstrapAgainstChain>> | null>(null);
  const [genesisProof, setGenesisProof] = useState<IntegratedGenesisPreflight | null>(null);
  const [planProof, setPlanProof] = useState<IntegratedUpgradePreflight | null>(null);
  const [resultProof, setResultProof] = useState<IntegratedUpgradeResult | null>(null);
  const [authorityProof, setAuthorityProof] = useState<IntegratedAuthorityProof | null>(null);
  const [roleState, setRoleState] = useState<IntegratedRoleState | null>(null);
  const [onChainComplete, setOnChainComplete] = useState(false);
  const [hardwareWalletInput, setHardwareWalletInput] = useState('');
  const [gasWalletInput, setGasWalletInput] = useState('');
  const [operation, setOperation] = useState<ChainOperation>('unknown');
  const [readyAt, setReadyAt] = useState<number | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [releaseGate, setReleaseGate] = useState<UpgradeExecutionRelease>(initialUpgradeExecutionRelease);
  const [recoveryHash, setRecoveryHash] = useState('');
  const [pauseRecoveryHash, setPauseRecoveryHash] = useState('');
  const [stageTwoRecoveryHash, setStageTwoRecoveryHash] = useState('');

  const record = uploadedRecord || currentRecord;
  const oldBundle = uploadedGenesisBundle || initialGenesisBundle || (currentBundle && record
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
    setPauseProof(null); setBootstrapProof(null); setGenesisProof(null); setPlanProof(null); setResultProof(null);
    setAuthorityProof(null); setRoleState(null); setOnChainComplete(false); setOperation('unknown'); setReviewed(false);
    if (!context) { setJournal(null); return; }
    try {
      const raw = localStorage.getItem(context.key);
      const restored = raw ? parseUpgradeJournal(JSON.parse(raw), context.expected) : null;
      setJournal(restored);
      if (restored?.bootstrap) setHardwareWalletInput(restored.bootstrap.hardwareWallet);
      if (restored?.authority) setGasWalletInput(restored.authority.gasWallet);
    } catch (problem) { setJournal(null); setError(messageOf(problem)); }
  }, [context]);
  useEffect(() => { setPauseProof(null); setGenesisProof(null); setPlanProof(null); setReviewed(false); }, [account, chainId]);

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
  const bootstrapPlanState = useMemo(() => {
    if (!record || !oldBundle || !journal?.bootstrap || !oldTrust.ok) return {plan:null,reason:''};
    try { return {plan:buildIntegratedProposerBootstrapPlan({
      genesisRecord:record,genesisBundle:oldBundle,trustedGenesisManifest,
      hardwareWallet:journal.bootstrap.hardwareWallet,salt:journal.bootstrap.salt,
      delaySeconds:journal.bootstrap.delaySeconds,
    }),reason:''}; }
    catch (problem) { return {plan:null,reason:messageOf(problem)}; }
  }, [record,oldBundle,journal?.bootstrap,oldTrust.ok]);
  const bootstrapPlan = bootstrapPlanState.plan;
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
  const releaseInputs = useMemo<UpgradeReleaseInputs | null>(() => plan && bootstrapPlan && upgradeBundle
    && wallet && account && chainId === 56 && oldTrust.ok && upgradeTrust.ok ? {candidateBundle:upgradeBundle,
      candidateDigest:__DEPLOYMENT_ARTIFACT_DIGEST__,plan,bootstrapPlan,wallet} : null,
  [plan,bootstrapPlan,upgradeBundle,wallet,account,chainId,oldTrust.ok,upgradeTrust.ok]);
  useEffect(() => {
    setReleaseGate(initialUpgradeExecutionRelease);
    if (!releaseInputs) return;
    let active=true;
    void checkUpgradeExecutionRelease(releaseInputs).then(result => {
      if (active) setReleaseGate(result);
    });
    return () => { active=false; };
  }, [releaseInputs]);
  async function refreshReleaseGate() {
    if (!releaseInputs) { setReleaseGate(initialUpgradeExecutionRelease); return; }
    setReleaseGate(initialUpgradeExecutionRelease);
    setReleaseGate(await checkUpgradeExecutionRelease(releaseInputs));
  }
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
    if (!context || !oldTrust.ok || !upgradeTrust.ok) return;
    try { save(newUpgradeJournal(context.expected, newSalt())); }
    catch (problem) { setError(messageOf(problem)); }
  }
  async function readPauseTargets() {
    await run('读取建池暂停状态', async () => {
      if (!record || !oldBundle || !oldTrust.ok) throw new Error('旧部署记录尚未匹配已发布清单。');
      const trusted = assertTrustedGenesis(record,oldBundle,trustedGenesisManifest as never);
      const proof = await inspectPauseTargets(rpcProvider(),trusted,record.input.ownerMultisig);
      setPauseProof(proof);
      setMessage(`两套 Factory 已在最终确认区块 #${proof.blockNumber} 核对 owner、代码与建池状态。`);
    });
  }
  async function sendPause(name: PauseFactoryName) {
    await run(`暂停 ${name} 建池`, async () => {
      if (!wallet || !account || !onBsc || !record || !oldBundle || !journal || !oldTrust.ok
        || !upgradeTrust.ok || pendingPause) throw new Error('旧 owner 钱包、部署记录或暂停交易尚未就绪。');
      const preparation = await validateIntegratedUpgradePreparationAgainstChain(rpcProvider(),{
        genesisRecord:record,genesisBundle:oldBundle,trustedGenesisManifest,
        signer:account,nextPause:name === 'factory' ? 'core' : 'budget',
      });
      const trusted = assertTrustedGenesis(record,oldBundle,trustedGenesisManifest as never);
      const proof = await inspectPauseTargets(rpcProvider(),trusted,record.input.ownerMultisig);
      setPauseProof(proof);
      const target = proof.targets[name];
      if (getAddress(preparation.target) !== getAddress(target.address)
        || preparation.data !== pauseCreationData()) throw new Error('完整旧图预检的暂停目标或 calldata 不匹配。');
      if (getAddress(account) !== getAddress(target.owner)) throw new Error('只有链上当前旧 owner 钱包可以暂停建池。');
      if (target.paused) throw new Error(`${name} 已暂停，无须再次交易。`);
      const data = pauseCreationData();
      const tx: UpgradeTransaction = {status:'uncertain',from:account,dataHash:keccak256(data)};
      await exclusiveSend(async () => {
        save({...journal,pauses:{...journal.pauses,[name]:tx}});
        setGenesisProof(null);
        let hash: string;
        try { hash = await sendUpgradeTransaction(wallet,{from:account,to:target.address,data}); }
        catch (problem) {
          if (!(problem instanceof UncertainUpgradeSubmission)) {
            save({...journal,pauses:{...journal.pauses,[name]:undefined}});
          }
          throw problem;
        }
        save({...journal,pauses:{...journal.pauses,[name]:{...tx,status:'submitted',txHash:hash}}});
        setMessage(`${name} 暂停交易已记录；请核对最终确认回执。`);
      });
    });
  }
  async function recoverPause(name: PauseFactoryName) {
    await run(`核对 ${name} 暂停交易`, async () => {
      if (!journal || !record || !oldBundle) throw new Error('旧部署记录不可用。');
      const tx = journal.pauses?.[name];
      if (!tx || tx.status === 'confirmed') throw new Error('没有待核对的暂停交易。');
      const hash = tx.txHash || pauseRecoveryHash.trim();
      if (!hash) throw new Error('请输入钱包中该笔暂停交易的完整哈希。');
      const trusted = assertTrustedGenesis(record,oldBundle,trustedGenesisManifest as never);
      const target = getAddress(trusted[name] || '');
      const receipt = await verifyUpgradeReceipt(receiptProvider(),hash,
        {from:tx.from,to:target,dataHash:keccak256(pauseCreationData())});
      if (!receipt) { setMessage('暂停交易尚未最终确认，请稍后核对。'); return; }
      const proof = await inspectPauseTargets(rpcProvider(),trusted,record.input.ownerMultisig);
      if (!proof.targets[name].paused) throw new Error('交易已确认，但 Factory 当前仍未暂停；请检查链上状态。');
      save({...journal,pauses:{...journal.pauses,[name]:{...tx,status:'confirmed',txHash:hash}}});
      setPauseProof(proof); setPauseRecoveryHash(''); setGenesisProof(null);
      setMessage(`${name} 已在链上暂停建池。`);
    });
  }
  function createBootstrap() {
    if (!journal || !record || !oldBundle || !genesisProof || !hardwareWalletInput || !onBsc) return;
    try {
      const candidate = buildIntegratedProposerBootstrapPlan({genesisRecord:record,
        genesisBundle:oldBundle,trustedGenesisManifest,hardwareWallet:hardwareWalletInput,
        salt:newSalt(),delaySeconds:172800});
      save({...journal,bootstrap:{hardwareWallet:candidate.hardwareWallet,salt:candidate.salt,
        delaySeconds:candidate.delaySeconds}});
      setHardwareWalletInput(candidate.hardwareWallet); setBootstrapProof(null);
    } catch (problem) { setError(messageOf(problem)); }
  }
  async function verifyBootstrap(phase: 'unscheduled' | 'ready' | 'done') {
    if (!bootstrapPlan || !record || !oldBundle) throw new Error('硬件钱包角色授权计划尚未建立。');
    const proof = await validateIntegratedProposerBootstrapAgainstChain(rpcProvider(),bootstrapPlan,{
      genesisRecord:record,genesisBundle:oldBundle,trustedGenesisManifest,phase,
      ...(phase === 'done' ? {} : {signer:account || ''}),
    });
    setBootstrapProof(proof);
    return proof;
  }
  async function readBootstrapStatus() {
    await run('核验角色授权状态', async () => {
      if (!bootstrapPlan) throw new Error('硬件钱包角色授权计划尚未建立。');
      if (journal?.bootstrap?.schedule?.status === 'confirmed'
        && journal.bootstrap.execute?.status !== 'confirmed') {
        const lock = new Contract(bootstrapPlan.timelock, timelockAbi, rpcProvider());
        const [exists, ready, done, timestamp] = await Promise.all([
          lock.isOperation(bootstrapPlan.operationId) as Promise<boolean>,
          lock.isOperationReady(bootstrapPlan.operationId) as Promise<boolean>,
          lock.isOperationDone(bootstrapPlan.operationId) as Promise<boolean>,
          lock.getTimestamp(bootstrapPlan.operationId) as Promise<bigint>,
        ]);
        if (exists && !ready && !done && timestamp > 0n) {
          setBootstrapProof(null);
          setMessage(`角色授权仍在等待中，链上最早执行时间 ${new Date(Number(timestamp) * 1000).toLocaleString('zh-CN')}。这是状态预览，执行签署前仍会完整核验旧图及角色。`);
          return;
        }
      }
      const phase = journal?.bootstrap?.execute?.status === 'confirmed' ? 'done'
        : journal?.bootstrap?.schedule?.status === 'confirmed' ? 'ready' : 'unscheduled';
      const proof = await verifyBootstrap(phase);
      setMessage(`角色授权 ${proof.phase} · 最终确认区块 #${proof.blockNumber}`);
    });
  }
  async function sendBootstrap(which: 'schedule' | 'execute') {
    await run(which === 'schedule' ? '安排硬件钱包角色' : '执行硬件钱包角色授权',async () => {
      if (!wallet || !account || !onBsc || !journal?.bootstrap || !bootstrapPlan
        || journal.bootstrap[which]) throw new Error('钱包、角色计划或现有交易状态未就绪。');
      await verifyBootstrap(which === 'schedule' ? 'unscheduled' : 'ready');
      const data = which === 'schedule' ? bootstrapPlan.scheduleData : bootstrapPlan.executeData;
      const tx: UpgradeTransaction = {status:'uncertain',from:account,dataHash:keccak256(data)};
      await exclusiveSend(async () => {
        save({...journal,bootstrap:{...journal.bootstrap!,[which]:tx}});
        let hash: string;
        try { hash = await sendUpgradeTransaction(wallet,{from:account,to:bootstrapPlan.timelock,data}); }
        catch (problem) {
          if (!(problem instanceof UncertainUpgradeSubmission)) {
            save({...journal,bootstrap:{...journal.bootstrap!,[which]:undefined}});
          }
          throw problem;
        }
        save({...journal,bootstrap:{...journal.bootstrap!,[which]:{...tx,status:'submitted',txHash:hash}}});
        setMessage(`硬件钱包角色 ${which === 'schedule' ? '提案' : '执行'}交易已提交，请核对回执。`);
      });
    });
  }
  async function recoverBootstrap(which: 'schedule' | 'execute') {
    await run('核对硬件钱包角色交易',async () => {
      if (!journal?.bootstrap || !bootstrapPlan) throw new Error('角色授权记录不可用。');
      const tx = journal.bootstrap[which];
      if (!tx || tx.status === 'confirmed') throw new Error('没有待核对的角色授权交易。');
      const hash = tx.txHash || recoveryHash.trim();
      if (!hash) throw new Error('请输入钱包中原交易的完整哈希。');
      const data = which === 'schedule' ? bootstrapPlan.scheduleData : bootstrapPlan.executeData;
      if (tx.dataHash.toLowerCase() !== keccak256(data).toLowerCase()) throw new Error('记录的角色授权 calldata 已改变。');
      const receipt = await verifyUpgradeReceipt(receiptProvider(),hash,
        {from:tx.from,to:bootstrapPlan.timelock,dataHash:tx.dataHash});
      if (!receipt) { setMessage('角色授权交易尚未最终确认，请稍后核对。'); return; }
      if (which === 'execute') await verifyBootstrap('done');
      save({...journal,bootstrap:{...journal.bootstrap,[which]:{...tx,status:'confirmed',txHash:hash}}});
      setRecoveryHash('');
      setMessage(which === 'schedule' ? '角色授权已安排，至少等待 48 小时。' : '硬件钱包 proposer/canceller 已由链上确认。');
    });
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
        || !oldTrust.ok || !upgradeTrust.ok || !genesisProof || pendingName || name !== nextName
        || !bootstrapPlan || journal.bootstrap?.execute?.status !== 'confirmed'
        || getAddress(account) !== getAddress(bootstrapPlan.hardwareWallet)) {
        throw new Error('部署步骤或钱包未准备好，或者上一笔交易尚未核对。');
      }
      await verifyBootstrap('done');
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
      if (!plan || !record || !oldBundle || !upgradeBundle || !account || !onBsc || !bootstrapPlan) {
        throw new Error('需完成全部新实现部署并连接 BSC 主网管理钱包。');
      }
      const proof = await validateIntegratedUpgradePlanAgainstChain(rpcProvider(), plan, {
        genesisRecord:record, genesisBundle:oldBundle, trustedGenesisManifest,
        upgradeBundle, trustedUpgradeArtifactDigest:__DEPLOYMENT_ARTIFACT_DIGEST__, proposer:account,bootstrapPlan,
      });
      setPlanProof(proof);
      if (!journal) throw new Error('本机升级记录不可用。');
      await refreshOperation(plan);
      setMessage(`批次已在最终确认区块 #${proof.blockNumber} 核验；签名前会重新核验。`);
    });
  }
  async function sendBatch(which: 'schedule' | 'execute') {
    await run(which === 'schedule' ? '提交 48 小时提案' : '执行已等待的升级', async () => {
      // The Timelock executor is open: once scheduled, anyone can execute the
      // batch at maturity. Lock scheduling as well as this page's execute button.
      if (!releaseInputs) throw new Error('生产双图发布尚未核验，禁止签署升级批次。');
      if (!wallet || !account || !onBsc || !plan || !record || !oldBundle || !upgradeBundle || !journal || !bootstrapPlan
        || !reviewed || (which === 'schedule' && !planProof)
        || (which === 'execute' && journal.schedule?.status !== 'confirmed')
        || journal[which]) {
        throw new Error('钱包、批次核验、人工审阅或交易记录未就绪。');
      }
      // No eth_call simulation or estimateGas: only canonical state and code checks.
      let scheduledProof: (IntegratedUpgradePreflight & {phase: 'scheduled'}) | undefined;
      if (which === 'schedule') {
        await validateIntegratedUpgradePlanAgainstChain(rpcProvider(), plan, {
          genesisRecord:record, genesisBundle:oldBundle, trustedGenesisManifest,
          upgradeBundle, trustedUpgradeArtifactDigest:__DEPLOYMENT_ARTIFACT_DIGEST__, proposer:account,bootstrapPlan,
        });
      } else {
        scheduledProof = await validateIntegratedUpgradeScheduledAgainstChain(rpcProvider(),plan,{
          genesisRecord:record,genesisBundle:oldBundle,trustedGenesisManifest,upgradeBundle,
          trustedUpgradeArtifactDigest:__DEPLOYMENT_ARTIFACT_DIGEST__,proposer:account,bootstrapPlan,
        });
        const status = await refreshOperation(plan);
        if (status !== 'ready') throw new Error('时间锁尚未进入可执行状态，请刷新链上状态。');
      }
      const data = which === 'schedule' ? plan.scheduleData : plan.executeData;
      const tx: UpgradeTransaction = {status:'uncertain',from:account,dataHash:keccak256(data)};
      const currentJournal = scheduledProof ? {...journal,preExecutionPreflight:scheduledProof} : journal;
      await exclusiveSend(async () => {
        await requireUpgradeExecutionRelease(releaseInputs);
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

  function stageTwoBase() {
    if (!plan || !bootstrapPlan || !record || !oldBundle || !upgradeBundle || !resultProof
      || !journal?.authority?.deployment?.address || !journal.authority.deployment.txHash
      || journal.authority.deployment.status !== 'confirmed' || !stageTwoConfig.value
      || getAddress(stageTwoConfig.value.hardwareWallet) !== getAddress(bootstrapPlan.hardwareWallet)
      || getAddress(journal.authority.hardwareWallet) !== getAddress(bootstrapPlan.hardwareWallet)
      || getAddress(journal.authority.gasWallet) !== getAddress(stageTwoConfig.value.gasWallet)) {
      throw new Error('代码升级证明、硬件钱包或已核验 Authority 部署记录尚未就绪。');
    }
    return {codePlan:plan,bootstrapPlan,genesisRecord:record,genesisBundle:oldBundle,
      trustedGenesisManifest,upgradeBundle,trustedUpgradeArtifactDigest:__DEPLOYMENT_ARTIFACT_DIGEST__,
      authorityAddress:journal.authority.deployment.address,
      deploymentTxHash:journal.authority.deployment.txHash,
      administratorOne:authorityAdministrators[0],administratorTwo:authorityAdministrators[1],
      gasWallet:stageTwoConfig.value.gasWallet};
  }
  async function deployAuthority() {
    await run('部署 PlatformAuthority', async () => {
      if (!wallet || !account || !onBsc || !record || !oldBundle || !upgradeBundle || !plan
        || !resultProof || !journal || !stageTwoConfig.value || journal.authority
        || !bootstrapPlan || getAddress(account) !== getAddress(bootstrapPlan.hardwareWallet)
        || getAddress(stageTwoConfig.value.hardwareWallet) !== getAddress(bootstrapPlan.hardwareWallet)) {
        throw new Error('须完成代码升级后置证明并连接已授权的硬件钱包。');
      }
      await validateIntegratedPostCodeGraphAgainstChain(rpcProvider(),plan,{
        genesisRecord:record,genesisBundle:oldBundle,trustedGenesisManifest,upgradeBundle,
        trustedUpgradeArtifactDigest:__DEPLOYMENT_ARTIFACT_DIGEST__,
      });
      const data=integratedAuthorityDeploymentData({genesisRecord:record,genesisBundle:oldBundle,
        trustedGenesisManifest,upgradeBundle,trustedUpgradeArtifactDigest:__DEPLOYMENT_ARTIFACT_DIGEST__,
        administratorOne:authorityAdministrators[0],administratorTwo:authorityAdministrators[1],
        gasWallet:stageTwoConfig.value.gasWallet});
      const tx:UpgradeTransaction={status:'uncertain',from:account,dataHash:keccak256(data)};
      const authority={hardwareWallet:bootstrapPlan.hardwareWallet,gasWallet:stageTwoConfig.value.gasWallet,deployment:tx};
      await exclusiveSend(async () => {
        save({...journal,authority});
        let hash:string;
        try { hash=await sendUpgradeTransaction(wallet,{from:account,data}); }
        catch (problem) {
          if (!(problem instanceof UncertainUpgradeSubmission)) save({...journal,authority:undefined});
          throw problem;
        }
        save({...journal,authority:{...authority,deployment:{...tx,status:'submitted',txHash:hash}}});
        setMessage('Authority 部署交易已记录；请核对最终确认回执与构造状态。');
      });
    });
  }
  async function verifyAuthority() {
    const base=stageTwoBase();
    const proof=await validateIntegratedAuthorityAgainstChain(receiptProvider(),base);
    setAuthorityProof(proof);
    return proof;
  }
  async function recoverAuthority() {
    await run('核验 PlatformAuthority 回执',async () => {
      if (!record || !oldBundle || !upgradeBundle || !plan || !journal?.authority?.deployment
        || !bootstrapPlan || !stageTwoConfig.value) throw new Error('Authority 部署记录不完整。');
      const tx=journal.authority.deployment;
      const hash=tx.txHash || stageTwoRecoveryHash.trim();
      if (!hash) throw new Error('请输入原部署交易哈希。');
      const data=integratedAuthorityDeploymentData({genesisRecord:record,genesisBundle:oldBundle,
        trustedGenesisManifest,upgradeBundle,trustedUpgradeArtifactDigest:__DEPLOYMENT_ARTIFACT_DIGEST__,
        administratorOne:authorityAdministrators[0],administratorTwo:authorityAdministrators[1],
        gasWallet:journal.authority.gasWallet});
      if (tx.dataHash.toLowerCase()!==keccak256(data).toLowerCase()) throw new Error('Authority 构造字节码已变化。');
      const receipt=await verifyUpgradeReceipt(receiptProvider(),hash,{from:tx.from,dataHash:tx.dataHash});
      if (!receipt) {setMessage('部署交易尚未最终确认。');return;}
      if (!receipt.contractAddress) throw new Error('部署回执缺少 Authority 地址。');
      const proof=await validateIntegratedAuthorityAgainstChain(receiptProvider(),{
        codePlan:plan,genesisRecord:record,genesisBundle:oldBundle,trustedGenesisManifest,upgradeBundle,
        trustedUpgradeArtifactDigest:__DEPLOYMENT_ARTIFACT_DIGEST__,
        authorityAddress:receipt.contractAddress,deploymentTxHash:hash,
        administratorOne:authorityAdministrators[0],administratorTwo:authorityAdministrators[1],
        gasWallet:journal.authority.gasWallet,
      });
      save({...journal,authority:{...journal.authority,deployment:{...tx,status:'confirmed',txHash:hash,
        address:getAddress(receipt.contractAddress)}}});
      setAuthorityProof(proof);setStageTwoRecoveryHash('');
      setMessage(`Authority 已在最终确认区块 #${proof.blockNumber} 核验。`);
    });
  }
  function createRolePlan() {
    try {
      if (!journal || !authorityProof || !plan || !bootstrapPlan || !record
        || !journal.authority?.deployment?.address || journal.role) throw new Error('Authority 尚未核验或角色计划已建立。');
      const salt=newSalt(),delaySeconds=172800;
      buildIntegratedRoleMigrationPlan({genesisRecord:record,codePlan:plan,bootstrapPlan,
        authorityAddress:journal.authority.deployment.address,
        hardwareWallet:bootstrapPlan.hardwareWallet,salt,delaySeconds});
      save({...journal,role:{salt,delaySeconds,direct:{}}});
      setMessage('角色迁移计划已固定；逐项核对完整 calldata 后再签署。');
    } catch (problem) {setError(messageOf(problem));}
  }
  async function verifyRoleState() {
    if (!rolePlan) throw new Error('角色迁移计划尚未建立。');
    const proof=await validateIntegratedRoleMigrationStateAgainstChain(receiptProvider(),rolePlan,stageTwoBase());
    setRoleState(proof);return proof;
  }
  type RoleAction = {type:'direct';index:number}|{type:'schedule'|'execute'};
  function roleTx(action:RoleAction) {
    if (!journal?.role) return undefined;
    return action.type==='direct' ? journal.role.direct[action.index] : journal.role[action.type];
  }
  function roleData(action:RoleAction) {
    if (!rolePlan) throw new Error('角色计划不可用。');
    return action.type==='direct' ? {target:rolePlan.directSteps[action.index].target,
      data:rolePlan.directSteps[action.index].data} : {
      target:rolePlan.timelock,data:action.type==='schedule'
        ? rolePlan.roleBatch.scheduleData : rolePlan.roleBatch.executeData};
  }
  function withRoleTx(action:RoleAction,tx:UpgradeTransaction|undefined) {
    if (!journal?.role) throw new Error('角色迁移本机记录不可用。');
    return action.type==='direct' ? {...journal.role,direct:{...journal.role.direct,[action.index]:tx}}
      : {...journal.role,[action.type]:tx};
  }
  async function sendRoleAction(action:RoleAction) {
    await run('签署 Factory / Timelock 角色迁移',async () => {
      if (!wallet || !account || !onBsc || !journal?.role || !rolePlan || roleTx(action))
        throw new Error('角色迁移步骤或钱包未就绪。');
      const {target,data}=roleData(action);
      const proof=await validateIntegratedRoleMigrationActionAgainstChain(receiptProvider(),rolePlan,{
        ...stageTwoBase(),action,signer:account});
      if (getAddress(proof.target)!==getAddress(target) || proof.calldata!==data)
        throw new Error('角色迁移预检目标或 calldata 与固定计划不匹配。');
      setRoleState(proof);
      const tx:UpgradeTransaction={status:'uncertain',from:account,dataHash:keccak256(data)};
      await exclusiveSend(async () => {
        save({...journal,role:withRoleTx(action,tx)});
        let hash:string;
        try {hash=await sendUpgradeTransaction(wallet,{from:account,to:target,data});}
        catch (problem) {
          if (!(problem instanceof UncertainUpgradeSubmission)) save({...journal,role:withRoleTx(action,undefined)});
          throw problem;
        }
        save({...journal,role:withRoleTx(action,{...tx,status:'submitted',txHash:hash})});
        setMessage(`角色交易 ${hash} 已记录，待最终确认。`);
      });
    });
  }
  async function recoverRoleAction(action:RoleAction) {
    await run('核对角色迁移回执',async () => {
      if (!journal?.role || !rolePlan) throw new Error('角色迁移本机记录不可用。');
      const tx=roleTx(action);if (!tx || tx.status==='confirmed') throw new Error('没有待核对的角色交易。');
      const hash=tx.txHash || stageTwoRecoveryHash.trim();if (!hash) throw new Error('请输入钱包中的原交易哈希。');
      const {target,data}=roleData(action);
      if (tx.dataHash.toLowerCase()!==keccak256(data).toLowerCase()) throw new Error('角色交易 calldata 与记录不符。');
      const receipt=await verifyUpgradeReceipt(receiptProvider(),hash,{from:tx.from,to:target,dataHash:tx.dataHash});
      if (!receipt) {setMessage('角色交易尚未最终确认。');return;}
      const proof=await validateIntegratedRoleMigrationStateAgainstChain(receiptProvider(),rolePlan,stageTwoBase());
      if (action.type==='direct' ? !proof.applied[action.index]
        : action.type==='schedule' ? proof.status==='unscheduled' : proof.status!=='done') {
        throw new Error('回执已确认，但链上角色/权限状态未达到计划值。');
      }
      save({...journal,role:withRoleTx(action,{...tx,status:'confirmed',txHash:hash})});
      setRoleState(proof);setStageTwoRecoveryHash('');
      setMessage(`角色迁移步骤已在最终确认区块 #${proof.blockNumber} 验证。`);
    });
  }
  function createTreasuryPlan() {
    try {
      if (!journal || !record || !resultProof || !authorityProof || !roleState?.roleWiringComplete
        || !journal.authority?.deployment?.address || journal.treasury)
        throw new Error('角色接线尚未由链上证明完成。');
      const saltSeed=newSalt(),delaySeconds=172800;
      buildIntegratedTreasuryMigrationPlan({genesisRecord:record,codeResult:resultProof,
        authorityAddress:journal.authority.deployment.address,saltSeed,delaySeconds});
      save({...journal,treasury:{saltSeed,delaySeconds,operations:{}}});
      setMessage('历史池金库迁移计划已固定；每池单独等待 48 小时。');
    } catch (problem) {setError(messageOf(problem));}
  }
  async function sendTreasuryAction(index:number,which:'schedule'|'execute') {
    await run('签署历史池金库迁移',async () => {
      const op=treasuryPlan.plan?.operations[index],local=journal?.treasury?.operations[index];
      if (!wallet || !account || !onBsc || !journal?.treasury || !rolePlan || !op
        || local?.[which] || (which==='execute' && local?.schedule?.status!=='confirmed'))
        throw new Error('历史池金库步骤或钱包未就绪。');
      const phase=which==='schedule'?'unscheduled':'ready';
      const proof=await validateIntegratedTreasuryMigrationActionAgainstChain(receiptProvider(),
        treasuryPlan.plan!,{...stageTwoBase(),rolePlan,codeResult:resultProof!,
          operationIndex:index,phase,signer:account});
      const data=which==='schedule'?op.scheduleData:op.executeData;
      if (getAddress(proof.transactionTarget)!==getAddress(treasuryPlan.plan!.timelock)
        || proof.calldata!==data || proof.operationId.toLowerCase()!==op.operationId.toLowerCase())
        throw new Error('历史池迁移链上预检与已审阅计划不一致。');
      const tx:UpgradeTransaction={status:'uncertain',from:account,dataHash:keccak256(data)};
      const before={...local,...(which==='execute'?{preExecutionPreflight:proof}:{}),[which]:tx};
      await exclusiveSend(async () => {
        save({...journal,treasury:{...journal.treasury!,operations:{...journal.treasury!.operations,[index]:before}}});
        let hash:string;
        try {hash=await sendUpgradeTransaction(wallet,{from:account,to:treasuryPlan.plan!.timelock,data});}
        catch (problem) {
          if (!(problem instanceof UncertainUpgradeSubmission)) save({...journal,treasury:{...journal.treasury!,
            operations:{...journal.treasury!.operations,[index]:local}}});
          throw problem;
        }
        save({...journal,treasury:{...journal.treasury!,operations:{...journal.treasury!.operations,
          [index]:{...before,[which]:{...tx,status:'submitted',txHash:hash}}}}});
        setMessage(`历史池 ${short(op.target)} ${which==='schedule'?'提案':'执行'}交易已记录。`);
      });
    });
  }
  async function recoverTreasuryAction(index:number,which:'schedule'|'execute') {
    await run('核对历史池金库迁移回执',async () => {
      const op=treasuryPlan.plan?.operations[index],local=journal?.treasury?.operations[index];
      const tx=local?.[which];
      if (!journal?.treasury || !op || !tx || tx.status==='confirmed' || !rolePlan || !resultProof)
        throw new Error('没有可核对的历史池交易。');
      const hash=tx.txHash || stageTwoRecoveryHash.trim();if (!hash) throw new Error('请输入原交易哈希。');
      const data=which==='schedule'?op.scheduleData:op.executeData;
      if (tx.dataHash.toLowerCase()!==keccak256(data).toLowerCase()) throw new Error('迁移 calldata 与记录不符。');
      const receipt=await verifyUpgradeReceipt(receiptProvider(),hash,
        {from:tx.from,to:treasuryPlan.plan!.timelock,dataHash:tx.dataHash});
      if (!receipt) {setMessage('迁移交易尚未最终确认。');return;}
      if (which==='execute') {
        if (!local?.preExecutionPreflight || !local.schedule?.txHash)
          throw new Error('缺少链上执行前的旧金库欠款快照或提案交易。');
        await validateIntegratedTreasuryMigrationResultAgainstChain(receiptProvider(),treasuryPlan.plan!,{
          ...stageTwoBase(),rolePlan,codeResult:resultProof,operationIndex:index,
          preExecutionPreflight:local.preExecutionPreflight as never,
          scheduleTxHash:local.schedule.txHash,executeTxHash:hash,
        });
      }
      save({...journal,treasury:{...journal.treasury,operations:{...journal.treasury.operations,
        [index]:{...local,[which]:{...tx,status:'confirmed',txHash:hash}}}}});
      setStageTwoRecoveryHash('');
      setMessage(which==='execute'?'旧池金库迁移及原金库欠款保留已在链上核验。':'历史池迁移提案已核验，等待至少 48 小时。');
    });
  }
  async function verifyOnChainComplete() {
    await run('核验全部链上角色与历史池',async () => {
      if (!treasuryPlan.plan || !rolePlan || !resultProof || !journal?.treasury)
        throw new Error('历史池迁移计划尚未建立。');
      if (treasuryPlan.plan.operations.some((_,index)=>journal.treasury?.operations[index]?.execute?.status!=='confirmed'))
        throw new Error('仍有旧池迁移执行交易未取得最终确认回执。');
      const proof=await validateIntegratedOnChainMigrationCompleteAgainstChain(receiptProvider(),
        treasuryPlan.plan,{...stageTwoBase(),rolePlan,codeResult:resultProof});
      if (!proof) throw new Error('链上迁移证明不可用。');
      setOnChainComplete(true);
      setMessage('链上代码、角色和历史池金库迁移已核验；后台 Gas 代付与服务接线尚待独立核验，建池仍暂停。');
    });
  }

  const deployed = journal ? integratedUpgradeDeploymentOrder.filter(name => journal.deployments[name]?.status === 'confirmed').length : 0;
  const allDeployed = !!journal && deployed === integratedUpgradeDeploymentOrder.length;
  const pendingPause = pauseFactoryNames.some(name => journal?.pauses?.[name]?.status === 'submitted'
    || journal?.pauses?.[name]?.status === 'uncertain');
  const canDeploy = onBsc && oldTrust.ok && upgradeTrust.ok && !!genesisProof && !!journal
    && !pendingPause && !pendingName && !busy && !!bootstrapPlan
    && journal.bootstrap?.execute?.status === 'confirmed'
    && !!account && getAddress(account) === getAddress(bootstrapPlan.hardwareWallet);
  const stageTwoConfig = useMemo(() => {
    if (!record || !hardwareWalletInput || !gasWalletInput) return {value:null,reason:''};
    try { return {value:stageTwoAddresses(hardwareWalletInput,gasWalletInput,{
      timelock:record.addresses.timelock,factory:record.addresses.factory,
      portfolioFactory:record.addresses.portfolioFactory,oldOwner:record.input.ownerMultisig,
    }),reason:''}; }
    catch (problem) { return {value:null,reason:messageOf(problem)}; }
  }, [record,hardwareWalletInput,gasWalletInput]);
  const rolePlanState = useMemo(() => {
    if (!journal?.role || !record || !plan || !bootstrapPlan || !journal.authority?.deployment?.address)
      return {plan:null,reason:''};
    try {return {plan:buildIntegratedRoleMigrationPlan({genesisRecord:record,codePlan:plan,
      bootstrapPlan,authorityAddress:journal.authority.deployment.address,
      hardwareWallet:bootstrapPlan.hardwareWallet,salt:journal.role.salt,
      delaySeconds:journal.role.delaySeconds}),reason:''};}
    catch (problem) {return {plan:null,reason:messageOf(problem)};}
  }, [journal?.role, journal?.authority?.deployment?.address,record,plan,bootstrapPlan]);
  const rolePlan=rolePlanState.plan;
  const treasuryPlan = useMemo(() => {
    if (!resultProof || !record || !journal?.treasury || !journal.authority?.deployment?.address)
      return {plan:null,reason:''};
    try { return {plan:buildIntegratedTreasuryMigrationPlan({genesisRecord:record,codeResult:resultProof,
      authorityAddress:journal.authority.deployment.address,saltSeed:journal.treasury.saltSeed,
      delaySeconds:journal.treasury.delaySeconds}),reason:''}; }
    catch (problem) { return {plan:null,reason:messageOf(problem)}; }
  }, [record,resultProof,journal?.treasury,journal?.authority?.deployment?.address]);

  return <div className="upgrade-page">
    <section className="card upgrade-intro">
      <div><h2>集成版合约升级</h2><p>先由旧 owner 暂停建池并安排硬件钱包权限；硬件钱包部署候选实现，安排并执行原子升级；随后逐笔迁移 Authority、Factory、Timelock 和历史池金库。每笔交易由对应钱包签署，并先核对链上身份和精确 calldata。本页不接收私钥。</p><p className="upgrade-stage-warning">链上迁移完成不代表后台 Gas 代付服务已经接线。正式产品清单的切换和两套 Factory 的恢复建池必须等待运营服务的独立核验证据。</p></div>
      <span className="upgrade-state"><LockKeyhole size={14}/>主网 · 单批次时间锁</span>
    </section>
    <section className="card">
      <div className="card-heading"><div><ShieldCheck size={19}/><h2>1. 核对旧部署与候选代码</h2></div><span className="subtle-tag">只读</span></div>
      <div className="upgrade-section">
        <p>旧版本以当前产品已发布清单作为固定参照。导入文件只在浏览器本机读取，不上传；旧地址、初始化交易和每个运行代码哈希必须匹配链上。新产物必须等于本页面独立编译摘要。</p>
        <div className="upgrade-file-row"><div><b>旧部署完整记录</b><small>{record ? `记录 ${record.id} · ${record.status} · ${record.addresses.factory || '地址缺失'}` : '从原部署台导出的完整记录 JSON'}</small><input type="file" accept=".json,application/json" aria-label="导入旧部署完整记录" onChange={event => void readOldRecord(event.target.files?.[0])}/></div><span className="upgrade-state">{record ? '已读取' : '待导入'}</span></div>
        <div className="upgrade-file-row"><div><b>旧部署编译产物</b><small>{oldBundle ? artifactDigest(oldBundle) : '导入原版本 deployment-artifacts.json'}</small><input type="file" accept=".json,application/json" aria-label="导入旧部署编译产物" onChange={event => void readOldBundle(event.target.files?.[0])}/></div><span className="upgrade-state">{oldBundle ? '已读取' : '待导入'}</span></div>
        <div className="upgrade-meta"><div><span>旧图与已发布清单</span><b>{oldTrust.ok ? '地址、交易、源码、代码哈希一致' : oldTrust.reason}</b></div><div><span>候选产物</span><b>{upgradeTrust.ok ? '独立构建摘要一致' : upgradeTrust.reason}</b></div><div><span>旧链上图</span><b>{genesisProof ? `已核验 #${genesisProof.blockNumber}` : '尚未核验'}</b></div></div>
        <div className="upgrade-actions">
          {oldTrust.ok && upgradeTrust.ok && !journal && <button className="small-button" disabled={!!busy} onClick={createJournal}>建立本机升级记录</button>}
          <button className="small-button" disabled={!oldTrust.ok || !upgradeTrust.ok || !!busy} onClick={() => void readPauseTargets()}><RefreshCw size={14}/>读取两套建池状态</button>
        </div>
        <div className="upgrade-migration-preview">
          <b>升级前先暂停两套 Factory 建池</b>
          <p>当前旧 owner 钱包各签一笔 <code>pauseCreation(true)</code>。每笔先在最终确认区块核对完整旧合约图、当前 owner 与准确 calldata；不做交易模拟。两套暂停后再核验完整旧图。</p>
          {!wallet && <div className="upgrade-actions"><button className="small-button" onClick={onConnect}><Wallet size={14}/>连接旧 owner 钱包</button></div>}
          <ol className="upgrade-step-list">{pauseFactoryNames.map((name,index) => {
            const tx = journal?.pauses?.[name], target = pauseProof?.targets[name];
            const canPause = !!journal && !!target && !target.paused && !tx && !pendingPause && onBsc
              && !!account && getAddress(account) === getAddress(target.owner) && !busy;
            return <li className="upgrade-step" key={name}>
              <span className="upgrade-step-index">{target?.paused ? <Check size={15}/> : index + 1}</span>
              <div><b>{name === 'factory' ? '单机 Factory' : '预算项目 Factory'}</b>
                <small>{target ? `当前 owner ${target.owner} · ${target.paused ? '链上已暂停' : '链上未暂停'}` : '先读取最终确认状态'}{tx?.status === 'uncertain' ? ' · 发送结果不确定，禁止重发' : tx?.status === 'submitted' ? ' · 等待回执' : ''}</small>
                {tx?.txHash && <a className="upgrade-code" href={`${explorer}/tx/${tx.txHash}`} target="_blank" rel="noreferrer">{short(tx.txHash)} <ArrowUpRight size={12}/></a>}
                {tx?.status === 'uncertain' && !tx.txHash && <input className="upgrade-step-input" value={pauseRecoveryHash} placeholder="输入钱包中该笔暂停交易哈希" onChange={event => setPauseRecoveryHash(event.target.value)}/>}</div>
              {tx && tx.status !== 'confirmed' ? <button className="small-button" disabled={!!busy || !onBsc} onClick={() => void recoverPause(name)}>核对回执</button>
                : <button className="small-button" disabled={!canPause} onClick={() => void sendPause(name)}>{target?.paused ? '已暂停' : '由旧 owner 暂停'}</button>}
            </li>;
          })}</ol>
          <div className="upgrade-alert note">每笔暂停交易在钱包弹出前都会重新验证完整旧图：原始运行代码、UUPS 实现槽、Beacon、Timelock、注册表和历史池。</div>
          <div className="upgrade-actions"><button className="small-button" disabled={!oldTrust.ok || !upgradeTrust.ok || pendingPause || !!busy || !pauseProof || pauseFactoryNames.some(name => !pauseProof.targets[name].paused)} onClick={() => void verifyGenesis()}><ShieldCheck size={14}/>核验完整旧链上图</button></div>
        </div>
      </div>
    </section>
    <section className="card">
      <div className="card-heading"><div><LockKeyhole size={19}/><h2>2. 授予硬件钱包提案权限</h2></div><span className="subtle-tag">旧提案人安排 · 48 小时</span></div>
      <div className="upgrade-section">
        <p>现有 Timelock 的提案人仍是旧 owner。旧提案人先安排一次不可拆分的授权批次，48 小时后执行，授予硬件钱包 proposer 和 canceller；旧提案人的撤销留到第二阶段。每次签署前均核验旧图、角色和操作状态。</p>
        <div className="upgrade-config-grid"><label>新硬件钱包公开地址<input className="upgrade-step-input" value={hardwareWalletInput} disabled={!!journal?.bootstrap} placeholder="0x… · 不输入私钥" onChange={event => setHardwareWalletInput(event.target.value)} autoComplete="off" spellCheck={false}/></label></div>
        <div className="upgrade-actions"><button className="small-button" disabled={!journal || !genesisProof || !onBsc || !!busy || !!journal?.bootstrap} onClick={createBootstrap}>生成角色授权批次</button>{bootstrapPlan && <button className="small-button" disabled={!!busy} onClick={() => void readBootstrapStatus()}>核验授权状态</button>}</div>
        {bootstrapPlanState.reason && <div className="upgrade-alert error">{bootstrapPlanState.reason}</div>}
        {bootstrapPlan && <><div className="upgrade-meta"><div><span>旧提案人</span><b className="upgrade-code">{bootstrapPlan.oldProposer}</b></div><div><span>目标硬件钱包</span><b className="upgrade-code">{bootstrapPlan.hardwareWallet}</b></div><div><span>操作 ID</span><b className="upgrade-code">{bootstrapPlan.operationId}</b></div><div><span>链上状态</span><b>{bootstrapProof?.phase || '未核验'}</b></div></div><details className="upgrade-details"><summary>核对两个授权目标、0 BNB 和完整 calldata</summary><pre>{JSON.stringify({targets:bootstrapPlan.targets,values:bootstrapPlan.values,payloads:bootstrapPlan.payloads,predecessor:bootstrapPlan.predecessor,salt:bootstrapPlan.salt,delaySeconds:bootstrapPlan.delaySeconds,operationId:bootstrapPlan.operationId,scheduleData:bootstrapPlan.scheduleData,executeData:bootstrapPlan.executeData},null,2)}</pre></details></>}
        <div className="upgrade-actions"><button className="primary-button" disabled={!bootstrapPlan || !!journal?.bootstrap?.schedule || !onBsc || !!busy} onClick={() => void sendBootstrap('schedule')}>由旧提案人安排授权</button><button className="primary-button" disabled={!bootstrapPlan || journal?.bootstrap?.schedule?.status !== 'confirmed' || !!journal?.bootstrap?.execute || !onBsc || !!busy} onClick={() => void sendBootstrap('execute')}>48 小时后执行授权</button></div>
        {(['schedule','execute'] as const).map(which => { const tx=journal?.bootstrap?.[which]; return tx && tx.status !== 'confirmed' ? <div className="upgrade-actions" key={which}><input className="upgrade-step-input" value={recoveryHash} placeholder="如未收到哈希，输入原交易哈希" onChange={event => setRecoveryHash(event.target.value)}/><button className="small-button" disabled={!!busy || !onBsc} onClick={() => void recoverBootstrap(which)}>核对{which === 'schedule' ? '安排' : '执行'}交易</button></div> : null; })}
        {journal?.bootstrap?.execute?.status === 'confirmed' && <div className="upgrade-alert ok">硬件钱包提案权限已有最终确认的交易回执；部署每笔实现前仍会重新核对链上授权。</div>}
      </div>
    </section>
    <section className="card">
      <div className="card-heading"><div><Wallet size={19}/><h2>3. 用硬件钱包部署新库与实现</h2></div><span className="subtle-tag">{deployed} / {integratedUpgradeDeploymentOrder.length}</span></div>
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
      <div className="card-heading"><div><LockKeyhole size={19}/><h2>4. 原子时间锁批次</h2></div><span className="subtle-tag">一个 scheduleBatch</span></div>
      <div className="upgrade-section">
        <p>六个代理/Beacon 升级调用必须在同一批次内安排和执行，金额均为 0 BNB。固定 salt、前置操作及操作 ID 可供钱包逐字核对。</p>
        {journal && <div className="upgrade-meta"><div><span>等待时间</span><b><input type="number" min={172800} step={3600} value={journal.delaySeconds} disabled={!!journal.schedule || !!busy} onChange={event => { const delaySeconds = Number(event.target.value); if (Number.isSafeInteger(delaySeconds) && delaySeconds >= 172800) save({...journal,delaySeconds}); }}/></b></div><div><span>Salt</span><b className="upgrade-code">{journal.salt}</b></div><div><span>Operation ID</span><b className="upgrade-code">{plan?.operationId || '待全部实现确认'}</b></div></div>}
        {plan && <><div className="upgrade-batch"><div><span>调用</span><span>链上目标</span><span>新实现</span></div>{plan.steps.map(step => <div key={step.name}><strong>{step.name}</strong><code>{step.target}</code><code>{step.implementation}</code></div>)}</div><details className="upgrade-details"><summary>查看完整 targets、values、payloads 与钱包 calldata</summary><pre>{JSON.stringify({targets:plan.targets,values:plan.values,payloads:plan.payloads,predecessor:plan.predecessor,salt:plan.salt,delaySeconds:plan.delaySeconds,operationId:plan.operationId,scheduleData:plan.scheduleData,executeData:plan.executeData},null,2)}</pre></details><div className="upgrade-alert note">旧 PoolLens 地址与代码保持原样。其 <code>passed</code>、<code>requiredYesShares</code>、<code>canExecute</code> 仍反映旧的折价门槛，升级后治理判断须直接读取 Vault 与市场，不能用旧 Lens 证明。</div></>}
        {planState.reason && <div className="upgrade-alert error">{planState.reason}</div>}
        <div className="upgrade-actions"><button className="small-button" disabled={!allDeployed || !onBsc || !!busy} onClick={() => void verifyPlan()}><ShieldCheck size={14}/>{busy || '核验新实现与完整批次'}</button>{plan && <button className="small-button" disabled={!!busy} onClick={() => void run('读取时间锁状态', async () => { await refreshOperation(); })}><RefreshCw size={14}/>刷新时间锁状态</button>}</div>
        {planProof && <div className="upgrade-alert ok">链上代码、绑定关系、提案人角色、批次 ID 已在最终确认区块 #{planProof.blockNumber} 核验。</div>}
        <div className={`upgrade-alert ${releaseGate.ready ? 'ok' : 'error'}`}>{releaseGate.ready
          ? `正式部署台、产品页面及 BSC 区块 #${releaseGate.verifiedBlockNumber} 已核验；签名前会重新检查。`
          : `升级排程与执行暂不可用：${releaseGate.reason}`}</div>
        {plan && <div className="upgrade-actions"><button className="small-button" disabled={!!busy}
          onClick={() => void refreshReleaseGate()}><RefreshCw size={14}/>重新核验正式发布</button></div>}
        {plan && <div className="upgrade-meta"><div><span>批次状态</span><b>{operation === 'unknown' ? '尚未读取' : operation === 'unscheduled' ? '未提交' : operation === 'waiting' ? '等待中' : operation === 'ready' ? '可执行' : '已执行'}</b></div><div><span>最早执行</span><b>{readyAt ? new Date(readyAt * 1000).toLocaleString('zh-CN') : '—'}</b></div><div><span>批次交易</span><b>{journal?.schedule?.txHash ? short(journal.schedule.txHash) : '—'}</b></div></div>}
        <label className="upgrade-ack"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)}/><span>我已核对六笔调用目标、新实现、0 BNB 金额、salt 与 operation ID；明白代码升级和后续权限迁移是两个阶段。</span></label>
        <div className="upgrade-actions"><button className="primary-button" disabled={!releaseGate.ready || !plan || !planProof || !onBsc || !reviewed || !!journal?.schedule || operation !== 'unscheduled' || !!busy} onClick={() => void sendBatch('schedule')}>提交 48 小时提案</button><button className="primary-button" disabled={!releaseGate.ready || !plan || !onBsc || !reviewed || journal?.schedule?.status !== 'confirmed' || !!journal?.execute || operation !== 'ready' || !!busy} onClick={() => void sendBatch('execute')}>等待结束后执行批次</button></div>
        {journal?.schedule && journal.schedule.status !== 'confirmed' && <div className="upgrade-actions"><input className="upgrade-step-input" value={recoveryHash} placeholder="如未收到哈希，请输入钱包中的原交易哈希" onChange={event => setRecoveryHash(event.target.value)}/><button className="small-button" disabled={!!busy} onClick={() => void recoverBatch('schedule')}>核对提案交易</button></div>}
        {journal?.execute && journal.execute.status !== 'confirmed' && <div className="upgrade-actions"><input className="upgrade-step-input" value={recoveryHash} placeholder="如未收到哈希，请输入钱包中的原交易哈希" onChange={event => setRecoveryHash(event.target.value)}/><button className="small-button" disabled={!!busy} onClick={() => void recoverBatch('execute')}>核对执行交易</button></div>}
        {journal?.execute?.status === 'confirmed' && <div className="upgrade-alert note">升级交易已确认，仍须核验后置合约图与全部角色迁移；当前不能标记正式开放。</div>}
      </div>
    </section>
    <section className="card">
      <div className="card-heading"><div><ShieldCheck size={19}/><h2>5. 后置图与权限迁移</h2></div><span className="subtle-tag">独立阶段</span></div>
      <div className="upgrade-section">
        <p>代码升级与角色接线分别验收。旧矿池的金库地址在创建时写入，Factory 金库变更不会改变现有池；原金库已产生的应收费用仍归原地址。</p>
        <div className="upgrade-meta">
          <div><span>代码升级</span><b>{resultProof ? `本次已核验 #${resultProof.blockNumber}` : journal?.execute?.status === 'confirmed' ? '交易已执行，等待后置图证明' : '未完成'}</b></div>
          <div><span>PlatformAuthority 与双管理员</span><b>{authorityProof ? `已核验 #${authorityProof.blockNumber}` : '待独立部署与核验'}</b></div>
          <div><span>角色接线</span><b>{roleState?.roleWiringComplete ? '链上角色已迁移' : '待旧 owner / Timelock 授权迁移'}</b></div>
          <div><span>旧池金库</span><b>{onChainComplete ? '链上已迁移' : resultProof ? `${resultProof.legacyTreasuryResidual.length} 个历史池待逐一处理` : '待后置图枚举'}</b></div>
        </div>
        <div className="upgrade-migration-preview">
          <b>第二阶段公开地址</b>
          <p>硬件钱包只用于部署、升级权限；Gas 钱包只用于后台代付。这里仅填写公开地址，不接受私钥或助记词。Gas 地址须与受保护服务配置或你已核对的公开地址一致。</p>
          <div className="upgrade-config-grid">
            <label>目标硬件钱包地址<input className="upgrade-step-input" value={bootstrapPlan?.hardwareWallet || hardwareWalletInput} readOnly placeholder="先完成第二步角色授权" autoComplete="off" spellCheck={false}/></label>
            <label>后台 Gas 钱包公开地址<input className="upgrade-step-input" value={gasWalletInput} disabled={!!journal?.authority} placeholder="0x…  · 与受保护服务核对" onChange={event => setGasWalletInput(event.target.value)} autoComplete="off" spellCheck={false}/></label>
          </div>
          {stageTwoConfig.reason && <div className="upgrade-alert error">{stageTwoConfig.reason}</div>}
          <div className="upgrade-meta">
            <div><span>当前 Factory owner</span><b className="upgrade-code">{record?.input.ownerMultisig || '待核对旧图'}</b></div>
            <div><span>管理员一</span><b className="upgrade-code">{authorityAdministrators[0]}</b></div>
            <div><span>管理员二</span><b className="upgrade-code">{authorityAdministrators[1]}</b></div>
          </div>
          {stageTwoConfig.value && <div className="upgrade-alert note">这里先核对公开地址格式。钱包弹出前还会核对完整代码图、Authority 构造 calldata、当前链上角色。后台 Gas 地址须由你从受保护服务的公开配置独立核对。</div>}
        </div>
        {journal?.execute?.status === 'confirmed' && <div className="upgrade-actions"><button className="small-button" disabled={!!busy} onClick={() => void verifyResult()}><ShieldCheck size={14}/>核验最终链上图</button></div>}
        {resultProof && <div className="upgrade-alert ok">六个目标及十个新库/实现均已在最终确认区块核对；此证明只覆盖代码升级。</div>}
        <div className="upgrade-migration-preview"><b>A. 部署 PlatformAuthority</b>
          <p>由已经授权的硬件钱包部署，构造参数固定绑定两套 Factory、两位管理员与公开 Gas 地址。回执会核对原始创建字节码、运行代码、不可变参数、owner 和 EIP-712 域。</p>
          {resultProof && stageTwoConfig.value && upgradeBundle && record && oldBundle && <details className="upgrade-details"><summary>查看 Authority 完整构造 calldata 和 0 BNB 金额</summary><pre>{JSON.stringify({administratorOne:authorityAdministrators[0],administratorTwo:authorityAdministrators[1],gasWallet:stageTwoConfig.value.gasWallet,value:'0',data:integratedAuthorityDeploymentData({genesisRecord:record,genesisBundle:oldBundle,trustedGenesisManifest,upgradeBundle,trustedUpgradeArtifactDigest:__DEPLOYMENT_ARTIFACT_DIGEST__,administratorOne:authorityAdministrators[0],administratorTwo:authorityAdministrators[1],gasWallet:stageTwoConfig.value.gasWallet})},null,2)}</pre></details>}
          <div className="upgrade-actions"><button className="primary-button" disabled={!resultProof || !stageTwoConfig.value || !!journal?.authority || !onBsc || !!busy} onClick={() => void deployAuthority()}>硬件钱包部署 Authority</button>{journal?.authority?.deployment?.status==='confirmed' && <button className="small-button" disabled={!!busy || !onBsc} onClick={() => void run('重验 Authority',async()=>{const proof=await verifyAuthority();setMessage(`Authority 已重验 #${proof.blockNumber}`);})}>重新核验 Authority</button>}</div>
          {journal?.authority?.deployment && journal.authority.deployment.status!=='confirmed' && <div className="upgrade-actions"><input className="upgrade-step-input" value={stageTwoRecoveryHash} placeholder="发送结果未知时输入原部署交易哈希" onChange={event=>setStageTwoRecoveryHash(event.target.value)}/><button className="small-button" disabled={!!busy || !onBsc} onClick={() => void recoverAuthority()}>核对 Authority 回执</button></div>}
          {journal?.authority?.deployment?.address && <div className="upgrade-code">Authority：{journal.authority.deployment.address}</div>}
        </div>
        <div className="upgrade-migration-preview"><b>B. 迁移 Factory 与 Timelock 角色</b>
          <p>旧 owner 先签四笔 operator/treasury 设置；新硬件钱包安排 48 小时撤销旧 proposer/canceller 的原子批次；执行后旧 owner 再把两套 Factory 的所有权转给 Timelock。签名前都会核验当前角色及完整后置代码图。</p>
          <div className="upgrade-actions"><button className="small-button" disabled={!authorityProof || !journal || !!journal.role || !!busy} onClick={createRolePlan}>固定角色迁移计划</button>{rolePlan && <button className="small-button" disabled={!!busy || !onBsc} onClick={() => void run('核验角色状态',async()=>{const proof=await verifyRoleState();setMessage(`角色已核验 #${proof.blockNumber} · ${proof.status}`);})}>核验当前角色</button>}</div>
          {rolePlanState.reason && <div className="upgrade-alert error">{rolePlanState.reason}</div>}
          {rolePlan && <><details className="upgrade-details"><summary>查看六笔 Factory 操作、角色批次与完整 calldata</summary><pre>{JSON.stringify(rolePlan,null,2)}</pre></details><ol className="upgrade-step-list">{rolePlan.directSteps.map(step=>{const tx=journal?.role?.direct[step.index];const prior=step.index===0 || journal?.role?.direct[step.index-1]?.status==='confirmed';const allowed=step.index<4 ? prior : prior && journal?.role?.execute?.status==='confirmed';return <li className="upgrade-step" key={step.index}><span className="upgrade-step-index">{tx?.status==='confirmed'?<Check size={15}/>:step.index+1}</span><div><b>{step.name}</b><small>签署者 {short(step.signer)} · 目标 {short(step.target)} · 0 BNB · {tx?.status || '待签署'}</small>{tx?.txHash && <a href={`${explorer}/tx/${tx.txHash}`} target="_blank" rel="noreferrer" className="upgrade-code">{short(tx.txHash)}</a>}</div>{tx && tx.status!=='confirmed'?<button className="small-button" disabled={!!busy || !onBsc} onClick={()=>void recoverRoleAction({type:'direct',index:step.index})}>核对回执</button>:<button className="small-button" disabled={!allowed || !!tx || !onBsc || !!busy} onClick={()=>void sendRoleAction({type:'direct',index:step.index})}>签署</button>}</li>;})}</ol>
          <div className="upgrade-meta"><div><span>角色撤销操作 ID</span><b className="upgrade-code">{rolePlan.roleBatch.operationId}</b></div><div><span>时间锁状态</span><b>{roleState?.status || '待核验'}</b></div></div><div className="upgrade-actions">{(['schedule','execute'] as const).map(which=>{const tx=journal?.role?.[which];const allowed=which==='schedule'?rolePlan.directSteps.slice(0,4).every(step=>journal?.role?.direct[step.index]?.status==='confirmed'):journal?.role?.schedule?.status==='confirmed';return tx && tx.status!=='confirmed'?<button key={which} className="small-button" disabled={!!busy || !onBsc} onClick={()=>void recoverRoleAction({type:which})}>核对{which==='schedule'?'提案':'执行'}回执</button>:<button key={which} className="primary-button" disabled={!allowed || !!tx || !onBsc || !!busy} onClick={()=>void sendRoleAction({type:which})}>{which==='schedule'?'硬件钱包安排角色撤销':'48 小时后执行角色撤销'}</button>;})}</div>
          {Object.values(journal?.role?.direct || {}).concat([journal?.role?.schedule,journal?.role?.execute].filter(Boolean) as UpgradeTransaction[]).some(tx=>tx?.status==='uncertain') && <input className="upgrade-step-input" value={stageTwoRecoveryHash} placeholder="输入对应原交易的完整哈希" onChange={event=>setStageTwoRecoveryHash(event.target.value)}/>}</>}
          {roleState?.roleWiringComplete && <div className="upgrade-alert ok">两套 Factory operator、treasury、owner 与 Timelock 新旧角色已在链上核验。</div>}
        </div>
        {resultProof?.legacyTreasuryResidual.length ? <details className="upgrade-details"><summary>查看 {resultProof.legacyTreasuryResidual.length} 个历史池的旧金库</summary><pre>{JSON.stringify(resultProof.legacyTreasuryResidual,null,2)}</pre></details> : null}
        {resultProof && <div className="upgrade-migration-preview">
          <b>C. 逐池迁移历史金库</b>
          <p>每个旧矿池独立安排并等待至少 48 小时。执行前保存链上原金库应收快照，回执后逐笔证明已入账旧费用仍属于原金库；若严格挖矿收益结算失败，该池执行会回滚并保持旧金库。</p>
          <div className="upgrade-actions"><button className="small-button" disabled={!roleState?.roleWiringComplete || !authorityProof || !!journal?.treasury || !!busy} onClick={createTreasuryPlan}>固定各池迁移计划</button></div>
          {treasuryPlan.reason && <div className="upgrade-alert error">{treasuryPlan.reason}</div>}
          {treasuryPlan.plan && <><div className="upgrade-alert note">历史池 {treasuryPlan.plan.operations.length} 个，逐池独立时间锁操作。签署前将重新核验 Authority、角色、旧池状态和原金库欠款。</div><details className="upgrade-details"><summary>查看每池 operation ID 与完整 calldata</summary><pre>{JSON.stringify(treasuryPlan.plan,null,2)}</pre></details><ol className="upgrade-step-list">{treasuryPlan.plan.operations.map((op,index)=>{const local=journal?.treasury?.operations[index];return <li className="upgrade-step" key={op.target}><span className="upgrade-step-index">{local?.execute?.status==='confirmed'?<Check size={15}/>:index+1}</span><div><b>{short(op.target)}</b><small>原金库 {short(op.expectedOld)} → Authority · 操作 {short(op.operationId)}</small><small>{local?.execute?.status==='confirmed'?'已核验旧金库欠款保留':local?.schedule?.status==='confirmed'?'等待或执行中':'待安排'}</small></div><div className="upgrade-actions">{(['schedule','execute'] as const).map(which=>{const tx=local?.[which];const allowed=which==='schedule'?roleState?.roleWiringComplete:local?.schedule?.status==='confirmed';return tx && tx.status!=='confirmed'?<button className="small-button" key={which} disabled={!!busy || !onBsc} onClick={()=>void recoverTreasuryAction(index,which)}>核对{which==='schedule'?'提案':'执行'}回执</button>:<button className="small-button" key={which} disabled={!allowed || !!tx || !onBsc || !!busy} onClick={()=>void sendTreasuryAction(index,which)}>{which==='schedule'?'安排 48 小时':'到期后执行'}</button>;})}</div></li>;})}</ol><div className="upgrade-actions"><input className="upgrade-step-input" value={stageTwoRecoveryHash} placeholder="发送结果不明时，输入对应原交易哈希" onChange={event=>setStageTwoRecoveryHash(event.target.value)}/><button className="small-button" disabled={!!busy || !onBsc || !roleState?.roleWiringComplete} onClick={()=>void verifyOnChainComplete()}>核验全部链上迁移</button></div></>}
        </div>}
        <div className="upgrade-alert note">{onChainComplete?'链上迁移已经核验；':'链上迁移尚未全部核验；'}后台 Gas 代付与运营接线没有可验证的发布证明。{pauseProof ? `截至已核验区块 #${pauseProof.blockNumber}，${pauseFactoryNames.every(name => pauseProof.targets[name].paused) ? '两套 Factory 均已暂停建池' : '至少一套 Factory 尚未暂停建池'}；` : '两套 Factory 的暂停状态尚未核验；'}恢复建池前须重新核对链上状态。正式产品清单尚未切换，不能宣称可以运营。</div>
        <ol className="upgrade-handoff"><li><b>最后恢复两套 Factory 建池</b><span>仅在后端代付接线、权限、历史池金库及 Timelock 所有权全部独立核验后，由硬件钱包安排至少 48 小时的 Timelock 批次，再执行两套 Factory 的 pauseCreation(false)。当前没有后端接线证明接口。</span><em>阻断 · 待核验</em></li></ol>
        {plan && journal && <div className="upgrade-actions"><button className="small-button" onClick={() => download(`pinkuang-upgrade-${plan.operationId}.json`,{plan,bootstrapPlan,rolePlan,treasuryPlan:treasuryPlan.plan,journal,genesisProof,bootstrapProof,planProof,resultProof,authorityProof,roleState,onChainComplete,keeperCutoverVerified:false,productManifestSwitched:false})}><ArrowDownToLine size={14}/>导出当前升级证据</button><a className="small-button" target="_blank" rel="noreferrer" href={`${explorer}/address/${record?.addresses.timelock}`}><ExternalLink size={14}/>查看时间锁</a></div>}
      </div>
    </section>
    {message && <div className="upgrade-alert ok" role="status">{message}</div>}
    {error && <div className="upgrade-alert error" role="alert">{error}</div>}
  </div>;
}
