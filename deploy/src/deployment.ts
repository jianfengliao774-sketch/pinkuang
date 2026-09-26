import {
  BrowserProvider, Contract, ContractFactory, Interface, ZeroAddress,
  formatEther, getAddress, getCreateAddress, keccak256, parseEther, parseUnits, toUtf8Bytes,
  type Eip1193Provider, type InterfaceAbi, type TransactionReceipt, type TransactionRequest, type TransactionResponse,
} from 'ethers';

// Vite injects this literal after independently compiling and checking the local Solidity sources.
// There is deliberately no digest fetched from the artifact server or accepted from the bundle.
declare const __DEPLOYMENT_ARTIFACT_DIGEST__: string;

export type { Eip1193Provider } from 'ethers';
export const BSC_CHAIN_ID = 56;
export const UPGRADE_DELAY_SECONDS = 48 * 60 * 60;
export const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const LIBRARY_NAMES = [
  'FlexiblePurchase', 'MiningOperations', 'PoolFunds', 'PurchaseValidation',
  'RewardAccounting', 'SaleGovernance', 'SaleSettlement', 'ShareCheckpoints',
] as const;

/** Current execution dependencies only; existence does not certify the protocols. */
export const PROTOCOL_ADDRESSES: Record<string, string> = {
  TAPEOUT_CIRCUITS: '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C',
  BEHEMOTH_CIRCUITS: '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C',
  MINING: '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46',
  CIRCUIT_MARKET: '0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f',
  BEM: '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a',
};

export type ByteRange = { start: number; length: number };
export type LinkReferences = Record<string, Record<string, ByteRange[]>>;
export interface DeploymentArtifact {
  contractName: string;
  sourceName: string;
  abi: InterfaceAbi;
  bytecode: string;
  deployedBytecode: string;
  linkReferences: LinkReferences;
  deployedLinkReferences: LinkReferences;
  immutableReferences: Record<string, ByteRange[]>;
}
export interface ArtifactBundle {
  schemaVersion: 1;
  compilerVersion: string;
  sourceCommit: string;
  settings: unknown;
  sourceHashes: Record<string, string>;
  artifacts: Record<string, DeploymentArtifact>;
}
export interface DeploymentInput {
  governanceMode: 'single' | 'multisig';
  ownerMultisig: string;
  operator: string;
  treasury: string;
  maxGasBudgetBnb: string;
  gasPriceCapGwei: string;
  governanceReviewed: boolean;
  protocolReviewed: boolean;
}
export interface CodeRecord { address: string; codehash: string; codeBytes: number }
export interface MultisigRecord extends CodeRecord { threshold: number; owners: string[] }
export interface PreflightReport {
  chainId: 56;
  account: string;
  balanceWei: string;
  gasPriceWei: string;
  artifactDigest: string;
  owner: CodeRecord | MultisigRecord;
  treasury: CodeRecord | MultisigRecord;
  protocols: Record<string, CodeRecord>;
  libraryOrder: string[];
  transactionCount: number;
  warnings: string[];
  checkedAt: string;
}
export type StepStatus = 'waiting' | 'signing' | 'submitted' | 'confirmed' | 'rejected' | 'failed' | 'uncertain' | 'cancelled' | 'replaced';
export interface StepRecord {
  id: string;
  label: string;
  status: StepStatus;
  txHash?: string;
  previousTxHashes?: string[];
  replacementHash?: string;
  finalizedRecovery?: boolean;
  address?: string;
  nonce?: number;
  gasEstimate?: string;
  gasLimit?: string;
  gasPriceWei?: string;
  maxFeeWei?: string;
  dataHash?: string;
  receipt?: { blockNumber: number; blockHash: string; status: number; gasUsed: string; gasPrice: string; feeWei: string };
  codehash?: string;
  error?: string;
}
export interface VerificationCheck { label: string; passed: boolean; actual: string; expected: string }
export interface DeploymentVerification {
  checkedAt: string;
  blockNumber: number;
  checks: VerificationCheck[];
  code: Record<string, CodeRecord>;
}
export interface DeploymentSnapshot {
  schemaVersion: 1;
  id: string;
  chainId: 56;
  account: string;
  createdAt: string;
  updatedAt: string;
  artifactDigest: string;
  sourceCommit: string;
  input: DeploymentInput;
  status: 'ready' | 'running' | 'paused' | 'failed' | 'aborted' | 'complete';
  steps: StepRecord[];
  addresses: Record<string, string>;
  spentWei: string;
  preflight: PreflightReport;
  error?: string;
  verification?: DeploymentVerification;
}
export interface DeploymentCallbacks {
  /** Must durably save synchronously or resolve only after saving. Failure prevents the next signature. */
  persist: (snapshot: DeploymentSnapshot) => void | Promise<void>;
  onUpdate?: (snapshot: DeploymentSnapshot) => void;
  /** Read inside the cross-tab lock; prevents a stale tab from replaying already-completed steps. */
  readLatest?: () => DeploymentSnapshot | null | Promise<DeploymentSnapshot | null>;
}

const MULTISIG_ABI = ['function getThreshold() view returns(uint256)', 'function getOwners() view returns(address[])'];
const REQUIRED_ARTIFACTS = [...LIBRARY_NAMES, 'AtomicDeployment', 'PoolVault', 'PoolFactory', 'ShareMarket', 'PoolTimelock', 'PoolBeacon', 'ERC1967Proxy', 'PoolLens'];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const isAborted = (snapshot: DeploymentSnapshot): boolean => snapshot.status === 'aborted';
const receiptRecord = (receipt: TransactionReceipt): NonNullable<StepRecord['receipt']> => ({
  blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, status: receipt.status ?? 0,
  gasUsed: receipt.gasUsed.toString(), gasPrice: receipt.gasPrice.toString(), feeWei: receipt.fee.toString(),
});
export const errorMessage = (error: unknown): string => {
  const details = error as { shortMessage?: string; reason?: string; message?: string } | null;
  return (details?.reason || details?.shortMessage || details?.message || String(error)).slice(0, 1000);
};
const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) throw new Error(message); };
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function normalizeInput(input: DeploymentInput, requireReview = true): DeploymentInput {
  assert(input.governanceMode === 'single' || input.governanceMode === 'multisig', '请选择单钱包或多签治理。');
  const normalized = { ...input };
  for (const key of ['ownerMultisig', 'operator', 'treasury'] as const) {
    normalized[key] = getAddress(input[key].trim());
    assert(normalized[key] !== ZeroAddress, `${key} 不能是零地址。`);
  }
  assert(parseEther(input.maxGasBudgetBnb) > 0n, '总 Gas 预算必须大于零。');
  assert(parseUnits(input.gasPriceCapGwei, 'gwei') > 0n, 'Gas 单价上限必须大于零。');
  if (requireReview) {
    assert(input.governanceReviewed === true, '请先核对治理地址并确认其控制权限。');
    assert(input.protocolReviewed === true, '请先人工复核协议地址及业务主网测试条件。');
  }
  if (input.governanceMode === 'multisig') {
    assert(!sameAddress(normalized.operator, normalized.ownerMultisig) && !sameAddress(normalized.operator, normalized.treasury), '多签模式的操作员必须与管理多签和金库不同。');
  }
  return normalized;
}

function canonicalContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalContent);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, canonicalContent(object[key])]));
  }
  return value;
}

export function artifactDigest(bundle: ArtifactBundle): string {
  const { sourceCommit: _commit, ...content } = bundle;
  return keccak256(toUtf8Bytes(JSON.stringify(canonicalContent(content))));
}

export function verifyArtifactIntegrity(bundle: ArtifactBundle): void {
  assert(typeof __DEPLOYMENT_ARTIFACT_DIGEST__ === 'string' && /^0x[0-9a-f]{64}$/.test(__DEPLOYMENT_ARTIFACT_DIGEST__), '页面缺少源码编译摘要；请重新构建部署页面。');
  assert(artifactDigest(bundle) === __DEPLOYMENT_ARTIFACT_DIGEST__, '部署产物与页面独立编译的源码摘要不一致；已禁止签名，请核对源码并重新构建。');
}

export function libraryDeploymentOrder(bundle: ArtifactBundle): string[] {
  const result: string[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (name: string) => {
    if (done.has(name)) return;
    assert(!visiting.has(name), `库链接存在依赖循环：${name}`);
    assert((LIBRARY_NAMES as readonly string[]).includes(name), `构建包含未批准的库：${name}`);
    const artifact = bundle.artifacts[name];
    assert(artifact, `缺少构建产物：${name}`);
    visiting.add(name);
    const dependencies = new Set<string>();
    for (const references of [artifact.linkReferences, artifact.deployedLinkReferences]) {
      for (const refs of Object.values(references ?? {})) {
        for (const dependency of Object.keys(refs)) dependencies.add(dependency);
      }
    }
    for (const dependency of [...dependencies].sort()) visit(dependency);
    visiting.delete(name); done.add(name); result.push(name);
  };
  for (const name of LIBRARY_NAMES) visit(name);
  return result;
}

export function validateArtifacts(bundle: ArtifactBundle): void {
  verifyArtifactIntegrity(bundle);
  assert(bundle?.schemaVersion === 1, '部署构建格式不支持。');
  assert(bundle.compilerVersion.startsWith('0.8.24'), '编译器版本应为 Solidity 0.8.24。');
  for (const name of REQUIRED_ARTIFACTS) {
    const artifact = bundle.artifacts[name];
    assert(artifact?.contractName === name, `缺少或错误的构建产物：${name}`);
    assert(artifact.bytecode?.startsWith('0x') && artifact.bytecode.length > 2, `${name} 缺少创建代码。`);
    assert(artifact.deployedBytecode?.startsWith('0x') && artifact.deployedBytecode.length > 2, `${name} 缺少运行代码。`);
    assert((artifact.deployedBytecode.length - 2) / 2 <= 24576, `${name} 超过 EIP-170 合约大小限制。`);
    new Interface(artifact.abi);
  }
  assert(new Interface(bundle.artifacts.AtomicDeployment.abi).getFunction('deploySingleOwner'), '构建缺少单钱包部署入口。');
  libraryDeploymentOrder(bundle);
}

export function linkBytecode(code: string, references: LinkReferences, addresses: Record<string, string>): string {
  let result = code.slice(2);
  for (const [source, libraries] of Object.entries(references ?? {})) {
    for (const [name, locations] of Object.entries(libraries)) {
      const address = getAddress(addresses[`${source}:${name}`] ?? addresses[name] ?? '');
      for (const { start, length } of locations) {
        assert(length === 20 && start >= 0 && (start + length) * 2 <= result.length, `库链接位置无效：${name}`);
        result = result.slice(0, start * 2) + address.slice(2).toLowerCase() + result.slice((start + length) * 2);
      }
    }
  }
  assert(/^[0-9a-fA-F]+$/.test(result) && result.length % 2 === 0, '仍存在未链接的库或无效字节码。');
  return `0x${result}`;
}

/** Match compiled runtime, excluding compiler-declared immutables checked separately by getters. */
export function runtimeMatches(artifact: DeploymentArtifact, actual: string, addresses: Record<string, string>, ownAddress: string): boolean {
  let expected = linkBytecode(artifact.deployedBytecode, artifact.deployedLinkReferences, addresses).slice(2).toLowerCase();
  let observed = actual.slice(2).toLowerCase();
  if (expected.length !== observed.length) return false;
  // Solidity libraries embed their deployment address in the PUSH20 delegatecall guard.
  if ((LIBRARY_NAMES as readonly string[]).includes(artifact.contractName) && expected.startsWith(`73${'0'.repeat(40)}`)) {
    expected = `73${ownAddress.slice(2).toLowerCase()}${expected.slice(42)}`;
  }
  for (const ranges of Object.values(artifact.immutableReferences ?? {})) {
    for (const { start, length } of ranges) {
      if (start < 0 || length <= 0 || (start + length) * 2 > expected.length) return false;
      expected = expected.slice(0, start * 2) + '0'.repeat(length * 2) + expected.slice((start + length) * 2);
      observed = observed.slice(0, start * 2) + '0'.repeat(length * 2) + observed.slice((start + length) * 2);
    }
  }
  return expected === observed;
}

async function walletAccount(wallet: Eip1193Provider, expected?: string): Promise<string> {
  const chain = await wallet.request({ method: 'eth_chainId' });
  assert(BigInt(String(chain)) === 56n, '请切换至 BSC 主网（Chain ID 56）；已暂停，未发送下一笔交易。');
  const accounts = await wallet.request({ method: 'eth_accounts' }) as string[];
  assert(Array.isArray(accounts) && accounts.length > 0, '请先连接钱包。');
  const account = getAddress(accounts[0]);
  if (expected) assert(sameAddress(account, expected), '钱包账户已改变；请切回原部署账户。');
  return account;
}

async function codeRecord(provider: BrowserProvider, address: string, requireCode = true): Promise<CodeRecord> {
  const code = await provider.getCode(address);
  if (requireCode) assert(code !== '0x', `${address} 没有合约代码。`);
  return { address: getAddress(address), codehash: keccak256(code), codeBytes: (code.length - 2) / 2 };
}

async function inspectMultisig(provider: BrowserProvider, address: string, twoOfThree: boolean): Promise<MultisigRecord> {
  const code = await codeRecord(provider, address);
  const contract = new Contract(address, MULTISIG_ABI, provider);
  const [thresholdValue, ownersValue] = await Promise.all([contract.getThreshold(), contract.getOwners()]);
  const threshold = Number(thresholdValue);
  const owners = Array.from(ownersValue as string[], getAddress);
  assert(Number.isSafeInteger(threshold) && threshold > 0 && threshold <= owners.length, '多签阈值配置无效。');
  assert(!owners.includes(ZeroAddress) && new Set(owners.map(x => x.toLowerCase())).size === owners.length, '多签签名人包含零地址或重复项。');
  if (twoOfThree) assert(threshold === 2 && owners.length === 3, '管理多签必须配置为 2/3。');
  return { ...code, threshold, owners };
}

export async function preflight(wallet: Eip1193Provider, bundle: ArtifactBundle, rawInput: DeploymentInput): Promise<PreflightReport> {
  validateArtifacts(bundle);
  const input = normalizeInput(rawInput, false);
  const account = await walletAccount(wallet);
  if (input.governanceMode === 'single') assert(sameAddress(input.ownerMultisig, account), '单钱包管理地址必须是本次连接并部署的钱包。');
  const provider = new BrowserProvider(wallet, 'any', { cacheTimeout: -1 });
  const [balance, feeData, owner, treasury, protocolEntries, latestNonce, pendingNonce] = await Promise.all([
    provider.getBalance(account), provider.getFeeData(),
    input.governanceMode === 'multisig' ? inspectMultisig(provider, input.ownerMultisig, true) : codeRecord(provider, input.ownerMultisig, false),
    input.governanceMode === 'multisig' ? inspectMultisig(provider, input.treasury, false) : codeRecord(provider, input.treasury, false),
    Promise.all(Object.entries(PROTOCOL_ADDRESSES).map(async ([name, address]) => [name, await codeRecord(provider, address)] as const)),
    provider.getTransactionCount(account, 'latest'), provider.getTransactionCount(account, 'pending'),
  ]);
  assert(latestNonce === pendingNonce, '部署账户还有待确认交易；请先处理，避免 nonce 冲突。');
  assert(feeData.gasPrice !== null && feeData.gasPrice <= parseUnits(input.gasPriceCapGwei, 'gwei'), '当前 Gas 单价高于设定上限，或 RPC 未返回费用。');
  assert(balance >= parseEther(input.maxGasBudgetBnb), '钱包 BNB 余额不足以覆盖设置的总 Gas 预算。');
  await walletAccount(wallet, account);
  const libraryOrder = libraryDeploymentOrder(bundle);
  return {
    chainId: 56, account, balanceWei: balance.toString(), gasPriceWei: feeData.gasPrice.toString(), artifactDigest: artifactDigest(bundle),
    owner, treasury, protocols: Object.fromEntries(protocolEntries), libraryOrder, transactionCount: libraryOrder.length + 5,
    warnings: [
      input.governanceMode === 'single' ? '单钱包控制管理和升级提案：密钥丢失或泄露会影响全部合约；48 小时延迟不能保证阻止恶意升级。' : 'getOwners / getThreshold 只验证接口配置，不能认证多签实现、模块或实际控制权。',
      '协议地址代码非空检查不等于协议安全审计；小额主网测试仍会消耗真实 BNB。',
      '分步部署只支付 Gas，不转入业务资金。拒绝或断线时已确认的部署费用不会退回。',
      '总 Gas 预算逐笔执行前检查；若后续成本超预算会保留进度并停止。钱包修改交易费用可突破页面预算。',
    ], checkedAt: new Date().toISOString(),
  };
}

export class DeploymentEngine {
  private readonly provider: BrowserProvider;
  private busy = false;
  constructor(private readonly wallet: Eip1193Provider, private readonly bundle: ArtifactBundle, private readonly callbacks: DeploymentCallbacks) {
    validateArtifacts(bundle);
    this.bundle = clone(bundle);
    this.provider = new BrowserProvider(wallet, 'any', { cacheTimeout: -1, pollingInterval: 1500 });
  }

  private async save(snapshot: DeploymentSnapshot): Promise<void> {
    snapshot.updatedAt = new Date().toISOString();
    const copy = clone(snapshot);
    try { await this.callbacks.persist(copy); }
    catch (error) {
      // Keep the returned hash visible/exportable even when durable storage fails after broadcasting.
      this.callbacks.onUpdate?.(copy);
      throw new Error(`无法保存部署进度，已停止后续交易。请导出当前记录：${errorMessage(error)}`);
    }
    this.callbacks.onUpdate?.(copy);
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    assert(!this.busy, '本页已有部署操作进行中。');
    this.busy = true;
    try {
      assert(typeof window === 'undefined' || (typeof navigator !== 'undefined' && navigator.locks), '当前浏览器不支持跨页面部署锁；请使用支持 Web Locks 的现代浏览器和 HTTPS / localhost。');
      if (typeof navigator !== 'undefined' && navigator.locks) {
        return await navigator.locks.request('pinkuang-deployment-chain56', { ifAvailable: true }, async lock => {
          assert(lock, '其他页面正在部署；请仅保留一个部署页面。');
          return action();
        });
      }
      return await action();
    } finally { this.busy = false; }
  }

  async start(rawInput: DeploymentInput): Promise<DeploymentSnapshot> {
    return this.exclusive(async () => {
      if (this.callbacks.readLatest) assert(await this.callbacks.readLatest() === null, '已有部署记录；请先恢复或导出并归档现有记录。');
      const input = normalizeInput(rawInput);
      const report = await preflight(this.wallet, this.bundle, input);
      const now = new Date().toISOString();
      const snapshot: DeploymentSnapshot = {
        schemaVersion: 1, id: `${Date.now()}-${report.account}`, chainId: 56, account: report.account,
        createdAt: now, updatedAt: now, artifactDigest: report.artifactDigest, sourceCommit: this.bundle.sourceCommit,
        input, status: 'ready', steps: this.stepIds().map(id => ({ id, label: id === 'initialize' ? '原子初始化治理与代理' : id, status: 'waiting' })),
        addresses: {}, spentWei: '0', preflight: report,
      };
      await this.save(snapshot);
      return this.run(snapshot);
    });
  }

  async resume(saved: DeploymentSnapshot): Promise<DeploymentSnapshot> {
    return this.exclusive(async () => {
      const snapshot = await this.latestSnapshot(saved);
      assert(snapshot.status !== 'aborted' && !snapshot.steps.some(step => step.replacementHash), '原部署 nonce 已被钱包替换，不能继续此计划；请保存旧记录并新建部署。');
      await this.restore(snapshot);
      if (isAborted(snapshot)) return snapshot;
      if (snapshot.steps.every(step => step.status === 'confirmed')) {
        snapshot.verification = await this.verifyGraph(snapshot);
        snapshot.status = 'complete'; delete snapshot.error;
        await this.save(snapshot);
        return snapshot;
      }
      if (snapshot.steps.some(step => ['submitted', 'uncertain', 'signing', 'failed'].includes(step.status))) {
        snapshot.status = 'paused';
        snapshot.error = '存在待确认、结果不明或链上失败的交易。仅核对回执，不会自动重发；请核对交易记录。';
        await this.save(snapshot);
        return snapshot;
      }
      // Refresh roles, code and network before any new signatures.
      const remainingBudget = parseEther(snapshot.input.maxGasBudgetBnb) - BigInt(snapshot.spentWei);
      assert(remainingBudget > 0n, '总 Gas 预算已耗尽，已停止。');
      // Preflight rechecks roles/protocols; remaining balance needs to cover only the unspent budget.
      const remainingInput = { ...snapshot.input, maxGasBudgetBnb: formatEther(remainingBudget) };
      snapshot.preflight = await preflight(this.wallet, this.bundle, remainingInput);
      return this.run(snapshot);
    });
  }

  /** Read-only recovery: never requests a signature and never rebroadcasts. */
  async reconcile(saved: DeploymentSnapshot): Promise<DeploymentSnapshot> {
    return this.exclusive(async () => {
      const snapshot = await this.latestSnapshot(saved);
      await this.restore(snapshot);
      if (snapshot.status === 'aborted') {
        await this.save(snapshot);
        return snapshot;
      }
      if (snapshot.steps.every(step => step.status === 'confirmed')) {
        snapshot.verification = await this.verifyGraph(snapshot);
        snapshot.status = 'complete'; delete snapshot.error;
      } else snapshot.status = 'paused';
      await this.save(snapshot);
      return snapshot;
    });
  }

  /** Attach a mined transaction to a write-ahead intent after its RPC response was lost. Never signs or broadcasts. */
  async recoverMinedTransaction(saved: DeploymentSnapshot, candidateHash: string): Promise<DeploymentSnapshot> {
    return this.exclusive(async () => {
      const hash = candidateHash.trim();
      assert(/^0x[0-9a-fA-F]{64}$/.test(hash), '请输入完整的 0x 开头交易哈希。');
      const snapshot = await this.latestSnapshot(saved);
      assert(snapshot.status !== 'aborted' && snapshot.steps.some(item =>
        (!item.txHash && (item.status === 'signing' || item.status === 'uncertain')) ||
        (item.txHash && item.status === 'submitted')),
        '当前没有可通过交易哈希恢复的部署步骤。');
      await this.restore(snapshot);
      if (isAborted(snapshot)) return snapshot;
      const step = snapshot.steps.find(item => (item.status === 'uncertain' && !item.txHash) ||
        (item.status === 'submitted' && !!item.txHash));
      assert(step, '当前没有可通过交易哈希恢复的部署步骤。');
      assert(snapshot.steps.slice(0, snapshot.steps.indexOf(step)).every(item => item.status === 'confirmed'), '前置部署交易尚未全部核验。');
      const [tx, receipt] = await Promise.all([
        this.provider.getTransaction(hash), this.provider.getTransactionReceipt(hash),
      ]);
      assert(tx && receipt, '链上暂未同时查到交易和回执；请等待交易确认，并检查哈希与 RPC。');
      assert(tx.hash.toLowerCase() === hash.toLowerCase() && receipt.hash.toLowerCase() === hash.toLowerCase(), '交易与回执哈希不一致。');
      assert(await receipt.confirmations() >= 2, '交易尚未达到 2 次确认，请稍后重试。');
      const block = await this.provider.getBlock(receipt.blockNumber);
      assert(block?.hash === receipt.blockHash && tx.blockHash === receipt.blockHash, '交易回执不在当前主链上。');
      assert(tx.chainId === 56n && sameAddress(tx.from, snapshot.account), '交易网络或发送者与本次部署不符。');
      assert(sameAddress(receipt.from, tx.from) &&
        ((receipt.to === null && tx.to === null) ||
          (receipt.to !== null && tx.to !== null && sameAddress(receipt.to, tx.to))) &&
        receipt.gasUsed <= tx.gasLimit &&
        receipt.fee === receipt.gasUsed * receipt.gasPrice, '交易回执与交易内容或 Gas 费用不一致。');
      assert(tx.nonce === step.nonce, '交易 nonce 与签名前保存的计划不一致。');
      const expected = await this.transaction(snapshot, step);
      const expectedDataHash = keccak256(expected.data as string);
      assert(step.dataHash === expectedDataHash, '签名前保存的部署计划内容与当前构建不一致。');
      assert(step.gasLimit && step.gasPriceWei && step.maxFeeWei &&
        BigInt(step.maxFeeWei) === BigInt(step.gasLimit) * BigInt(step.gasPriceWei),
        '签名前保存的 Gas 设置自相矛盾。');
      const samePayload = keccak256(tx.data) === expectedDataHash && tx.value === 0n &&
        ((expected.to == null && tx.to === null) ||
          (typeof expected.to === 'string' && tx.to !== null && sameAddress(tx.to, expected.to)));
      const feeOverride = tx.type !== 0 || tx.gasLimit > BigInt(step.gasLimit) ||
        tx.gasPrice > parseUnits(snapshot.input.gasPriceCapGwei, 'gwei') ||
        receipt.gasPrice > parseUnits(snapshot.input.gasPriceCapGwei, 'gwei');
      const isReplacement = !!step.txHash && step.txHash.toLowerCase() !== tx.hash.toLowerCase();
      const budgetExceeded = BigInt(snapshot.spentWei) + receipt.fee > parseEther(snapshot.input.maxGasBudgetBnb);
      if (isReplacement || !samePayload || feeOverride || budgetExceeded || receipt.status !== 1)
        await this.finalizedReplacement(snapshot, step, tx.hash);

      // Validate on a copy. An unrelated hash must never be saved into the deployment journal.
      const recovered = clone(snapshot);
      const recoveredStep = recovered.steps[snapshot.steps.indexOf(step)];
      if (!samePayload || receipt.status !== 1) {
        recoveredStep.replacementHash = tx.hash;
        recoveredStep.status = receipt.status !== 1 ? 'failed'
          : tx.to !== null && sameAddress(tx.to, snapshot.account) && tx.data === '0x' && tx.value === 0n
          ? 'cancelled' : 'replaced';
        recoveredStep.receipt = receiptRecord(receipt);
        recovered.spentWei = recovered.steps.reduce((sum, item) => sum + BigInt(item.receipt?.feeWei ?? '0'), 0n).toString();
        recovered.status = 'aborted';
        recovered.error = receipt.status !== 1
          ? '部署交易链上执行失败；旧计划不可继续。已记录实际 Gas，请保存旧记录后新建部署。'
          : '钱包已用同一 nonce 取消或替换部署交易；旧计划不可继续。已记录实际 Gas，请保存旧记录后新建部署。';
        await this.save(recovered);
        return recovered;
      }
      if (isReplacement) recoveredStep.previousTxHashes = [...(recoveredStep.previousTxHashes ?? []), step.txHash!];
      recoveredStep.finalizedRecovery = isReplacement || feeOverride || budgetExceeded;
      recoveredStep.txHash = tx.hash;
      await this.acceptReceipt(recovered, recoveredStep, receipt, !!recoveredStep.finalizedRecovery);
      assert(recoveredStep.status === 'confirmed', '交易仍待确认，请稍后重试。');
      const currentReceipt = await this.provider.getTransactionReceipt(tx.hash);
      const currentBlock = currentReceipt && await this.provider.getBlock(currentReceipt.blockNumber);
      assert(currentReceipt?.blockHash === receipt.blockHash && currentBlock?.hash === receipt.blockHash &&
        await currentReceipt.confirmations() >= 2, '交易回执已从当前主链移除，请重新核对。');
      recovered.status = 'paused';
      if (BigInt(recovered.spentWei) >= parseEther(recovered.input.maxGasBudgetBnb)) {
        recovered.error = '钱包加速后的实际 Gas 已达到或超过总预算；先提高预算，再继续部署。';
      } else delete recovered.error;
      // The receipt and Gas cost are durable even if the final deployment-graph audit fails.
      await this.save(recovered);
      if (recovered.steps.every(item => item.status === 'confirmed')) {
        try {
          recovered.verification = await this.verifyGraph(recovered);
          recovered.status = 'complete';
        } catch (error) {
          recovered.error = errorMessage(error);
          await this.save(recovered);
          throw error;
        }
        await this.save(recovered);
      }
      return recovered;
    });
  }

  /** Increase only fee limits on the existing deployment. No signing, role changes or replacement transactions. */
  async adjustLimits(saved: DeploymentSnapshot, limits: Pick<DeploymentInput, 'maxGasBudgetBnb' | 'gasPriceCapGwei'>): Promise<DeploymentSnapshot> {
    return this.exclusive(async () => {
      const snapshot = await this.latestSnapshot(saved);
      assert(snapshot.status !== 'complete' && snapshot.status !== 'aborted', '部署已完成或被钱包替换，不能提高预算继续旧计划。');
      await this.restore(snapshot);
      assert(!isAborted(snapshot), '部署交易链上失败或已被钱包替换，不能提高预算继续旧计划。');
      assert(!snapshot.steps.every(step => step.status === 'confirmed'), '部署已完成，无需提高预算。');
      assert(!snapshot.steps.some(step => ['submitted', 'signing', 'uncertain', 'failed'].includes(step.status)), '存在待确认、结果不明或链上失败交易，先核对回执；不能通过增加预算重发。');
      assert(parseEther(limits.maxGasBudgetBnb) >= parseEther(snapshot.input.maxGasBudgetBnb), '总 Gas 预算只能提高或保持不变。');
      assert(parseUnits(limits.gasPriceCapGwei, 'gwei') >= parseUnits(snapshot.input.gasPriceCapGwei, 'gwei'), 'Gas 单价上限只能提高或保持不变。');
      const updatedInput = normalizeInput({ ...snapshot.input, maxGasBudgetBnb: limits.maxGasBudgetBnb, gasPriceCapGwei: limits.gasPriceCapGwei });
      const remaining = parseEther(updatedInput.maxGasBudgetBnb) - BigInt(snapshot.spentWei);
      assert(remaining > 0n, '调整后的总预算必须高于已花费费用。');
      const report = await preflight(this.wallet, this.bundle, { ...updatedInput, maxGasBudgetBnb: formatEther(remaining) });
      snapshot.input = updatedInput;
      snapshot.preflight = report;
      snapshot.status = 'paused'; delete snapshot.error;
      await this.save(snapshot);
      return snapshot;
    });
  }

  private stepIds(): string[] { return [...libraryDeploymentOrder(this.bundle), 'AtomicDeployment', 'PoolVault', 'PoolFactory', 'ShareMarket', 'initialize']; }

  private async latestSnapshot(saved: DeploymentSnapshot): Promise<DeploymentSnapshot> {
    if (!this.callbacks.readLatest) return clone(saved);
    const latest = await this.callbacks.readLatest();
    assert(latest && latest.id === saved.id, '部署记录已被另一页面更换或归档，请刷新后核对最新记录。');
    return clone(latest);
  }

  private async finalizedReplacement(snapshot: DeploymentSnapshot, step: StepRecord, hash: string): Promise<{ tx: TransactionResponse; receipt: TransactionReceipt }> {
    const [tx, receipt] = await Promise.all([this.provider.getTransaction(hash), this.provider.getTransactionReceipt(hash)]);
    assert(tx && receipt, '替换交易尚无完整链上交易与回执，原部署仍暂停。');
    assert(tx.hash.toLowerCase() === hash.toLowerCase() && receipt.hash.toLowerCase() === hash.toLowerCase(), '替换交易与回执哈希不一致。');
    assert((await this.provider.getNetwork()).chainId === 56n && tx.chainId === 56n && sameAddress(tx.from, snapshot.account)
      && tx.nonce === step.nonce, '替换交易的链、账户或 nonce 与原部署不匹配。');
    assert(sameAddress(receipt.from, tx.from) &&
      ((receipt.to === null && tx.to === null) || (receipt.to !== null && tx.to !== null && sameAddress(receipt.to, tx.to))) &&
      receipt.gasUsed <= tx.gasLimit && receipt.fee === receipt.gasUsed * receipt.gasPrice &&
      (receipt.status === 0 || receipt.status === 1), '替换交易回执身份或费用不一致。');
    const [canonical, finalized, latest] = await Promise.all([
      this.provider.getBlock(receipt.blockNumber), this.provider.getBlock('finalized'), this.provider.getBlock('latest'),
    ]);
    assert(canonical?.hash === receipt.blockHash && tx.blockHash === receipt.blockHash,
      '替换交易回执不在当前规范链上，原部署仍暂停。');
    assert(finalized?.hash && latest && finalized.number >= receipt.blockNumber && latest.number - receipt.blockNumber + 1 >= 2,
      '替换交易尚未达到 BSC 最终性和 2 次确认，原部署仍暂停。');
    assert(await this.provider.getTransactionCount(snapshot.account, finalized.number) > step.nonce,
      '最终区块中原 nonce 尚未消耗，原部署仍暂停。');
    const [currentReceipt, currentBlock, finalizedBlock] = await Promise.all([
      this.provider.getTransactionReceipt(hash), this.provider.getBlock(receipt.blockNumber), this.provider.getBlock(finalized.number),
    ]);
    assert(currentReceipt?.blockHash === receipt.blockHash && currentBlock?.hash === receipt.blockHash &&
      finalizedBlock?.hash === finalized.hash, '替换交易核验期间规范链发生变化，原部署仍暂停。');
    return { tx, receipt };
  }

  private async restore(snapshot: DeploymentSnapshot): Promise<void> {
    validateArtifacts(this.bundle);
    assert(snapshot.schemaVersion === 1 && snapshot.chainId === 56, '部署记录格式或网络错误。');
    assert(snapshot.artifactDigest === artifactDigest(this.bundle), '构建产物已改变，不能将旧进度与新字节码混合；请使用原构建核对。');
    snapshot.input = normalizeInput(snapshot.input);
    await walletAccount(this.wallet, snapshot.account);
    if (snapshot.input.governanceMode === 'single') assert(sameAddress(snapshot.input.ownerMultisig, snapshot.account), '记录中的单钱包管理地址不匹配部署账户。');
    assert(JSON.stringify(snapshot.steps.map(step => step.id)) === JSON.stringify(this.stepIds()), '部署步骤与当前构建不匹配。');
    let aborted = snapshot.status === 'aborted' || snapshot.steps.some(step => !!step.replacementHash);
    snapshot.status = aborted ? 'aborted' : 'paused';
    delete snapshot.verification;
    await this.save(snapshot);
    snapshot.addresses = {};
    let seenUnconfirmed = false;
    for (const step of snapshot.steps) {
      if (step.replacementHash) {
        assert(!seenUnconfirmed, '被替换步骤之前仍有未核验的部署交易。');
        const { tx, receipt } = await this.finalizedReplacement(snapshot, step, step.replacementHash);
        const expected = await this.transaction(snapshot, step);
        const expectedHash = keccak256(expected.data as string);
        assert(step.dataHash === expectedHash, '旧部署交易计划已改变，不能核对替换结果。');
        const samePayload = tx.value === 0n && keccak256(tx.data) === expectedHash &&
          ((expected.to == null && tx.to === null) || (typeof expected.to === 'string' && tx.to !== null && sameAddress(tx.to, expected.to)));
        assert(!samePayload || receipt.status === 0, '替换记录与原计划内容相同，不能将有效部署标记为终止。');
        step.status = receipt.status === 0 ? 'failed'
          : tx.to !== null && sameAddress(tx.to, snapshot.account) && tx.data === '0x' && tx.value === 0n
          ? 'cancelled' : 'replaced';
        step.receipt = receiptRecord(receipt);
        seenUnconfirmed = true;
        continue;
      }
      if (step.txHash) {
        assert(!seenUnconfirmed, '后续交易依赖一个尚未验证的步骤。');
        const receipt = step.finalizedRecovery
          ? (await this.finalizedReplacement(snapshot, step, step.txHash)).receipt
          : await this.provider.getTransactionReceipt(step.txHash);
        if (receipt?.status === 0) {
          await this.finalizedReplacement(snapshot, step, step.txHash);
          step.replacementHash = step.txHash;
          step.status = 'failed'; step.receipt = receiptRecord(receipt);
          snapshot.status = 'aborted'; aborted = true; seenUnconfirmed = true;
        } else if (receipt) { await this.acceptReceipt(snapshot, step, receipt, !!step.finalizedRecovery); if (step.status !== 'confirmed') seenUnconfirmed = true; }
        else { step.status = 'submitted'; seenUnconfirmed = true; }
      } else {
        assert(step.status !== 'confirmed' && step.status !== 'submitted', '已发送的部署步骤缺少交易哈希。');
        if (step.status === 'signing') step.status = 'uncertain';
        seenUnconfirmed = true;
      }
    }
    snapshot.spentWei = snapshot.steps.reduce((sum, step) => sum + BigInt(step.receipt?.feeWei ?? '0'), 0n).toString();
    if (aborted) snapshot.error = snapshot.steps.some(step => step.status === 'failed')
      ? '部署交易链上执行失败；旧计划不可继续。已记录实际 Gas，请保存旧记录后新建部署。'
      : '钱包已用同一 nonce 取消或替换部署交易；旧计划不可继续。已记录实际 Gas，请保存旧记录后新建部署。';
    await this.save(snapshot);
  }

  private async transaction(snapshot: DeploymentSnapshot, step: StepRecord): Promise<TransactionRequest> {
    if (step.id === 'initialize') {
      const iface = new Interface(this.bundle.artifacts.AtomicDeployment.abi);
      return { to: snapshot.addresses.AtomicDeployment, value: 0n, data: iface.encodeFunctionData(snapshot.input.governanceMode === 'single' ? 'deploySingleOwner' : 'deploy', [{
        ownerMultisig: snapshot.input.ownerMultisig, operator: snapshot.input.operator, treasury: snapshot.input.treasury,
        vaultImplementation: snapshot.addresses.PoolVault, factoryImplementation: snapshot.addresses.PoolFactory, marketImplementation: snapshot.addresses.ShareMarket,
      }]) };
    }
    const artifact = this.bundle.artifacts[step.id];
    const code = linkBytecode(artifact.bytecode, artifact.linkReferences, snapshot.addresses);
    const args: unknown[] = [];
    if (step.id === 'PoolVault') {
      const coordinator = new Contract(snapshot.addresses.AtomicDeployment, this.bundle.artifacts.AtomicDeployment.abi, this.provider);
      args.push(await coordinator.predictedFactory());
    }
    return new ContractFactory(artifact.abi, code).getDeployTransaction(...args);
  }

  private async run(snapshot: DeploymentSnapshot): Promise<DeploymentSnapshot> {
    snapshot.status = 'running'; delete snapshot.error;
    await this.save(snapshot);
    try {
      for (const step of snapshot.steps) {
        if (step.status === 'confirmed') continue;
        assert(step.status === 'waiting' || step.status === 'rejected', '步骤结果不明，禁止重复广播。');
        await this.sendStep(snapshot, step);
      }
      snapshot.verification = await this.verifyGraph(snapshot, true);
      snapshot.status = 'complete';
      await this.save(snapshot);
      return snapshot;
    } catch (error) {
      snapshot.status = snapshot.steps.some(step => step.status === 'failed') ? 'failed' : 'paused';
      snapshot.error = errorMessage(error);
      await this.save(snapshot);
      throw error;
    }
  }

  private async sendStep(snapshot: DeploymentSnapshot, step: StepRecord): Promise<void> {
    verifyArtifactIntegrity(this.bundle);
    await walletAccount(this.wallet, snapshot.account);
    const transaction = await this.transaction(snapshot, step);
    transaction.from = snapshot.account; transaction.value = 0n; transaction.chainId = 56;
    const [estimated, fee, balance, nonce, pendingNonce, block] = await Promise.all([
      this.provider.estimateGas(transaction), this.provider.getFeeData(), this.provider.getBalance(snapshot.account),
      this.provider.getTransactionCount(snapshot.account, 'latest'), this.provider.getTransactionCount(snapshot.account, 'pending'),
      this.provider.getBlock('latest'),
    ]);
    assert(nonce === pendingNonce, '账户出现其他待确认交易；部署已暂停。');
    assert(fee.gasPrice !== null && fee.gasPrice > 0n, '无法读取 Gas 单价。');
    const cap = parseUnits(snapshot.input.gasPriceCapGwei, 'gwei');
    assert(fee.gasPrice <= cap, '当前 Gas 单价超过设定上限。');
    const gasLimit = (estimated * 120n + 99n) / 100n;
    assert(block && gasLimit <= block.gasLimit, '该笔部署超过区块 Gas 上限。');
    const maxFee = gasLimit * fee.gasPrice;
    assert(BigInt(snapshot.spentWei) + maxFee <= parseEther(snapshot.input.maxGasBudgetBnb), '下一笔交易可能超过总 Gas 预算，已停止。');
    assert(balance >= maxFee, '余额不足以支付下一笔交易 Gas。');
    transaction.gasLimit = gasLimit; transaction.gasPrice = fee.gasPrice; transaction.nonce = nonce; transaction.type = 0;
    Object.assign(step, { status: 'signing', nonce, gasEstimate: estimated.toString(), gasLimit: gasLimit.toString(), gasPriceWei: fee.gasPrice.toString(), maxFeeWei: maxFee.toString(), dataHash: keccak256(transaction.data as string) });
    delete step.error;
    // Write-ahead intent makes a reload between wallet acceptance and hash delivery fail closed.
    await this.save(snapshot);
    let attemptedBroadcast = false;
    try {
      await walletAccount(this.wallet, snapshot.account);
      const signer = await this.provider.getSigner(snapshot.account);
      verifyArtifactIntegrity(this.bundle);
      attemptedBroadcast = true;
      const hash = await signer.sendUncheckedTransaction(transaction);
      step.txHash = hash; step.status = 'submitted';
      await this.save(snapshot);
    } catch (error) {
      if (!step.txHash) {
        const failure = error as { code?: string | number; info?: { error?: { code?: number } } };
        step.status = !attemptedBroadcast ? 'waiting' : failure.code === 'ACTION_REJECTED' || failure.code === 4001 || failure.info?.error?.code === 4001 ? 'rejected' : 'uncertain';
      }
      step.error = errorMessage(error);
      await this.save(snapshot);
      throw error;
    }
    const receipt = await this.provider.waitForTransaction(step.txHash!, 2, 120_000);
    assert(receipt, '交易仍在确认中；请稍后只读核对回执，不要重复部署。');
    await walletAccount(this.wallet, snapshot.account);
    await this.acceptReceipt(snapshot, step, receipt);
    assert(['confirmed'].includes(step.status), '交易确认数不足，请稍后核对回执。');
    await this.save(snapshot);
  }

  private async acceptReceipt(snapshot: DeploymentSnapshot, step: StepRecord, receipt: TransactionReceipt, finalizedRecovery = false): Promise<void> {
    step.receipt = receiptRecord(receipt);
    snapshot.spentWei = snapshot.steps.reduce((sum, item) => sum + BigInt(item.receipt?.feeWei ?? '0'), 0n).toString();
    if (receipt.status !== 1) { step.status = 'failed'; await this.save(snapshot); throw new Error(`${step.label} 链上执行失败，费用已计入；不会自动重发。`); }
    if (await receipt.confirmations() < 2) { step.status = 'submitted'; await this.save(snapshot); return; }
    const tx = await this.provider.getTransaction(receipt.hash);
    assert(tx && tx.chainId === 56n && sameAddress(tx.from, snapshot.account), '交易网络或发送者与本次部署不符。');
    const expected = await this.transaction(snapshot, step);
    assert(tx.value === 0n && keccak256(tx.data) === keccak256(expected.data as string), '钱包实际发送的交易内容与编译部署计划不一致。');
    assert((expected.to == null && tx.to === null) || (typeof expected.to === 'string' && tx.to !== null && sameAddress(tx.to, expected.to)), '交易目标地址与计划不一致。');
    assert(step.nonce === tx.nonce, '交易 nonce 与记录不一致。');
    if (!finalizedRecovery) {
      assert(tx.gasLimit <= BigInt(step.gasLimit ?? '0') && tx.gasPrice <= parseUnits(snapshot.input.gasPriceCapGwei, 'gwei'), '钱包修改了 Gas 设置并超出页面限制；已停止后续交易。');
      assert(BigInt(snapshot.spentWei) <= parseEther(snapshot.input.maxGasBudgetBnb), '累计真实 Gas 费用超过预算。');
    }
    if (step.id !== 'initialize') {
      const address = getCreateAddress({ from: snapshot.account, nonce: tx.nonce });
      assert(receipt.contractAddress && sameAddress(receipt.contractAddress, address), '部署地址与交易回执不一致。');
      const code = await this.provider.getCode(address);
      assert(runtimeMatches(this.bundle.artifacts[step.id], code, snapshot.addresses, address), `${step.id} 链上运行代码与本次构建不匹配。`);
      snapshot.addresses[step.id] = address; step.address = address; step.codehash = keccak256(code);
      const contract = new Contract(address, this.bundle.artifacts[step.id].abi, this.provider);
      if (step.id === 'AtomicDeployment') assert(sameAddress(await contract.deployer(), snapshot.account), '协调器固定部署者不匹配。');
      if (step.id === 'PoolVault') {
        const coordinator = new Contract(snapshot.addresses.AtomicDeployment, this.bundle.artifacts.AtomicDeployment.abi, this.provider);
        assert(sameAddress(await contract.OFFICIAL_FACTORY(), await coordinator.predictedFactory()), 'Vault immutable 工厂绑定不匹配。');
      }
      if (step.id === 'PoolFactory' || step.id === 'ShareMarket') assert((await contract.proxiableUUID()).toLowerCase() === IMPLEMENTATION_SLOT, '实现不是预期 UUPS 存储槽。');
    }
    step.status = 'confirmed'; delete step.error;
  }

  private async verifyGraph(snapshot: DeploymentSnapshot, requireInitialEmpty = false): Promise<DeploymentVerification> {
    await walletAccount(this.wallet, snapshot.account);
    const coordinator = new Contract(snapshot.addresses.AtomicDeployment, this.bundle.artifacts.AtomicDeployment.abi, this.provider);
    const result = await coordinator.deployment();
    const addresses = { timelock: getAddress(result.timelock), beacon: getAddress(result.beacon), factory: getAddress(result.factory), shareMarket: getAddress(result.shareMarket) };
    Object.assign(snapshot.addresses, addresses);
    const factory = new Contract(addresses.factory, this.bundle.artifacts.PoolFactory.abi, this.provider);
    const lensAddress = getAddress(await factory.lens());
    assert(lensAddress !== ZeroAddress, 'Factory 尚未创建 Lens。');
    snapshot.addresses.lens = lensAddress;
    const lens = new Contract(lensAddress, this.bundle.artifacts.PoolLens.abi, this.provider);
    const market = new Contract(addresses.shareMarket, this.bundle.artifacts.ShareMarket.abi, this.provider);
    const timelock = new Contract(addresses.timelock, this.bundle.artifacts.PoolTimelock.abi, this.provider);
    const beacon = new Contract(addresses.beacon, this.bundle.artifacts.PoolBeacon.abi, this.provider);
    const checks: VerificationCheck[] = [];
    const check = (label: string, actual: unknown, expected: unknown) => {
      const passed = String(actual).toLowerCase() === String(expected).toLowerCase();
      checks.push({ label, passed, actual: String(actual), expected: String(expected) });
    };
    check('协调器初始化完成', await coordinator.deployed(), true);
    check('Factory CREATE 绑定', addresses.factory, await coordinator.predictedFactory());
    check('Factory.lens', await factory.lens(), lensAddress);
    check('Lens.factory', await lens.factory(), addresses.factory);
    for (const [getter, expected] of Object.entries({ owner: snapshot.input.ownerMultisig, operator: snapshot.input.operator, treasury: snapshot.input.treasury, timelock: addresses.timelock, beacon: addresses.beacon, shareMarket: addresses.shareMarket })) {
      check(`Factory.${getter}`, await factory[getter](), expected);
    }
    check('Beacon.owner', await beacon.owner(), addresses.timelock);
    check('Beacon.implementation', await beacon.implementation(), snapshot.addresses.PoolVault);
    check('Beacon.OFFICIAL_FACTORY', await beacon.OFFICIAL_FACTORY(), addresses.factory);
    check('Market.factory', await market.factory(), addresses.factory);
    check('Market.timelock', await market.timelock(), addresses.timelock);
    check('升级最小延迟', await timelock.getMinDelay(), UPGRADE_DELAY_SECONDS);
    check('延迟硬下限', await timelock.MINIMUM_DELAY(), UPGRADE_DELAY_SECONDS);
    const proposer = await timelock.PROPOSER_ROLE(); const canceller = await timelock.CANCELLER_ROLE();
    const executor = await timelock.EXECUTOR_ROLE(); const admin = await timelock.DEFAULT_ADMIN_ROLE();
    check('管理地址提案权', await timelock.hasRole(proposer, snapshot.input.ownerMultisig), true);
    check('管理地址取消权', await timelock.hasRole(canceller, snapshot.input.ownerMultisig), true);
    check('到期公开执行', await timelock.hasRole(executor, ZeroAddress), true);
    check('Timelock 自管理', await timelock.hasRole(admin, addresses.timelock), true);
    check('部署者没有 Timelock admin', await timelock.hasRole(admin, snapshot.account), false);
    check('协调器没有 Timelock admin', await timelock.hasRole(admin, snapshot.addresses.AtomicDeployment), false);
    const slotAddress = async (address: string) => getAddress(`0x${(await this.provider.getStorage(address, IMPLEMENTATION_SLOT)).slice(-40)}`);
    check('Factory UUPS 实现槽', await slotAddress(addresses.factory), snapshot.addresses.PoolFactory);
    check('Market UUPS 实现槽', await slotAddress(addresses.shareMarket), snapshot.addresses.ShareMarket);
    const poolCount: bigint = await factory.poolCount();
    if (requireInitialEmpty) check('初始池子数量', poolCount, 0);
    else checks.push({ label: '当前池子数量', passed: true, actual: poolCount.toString(), expected: '部署完成后允许创建资金池' });
    const code: Record<string, CodeRecord> = {};
    for (const [name, address] of Object.entries(snapshot.addresses)) {
      code[name] = await codeRecord(this.provider, address);
      const artifactName = ({ factory: 'ERC1967Proxy', shareMarket: 'ERC1967Proxy', timelock: 'PoolTimelock', beacon: 'PoolBeacon', lens: 'PoolLens' } as Record<string, string>)[name] ?? name;
      check(`${name} 运行代码匹配`, runtimeMatches(this.bundle.artifacts[artifactName], await this.provider.getCode(address), snapshot.addresses, address), true);
    }
    const verification = { checkedAt: new Date().toISOString(), blockNumber: await this.provider.getBlockNumber(), checks, code };
    snapshot.verification = verification;
    assert(checks.every(item => item.passed), `部署后校验失败：${checks.filter(item => !item.passed).map(item => item.label).join('、')}`);
    return verification;
  }
}
