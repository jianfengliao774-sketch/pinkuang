import {
  BrowserProvider, Contract, ContractFactory, Interface, ZeroAddress,
  formatEther, getAddress, getCreateAddress, keccak256, parseEther, parseUnits, toUtf8Bytes,
  type Eip1193Provider, type InterfaceAbi, type TransactionReceipt, type TransactionRequest, type TransactionResponse,
} from 'ethers';
import { verifyInitializationExecution } from '../shared/initialization-proof.mjs';

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
  'FirstoSale',
] as const;

/** Current execution dependencies only; existence does not certify the protocols. */
export const PROTOCOL_ADDRESSES: Record<string, string> = {
  TAPEOUT_CIRCUITS: '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C',
  BEHEMOTH_CIRCUITS: '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C',
  MINING: '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46',
  CIRCUIT_MARKET: '0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f',
  BEM: '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a',
  FIRSTO_SIGNED_ASK_V2: '0x33423244F9a5bF81b12B1a018aF6F4e079B97f29',
  PROTOCOL_FACTORY: '0x68224F668083c29e9800Be2a646d42d18cedF7e2',
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
  initializationExecution?: ReturnType<typeof verifyInitializationExecution>;
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
  /** A definite pre-broadcast stop or explicit EIP-1193 user rejection. */
  rejectionKind?: 'pre-send' | 'wallet-rejected';
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
  kind?: 'integrated-v2';
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
  /** Recheck the server's currently served artifact immediately before each wallet request. */
  assertCurrentArtifact?: (digest: string) => void | Promise<void>;
  /** An independent RPC witness; browser-wallet nonce responses can be stale. */
  readCurrentNonce?: () => Promise<{ latest: number; pending: number }>;
  /** Server checks its own nonce witness and atomically changes only the known failed envelope. */
  releaseInvalidEnvelope?: (nonce: number) => Promise<DeploymentSnapshot>;
  onUpdate?: (snapshot: DeploymentSnapshot) => void;
  /** Read inside the cross-tab lock; prevents a stale tab from replaying already-completed steps. */
  readLatest?: () => DeploymentSnapshot | null | Promise<DeploymentSnapshot | null>;
}

const MULTISIG_ABI = ['function getThreshold() view returns(uint256)', 'function getOwners() view returns(address[])'];
const REQUIRED_ARTIFACTS = [...LIBRARY_NAMES, 'AtomicDeployment', 'PoolVault', 'PoolFactory', 'FreshPoolFactory', 'ShareMarket', 'BudgetPortfolioFactory', 'BudgetPortfolioVault', 'PlatformAuthority', 'PoolTimelock', 'PoolBeacon', 'ERC1967Proxy', 'PoolLens'];
export const INTEGRATED_TRANSACTION_COUNT = LIBRARY_NAMES.length + 7;
// The fresh deployment gas limits were checked against this exact artifact
// bundle in a disposable BSC-chain-id 56 deployment (16 receipts), each with
// at least 10% headroom. A changed bundle needs a new reviewed plan before
// any wallet request.
const FRESH_GAS_PLAN_ARTIFACT_DIGEST = '0x9523dd920e91dcab4358eceddff660d65357bfe1fe3bf6f3e7823cbc94af2502';
const FRESH_STEP_GAS_LIMITS: Readonly<Record<string, bigint>> = Object.freeze({
  MiningOperations: 1810000n,
  PoolFunds: 1200000n,
  RewardAccounting: 1490000n,
  SaleGovernance: 1580000n,
  SaleSettlement: 1310000n,
  FirstoSale: 5250000n,
  PurchaseValidation: 1550000n,
  FlexiblePurchase: 3790000n,
  ShareCheckpoints: 540000n,
  AtomicDeployment: 6070000n,
  PoolVault: 7040000n,
  FreshPoolFactory: 6700000n,
  ShareMarket: 3860000n,
  BudgetPortfolioFactory: 2870000n,
  BudgetPortfolioVault: 7020000n,
  initialize: 6870000n,
});
function freshGasLimit(snapshot: DeploymentSnapshot, step: StepRecord): bigint {
  assert(snapshot.artifactDigest === FRESH_GAS_PLAN_ARTIFACT_DIGEST,
    '正式版构建产物与已核对的 Gas 计划不同；请重新测量并审核后再签名。');
  const limit = FRESH_STEP_GAS_LIMITS[step.id];
  assert(limit !== undefined && limit > 0n, `缺少 ${step.id} 的正式版 Gas 上限。`);
  return limit;
}
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
  assert(new Interface(bundle.artifacts.AtomicDeployment.abi).getFunction('deployIntegratedSingleOwner'), '构建缺少多机项目集成部署入口。');
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
  const [chain, accounts] = await Promise.all([
    wallet.request({ method: 'eth_chainId' }), wallet.request({ method: 'eth_accounts' }),
  ]);
  assert(BigInt(String(chain)) === 56n, '请切换至 BSC 主网（Chain ID 56）；已暂停，未发送下一笔交易。');
  assert(Array.isArray(accounts) && accounts.length > 0, '请先连接钱包。');
  const account = getAddress(accounts[0] as string);
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

const PREFLIGHT_REUSE_MS = 60_000;
const reviewedPreflights = new WeakMap<PreflightReport, { wallet: Eip1193Provider; key: string; checkedAt: number; report: PreflightReport }>();

function preflightKey(input: DeploymentInput, digest: string): string {
  return JSON.stringify([
    digest, input.governanceMode, input.ownerMultisig, input.operator, input.treasury,
    input.maxGasBudgetBnb, input.gasPriceCapGwei,
  ]);
}

async function currentWalletConditions(provider: BrowserProvider, account: string, input: DeploymentInput): Promise<Pick<PreflightReport, 'balanceWei' | 'gasPriceWei'>> {
  const [balance, feeData, latestNonce, pendingNonce] = await Promise.all([
    provider.getBalance(account), provider.getFeeData(),
    provider.getTransactionCount(account, 'latest'), provider.getTransactionCount(account, 'pending'),
  ]);
  assert(latestNonce === pendingNonce, '部署账户还有待确认交易；请先处理，避免 nonce 冲突。');
  assert(feeData.gasPrice !== null && feeData.gasPrice <= parseUnits(input.gasPriceCapGwei, 'gwei'), '当前 Gas 单价高于设定上限，或 RPC 未返回费用。');
  assert(balance >= parseEther(input.maxGasBudgetBnb), '钱包 BNB 余额不足以覆盖设置的总 Gas 预算。');
  return { balanceWei: balance.toString(), gasPriceWei: feeData.gasPrice.toString() };
}

export async function preflight(wallet: Eip1193Provider, bundle: ArtifactBundle, rawInput: DeploymentInput): Promise<PreflightReport> {
  validateArtifacts(bundle);
  const input = normalizeInput(rawInput, false);
  const account = await walletAccount(wallet);
  if (input.governanceMode === 'single') assert(sameAddress(input.ownerMultisig, account), '单钱包管理地址必须是本次连接并部署的钱包。');
  const provider = new BrowserProvider(wallet, 'any', { cacheTimeout: -1 });
  const [current, owner, treasury, protocolEntries] = await Promise.all([
    currentWalletConditions(provider, account, input),
    input.governanceMode === 'multisig' ? inspectMultisig(provider, input.ownerMultisig, true) : codeRecord(provider, input.ownerMultisig, false),
    input.governanceMode === 'multisig' ? inspectMultisig(provider, input.treasury, false) : codeRecord(provider, input.treasury, false),
    Promise.all(Object.entries(PROTOCOL_ADDRESSES).map(async ([name, address]) => [name, await codeRecord(provider, address)] as const)),
  ]);
  await walletAccount(wallet, account);
  const libraryOrder = libraryDeploymentOrder(bundle);
  const report: PreflightReport = {
    chainId: 56, account, ...current, artifactDigest: artifactDigest(bundle),
    owner, treasury, protocols: Object.fromEntries(protocolEntries), libraryOrder, transactionCount: libraryOrder.length + 7,
    warnings: [
      input.governanceMode === 'single' ? '单钱包控制管理和升级提案：密钥丢失或泄露会影响全部合约；48 小时延迟不能保证阻止恶意升级。' : 'getOwners / getThreshold 只验证接口配置，不能认证多签实现、模块或实际控制权。',
      '协议地址代码非空检查不等于协议安全审计；小额主网测试仍会消耗真实 BNB。',
      '分步部署只支付 Gas，不转入业务资金。拒绝或断线时已确认的部署费用不会退回。',
      '总 Gas 预算逐笔执行前检查；若后续成本超预算会保留进度并停止。钱包修改交易费用可突破页面预算。',
    ], checkedAt: new Date().toISOString(),
  };
  reviewedPreflights.set(report, { wallet, key: preflightKey(input, report.artifactDigest), checkedAt: Date.now(), report: clone(report) });
  return report;
}

async function freshPreflight(wallet: Eip1193Provider, bundle: ArtifactBundle, input: DeploymentInput, reviewed?: PreflightReport): Promise<PreflightReport> {
  const previous = reviewed && reviewedPreflights.get(reviewed);
  const now = Date.now();
  if (!previous || previous.wallet !== wallet || now < previous.checkedAt || now - previous.checkedAt > PREFLIGHT_REUSE_MS ||
      previous.key !== preflightKey(input, artifactDigest(bundle))) return preflight(wallet, bundle, input);

  // The page already checked static roles and official code moments ago. Recheck the
  // mutable wallet, nonce, fee and balance before creating any signed intent.
  const account = await walletAccount(wallet, previous.report.account);
  if (input.governanceMode === 'single') assert(sameAddress(input.ownerMultisig, account), '单钱包管理地址必须是本次连接并部署的钱包。');
  const provider = new BrowserProvider(wallet, 'any', { cacheTimeout: -1 });
  const current = await currentWalletConditions(provider, account, input);
  await walletAccount(wallet, account);
  return { ...clone(previous.report), ...current, checkedAt: new Date().toISOString() };
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

  async start(rawInput: DeploymentInput, reviewed?: PreflightReport): Promise<DeploymentSnapshot> {
    return this.exclusive(async () => {
      if (this.callbacks.readLatest) assert(await this.callbacks.readLatest() === null, '已有部署记录；请先恢复或导出并归档现有记录。');
      const input = normalizeInput(rawInput);
      assert(input.governanceMode === 'single', '本次完整部署使用已确认的单钱包管理；旧多签部署记录仅供核对恢复。');
      const report = await freshPreflight(this.wallet, this.bundle, input, reviewed);
      assert(sameAddress(input.ownerMultisig, report.account)
        && sameAddress(input.operator, report.account) && sameAddress(input.treasury, report.account),
      '本次新部署的 owner、operator 和 treasury 必须均为当前硬件钱包。');
      const now = new Date().toISOString();
      const snapshot: DeploymentSnapshot = {
        schemaVersion: 1, kind: 'integrated-v2', id: `${Date.now()}-${report.account}`, chainId: 56, account: report.account,
        createdAt: now, updatedAt: now, artifactDigest: report.artifactDigest, sourceCommit: this.bundle.sourceCommit,
        input, status: 'ready', steps: this.stepIds('integrated-v2').map(id => ({ id, label: id === 'initialize' ? '原子初始化单机与多机项目' : id, status: 'waiting' })),
        addresses: {}, spentWei: '0', preflight: report,
      };
      await this.save(snapshot);
      return this.run(snapshot);
    });
  }

  async resume(saved: DeploymentSnapshot): Promise<DeploymentSnapshot> {
    return this.exclusive(async () => {
      const snapshot = await this.latestSnapshot(saved);
      assert(snapshot.status !== 'aborted' && !snapshot.steps.some(step => step.replacementHash), '原部署已终止，不能继续此计划；请保存旧记录并新建部署。');
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
      this.assertFreshSigningRoles(snapshot);
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

  /** A wallet-side envelope validation error is definite only while both nonce views remain unused. */
  async releaseInvalidEnvelope(saved: DeploymentSnapshot): Promise<DeploymentSnapshot> {
    return this.exclusive(async () => {
      const snapshot = await this.latestSnapshot(saved);
      await this.restore(snapshot);
      const step = snapshot.steps.find(item => item.status === 'uncertain' && !item.txHash);
      assert(step && step.id === 'initialize' && Number.isSafeInteger(step.nonce),
        '当前没有可解除的初始化交易格式错误。');
      assert(step.error?.includes('Invalid transaction envelope type: specified type "0x4" but included a gasPrice instead of maxFeePerGas and maxPriorityFeePerGas'),
        '这不是已确认的交易格式错误；必须通过交易哈希核对。');
      assert(this.callbacks.readCurrentNonce, '缺少独立节点 nonce 核对，不能解除结果不明状态。');
      const [independent, walletLatest, walletPending] = await Promise.all([
        this.callbacks.readCurrentNonce(),
        this.provider.getTransactionCount(snapshot.account, 'latest'),
        this.provider.getTransactionCount(snapshot.account, 'pending'),
      ]);
      assert(independent.latest === step.nonce && independent.pending === step.nonce &&
        walletLatest === step.nonce && walletPending === step.nonce,
        '部署账户的 nonce 已变化或存在待确认交易；先核对交易哈希。');
      assert(this.callbacks.releaseInvalidEnvelope, '服务器不支持交易格式错误的受控恢复。');
      const released = await this.callbacks.releaseInvalidEnvelope(step.nonce!);
      assert(released.id === snapshot.id && released.steps.at(-1)?.nonce === step.nonce &&
        released.steps.at(-1)?.status === 'rejected' && released.steps.at(-1)?.rejectionKind === 'pre-send',
        '服务器返回的部署恢复状态与原记录不匹配。');
      this.callbacks.onUpdate?.(clone(released));
      return released;
    });
  }

  /** Recheck a completed deployment for manifest export without changing its journal or requesting signatures. */
  async inspectGraphForManifest(saved: DeploymentSnapshot): Promise<DeploymentSnapshot> {
    const snapshot = clone(saved);
    assert(snapshot.schemaVersion === 1 && snapshot.chainId === 56, '部署记录格式或网络错误。');
    assert(snapshot.artifactDigest === artifactDigest(this.bundle), '构建产物已改变，不能导出旧部署清单。');
    assert(snapshot.status === 'complete' && snapshot.steps.every(step => step.status === 'confirmed'), '仅已完成的部署可导出清单。');
    assert(JSON.stringify(snapshot.steps.map(step => step.id)) === JSON.stringify(this.stepIds(snapshot.kind)), '部署步骤与当前构建不匹配。');
    snapshot.input = normalizeInput(snapshot.input);
    if (snapshot.input.governanceMode === 'single') assert(sameAddress(snapshot.input.ownerMultisig, snapshot.account), '记录中的单钱包管理地址不匹配部署账户。');
    await walletAccount(this.wallet, snapshot.account);
    await this.verifyInitializeForManifest(snapshot);
    const recordedAddresses = clone(snapshot.addresses);
    snapshot.verification = await this.verifyGraph(snapshot);
    for (const [name, address] of Object.entries(recordedAddresses)) {
      assert(snapshot.addresses[name] && sameAddress(address, snapshot.addresses[name]), `部署记录中的 ${name} 地址与链上不一致。`);
    }
    return snapshot;
  }

  private async verifyInitializeForManifest(snapshot: DeploymentSnapshot): Promise<void> {
    const step = snapshot.steps.at(-1);
    assert(step?.id === 'initialize' && step.txHash && /^0x[0-9a-fA-F]{64}$/.test(step.txHash) && step.receipt,
      '缺少可核对的原子初始化交易与回执。');
    // Reuse the same canonical/finalized proof as recovery; this path only reads.
    const { tx, receipt } = await this.finalizedReplacement(snapshot, step, step.txHash);
    assert(tx.chainId === 56n && sameAddress(tx.from, snapshot.account) && tx.nonce === step.nonce && tx.value === 0n,
      '原子初始化交易的链、账户、nonce、目标或金额与记录不一致。');
    const expected = await this.transaction(snapshot, step);
    assert(step.dataHash === keccak256(expected.data as string),
      '原子初始化交易内容与保存的部署计划不一致。');
    const execution = verifyInitializationExecution({ record: snapshot, step, tx, receipt });
    if (execution.kind === 'wrapped') await this.verifyWrappedInitialize(snapshot);
    assert(receipt.status === 1 && sameAddress(receipt.from, tx.from) && receipt.to !== null && tx.to !== null && sameAddress(receipt.to, tx.to) &&
      receipt.gasUsed <= tx.gasLimit && receipt.fee === receipt.gasUsed * receipt.gasPrice && tx.blockHash === receipt.blockHash,
      '原子初始化链上回执与交易不一致或执行失败。');
    const recorded = step.receipt;
    assert(recorded.status === 1 && recorded.blockNumber === receipt.blockNumber && recorded.blockHash === receipt.blockHash &&
      recorded.gasUsed === receipt.gasUsed.toString() && recorded.gasPrice === receipt.gasPrice.toString() &&
      recorded.feeWei === receipt.fee.toString(), '保存的原子初始化回执与链上不一致。');
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
      if (snapshot.steps.every(item => item.status === 'confirmed')) {
        snapshot.verification = await this.verifyGraph(snapshot);
        snapshot.status = 'complete'; delete snapshot.error;
        await this.save(snapshot);
        return snapshot;
      }
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
      let samePayload = keccak256(tx.data) === expectedDataHash && tx.value === 0n &&
        ((expected.to == null && tx.to === null) ||
          (typeof expected.to === 'string' && tx.to !== null && sameAddress(tx.to, expected.to)));
      if (!samePayload && step.id === 'initialize' && receipt.status === 1) {
        try { samePayload = verifyInitializationExecution({ record: snapshot, step: { ...step, txHash: tx.hash }, tx, receipt }).kind === 'wrapped'; }
        catch { /* Unproven envelopes remain replacements; no outcome is assumed. */ }
      }
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
      assert(snapshot.status !== 'complete' && snapshot.status !== 'aborted', '部署已完成或已终止，不能提高预算继续旧计划。');
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

  private stepIds(kind?: DeploymentSnapshot['kind']): string[] {
    assert(kind === undefined || kind === 'integrated-v2', '部署版本不支持。');
    const libraries = libraryDeploymentOrder(this.bundle).filter(name => kind === 'integrated-v2' || name !== 'FirstoSale');
    return [...libraries, 'AtomicDeployment', 'PoolVault', kind === 'integrated-v2' ? 'FreshPoolFactory' : 'PoolFactory', 'ShareMarket',
      ...(kind === 'integrated-v2' ? ['BudgetPortfolioFactory', 'BudgetPortfolioVault'] : []), 'initialize'];
  }

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
    assert(canonical?.hash === receipt.blockHash && tx.blockHash === receipt.blockHash && tx.blockNumber === receipt.blockNumber &&
      Number.isSafeInteger(receipt.index) && receipt.index >= 0 && tx.index === receipt.index &&
      canonical.transactions[receipt.index]?.toLowerCase() === hash.toLowerCase(),
      '替换交易回执不在当前规范链上，原部署仍暂停。');
    assert(finalized?.hash && latest && finalized.number >= receipt.blockNumber && latest.number - receipt.blockNumber + 1 >= 2,
      '替换交易尚未达到 BSC 最终性和 2 次确认，原部署仍暂停。');
    // Canonical inclusion below a stable finalized anchor proves that this
    // exact transaction consumed its nonce without requiring archive state.
    const [currentReceipt, currentBlock, finalizedBlock] = await Promise.all([
      this.provider.getTransactionReceipt(hash), this.provider.getBlock(receipt.blockNumber), this.provider.getBlock(finalized.number),
    ]);
    assert(currentReceipt?.blockHash === receipt.blockHash && currentBlock?.hash === receipt.blockHash &&
      currentBlock?.transactions[receipt.index]?.toLowerCase() === hash.toLowerCase() &&
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
    assert(JSON.stringify(snapshot.steps.map(step => step.id)) === JSON.stringify(this.stepIds(snapshot.kind)), '部署步骤与当前构建不匹配。');
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
      const core = {
        ownerMultisig: snapshot.input.ownerMultisig, operator: snapshot.input.operator, treasury: snapshot.input.treasury,
        vaultImplementation: snapshot.addresses.PoolVault,
        factoryImplementation: snapshot.addresses[snapshot.kind === 'integrated-v2' ? 'FreshPoolFactory' : 'PoolFactory'],
        marketImplementation: snapshot.addresses.ShareMarket,
      };
      const integrated = snapshot.kind === 'integrated-v2';
      if (integrated) assert(snapshot.input.governanceMode === 'single', '集成部署的治理模式与已确认方案不同。');
      return { to: snapshot.addresses.AtomicDeployment, value: 0n, data: iface.encodeFunctionData(
        integrated ? 'deployIntegratedSingleOwner' : snapshot.input.governanceMode === 'single' ? 'deploySingleOwner' : 'deploy',
        [integrated ? { core, portfolioFactoryImplementation: snapshot.addresses.BudgetPortfolioFactory,
          portfolioVaultImplementation: snapshot.addresses.BudgetPortfolioVault } : core]) };
    }
    const artifact = this.bundle.artifacts[step.id];
    const code = linkBytecode(artifact.bytecode, artifact.linkReferences, snapshot.addresses);
    const args: unknown[] = [];
    if (step.id === 'PoolVault' || step.id === 'BudgetPortfolioVault') {
      const coordinator = new Contract(snapshot.addresses.AtomicDeployment, this.bundle.artifacts.AtomicDeployment.abi, this.provider);
      args.push(await coordinator[step.id === 'PoolVault' ? 'predictedFactory' : 'predictedPortfolioFactory']());
    }
    return new ContractFactory(artifact.abi, code).getDeployTransaction(...args);
  }

  private async run(snapshot: DeploymentSnapshot): Promise<DeploymentSnapshot> {
    this.assertFreshSigningRoles(snapshot);
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

  private assertFreshSigningRoles(snapshot: DeploymentSnapshot): void {
    // Old deployment records may still be inspected or recovered read-only.
    // The integrated v4 plan may request another signature only with the
    // reviewed hardware wallet controlling all three initial roles.
    if (snapshot.kind !== 'integrated-v2') return;
    assert(snapshot.input.governanceMode === 'single'
      && sameAddress(snapshot.input.ownerMultisig, snapshot.account)
      && sameAddress(snapshot.input.operator, snapshot.account)
      && sameAddress(snapshot.input.treasury, snapshot.account),
    '恢复的新部署角色与硬件钱包不一致；停止后续签名。');
  }

  private async sendStep(snapshot: DeploymentSnapshot, step: StepRecord): Promise<void> {
    verifyArtifactIntegrity(this.bundle);
    const transaction = await this.transaction(snapshot, step);
    transaction.from = snapshot.account; transaction.value = 0n; transaction.chainId = 56;
    const reviewedLimit = snapshot.kind === 'integrated-v2' ? freshGasLimit(snapshot, step) : null;
    // The fresh plan uses the fixed, artifact-pinned Gas limit. Do not make a
    // redundant eth_estimateGas or eth_call before opening the wallet.
    // Legacy plans still need an estimate because they have no reviewed limit.
    const estimation = reviewedLimit === null ? this.provider.estimateGas(transaction) : Promise.resolve(null);
    const [estimated, fee, balance, walletNonce, walletPendingNonce, block, independentNonce] = await Promise.all([
      estimation,
      this.provider.getFeeData(), this.provider.getBalance(snapshot.account),
      this.provider.getTransactionCount(snapshot.account, 'latest'), this.provider.getTransactionCount(snapshot.account, 'pending'),
      this.provider.getBlock('latest'),
      this.callbacks.readCurrentNonce?.() ?? Promise.resolve(null),
    ]);
    const currentNonce = independentNonce ?? { latest: walletNonce, pending: walletPendingNonce };
    assert(Number.isSafeInteger(currentNonce.latest) && currentNonce.latest >= 0 &&
      Number.isSafeInteger(currentNonce.pending) && currentNonce.pending >= 0, '无法核对部署账户的最新 nonce；部署已暂停。');
    assert(currentNonce.latest === currentNonce.pending, '账户出现其他待确认交易；部署已暂停。');
    const nonce = currentNonce.latest;
    for (const confirmed of snapshot.steps.filter(item => item.status === 'confirmed')) {
      assert(Number.isSafeInteger(confirmed.nonce) && nonce > confirmed.nonce!, '节点返回的 nonce 落后于已确认部署记录；部署已暂停。');
    }
    assert(walletNonce <= nonce && walletPendingNonce <= nonce,
      '钱包已观察到更新的交易 nonce；独立节点尚未同步，部署已暂停。');
    assert(fee.gasPrice !== null && fee.gasPrice > 0n, '无法读取 Gas 单价。');
    const cap = parseUnits(snapshot.input.gasPriceCapGwei, 'gwei');
    assert(fee.gasPrice <= cap, '当前 Gas 单价超过设定上限。');
    const gasLimit = reviewedLimit ?? (estimated! * 120n + 99n) / 100n;
    assert(block && gasLimit <= block.gasLimit, '该笔部署超过区块 Gas 上限。');
    const maxFee = gasLimit * fee.gasPrice;
    assert(BigInt(snapshot.spentWei) + maxFee <= parseEther(snapshot.input.maxGasBudgetBnb), '下一笔交易可能超过总 Gas 预算，已停止。');
    assert(balance >= maxFee, '余额不足以支付下一笔交易 Gas。');
    if (step.status === 'rejected') {
      assert(step.nonce === nonce && step.dataHash === keccak256(transaction.data as string),
        '上次拒签后 nonce 或部署交易内容已变化；不能按原写前记录重新签名，请先核对链上交易。');
    }
    transaction.gasLimit = gasLimit; transaction.nonce = nonce;
    // The wallet may wrap any creation or initialization call in an EIP-7702
    // (type 4) envelope. Dynamic fee fields work for both types; a legacy
    // gasPrice field makes the wrapped request invalid before it is broadcast.
    transaction.type = 2;
    transaction.maxFeePerGas = fee.gasPrice;
    transaction.maxPriorityFeePerGas = fee.gasPrice;
    if (reviewedLimit !== null) delete step.gasEstimate;
    Object.assign(step, { status: 'signing', nonce, ...(estimated === null ? {} : { gasEstimate: estimated.toString() }), gasLimit: gasLimit.toString(), gasPriceWei: fee.gasPrice.toString(), maxFeeWei: maxFee.toString(), dataHash: keccak256(transaction.data as string) });
    delete step.rejectionKind;
    delete step.error;
    // Write-ahead intent makes a reload between wallet acceptance and hash delivery fail closed.
    await this.save(snapshot);
    let attemptedBroadcast = false;
    let artifactCheckFailed = false;
    let nonceCheckFailed = false;
    try {
      await walletAccount(this.wallet, snapshot.account);
      verifyArtifactIntegrity(this.bundle);
      if (this.callbacks.assertCurrentArtifact) {
        try { await this.callbacks.assertCurrentArtifact(snapshot.artifactDigest); }
        catch (error) { artifactCheckFailed = true; throw error; }
      }
      if (this.callbacks.readCurrentNonce) {
        try {
          const current = await this.callbacks.readCurrentNonce();
          assert(current.latest === nonce && current.pending === nonce,
            '签名前账户 nonce 已变化；保留原部署意图，请先核对链上交易。');
          await walletAccount(this.wallet, snapshot.account);
        } catch (error) { nonceCheckFailed = true; throw error; }
      }
      attemptedBroadcast = true;
      // The full transaction is already prepared and the wallet identity was just checked.
      // Avoid getSigner()'s extra wallet account lookup before showing the same RPC request.
      const hash = await this.wallet.request({ method: 'eth_sendTransaction', params: [this.provider.getRpcTransaction(transaction)] }) as string;
      assert(/^0x[0-9a-fA-F]{64}$/.test(hash), '钱包未返回有效交易哈希；请先核对链上结果。');
      step.txHash = hash; step.status = 'submitted';
      await this.save(snapshot);
    } catch (error) {
      if (!step.txHash) {
        const failure = error as { code?: string | number; info?: { error?: { code?: number } } };
        // The wallet was never called for a pre-send artifact or identity
        // failure. A changed nonce remains unresolved because another page
        // could have consumed the planned CREATE address. An explicit 4001
        // rejection is also definite; all other send failures stay uncertain.
        const walletRejected = attemptedBroadcast && (failure.code === 'ACTION_REJECTED'
          || failure.code === 4001 || failure.info?.error?.code === 4001);
        step.status = nonceCheckFailed ? 'signing'
          : !attemptedBroadcast || walletRejected ? 'rejected' : 'uncertain';
        if (step.status === 'rejected') step.rejectionKind = walletRejected ? 'wallet-rejected' : 'pre-send';
      }
      step.error = artifactCheckFailed
        ? `发送前服务器产物核对失败；本页尚未请求钱包签名。请先核对是否有其他页面或钱包使用了同一 nonce：${errorMessage(error)}`
        : nonceCheckFailed
        ? `发送前 nonce 核对失败；本页尚未请求钱包签名。已保留原意图，禁止自动重发：${errorMessage(error)}`
        : errorMessage(error);
      await this.save(snapshot);
      if (artifactCheckFailed || nonceCheckFailed) throw new Error(step.error);
      throw error;
    }
    const receipt = await this.provider.waitForTransaction(step.txHash!, 2, 120_000);
    assert(receipt, '交易仍在确认中；请稍后只读核对回执，不要重复部署。');
    // Receipt verification checks the mined chain and sender; the next step
    // checks the live wallet again before requesting another signature.
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
    const initializationExecution = step.id === 'initialize'
      ? verifyInitializationExecution({ record: snapshot, step, tx, receipt }) : null;
    if (!initializationExecution) {
      assert(tx.value === 0n && keccak256(tx.data) === keccak256(expected.data as string), '钱包实际发送的交易内容与编译部署计划不一致。');
      assert((expected.to == null && tx.to === null) || (typeof expected.to === 'string' && tx.to !== null && sameAddress(tx.to, expected.to)), '交易目标地址与计划不一致。');
    }
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
      if (step.id === 'PoolVault' || step.id === 'BudgetPortfolioVault') {
        const coordinator = new Contract(snapshot.addresses.AtomicDeployment, this.bundle.artifacts.AtomicDeployment.abi, this.provider);
        assert(sameAddress(await contract.OFFICIAL_FACTORY(), await coordinator[step.id === 'PoolVault' ? 'predictedFactory' : 'predictedPortfolioFactory']()), 'Vault immutable 工厂绑定不匹配。');
      }
      if (['PoolFactory', 'FreshPoolFactory', 'ShareMarket', 'BudgetPortfolioFactory'].includes(step.id)) assert((await contract.proxiableUUID()).toLowerCase() === IMPLEMENTATION_SLOT, '实现不是预期 UUPS 存储槽。');
    }
    if (initializationExecution?.kind === 'wrapped') {
      await this.finalizedReplacement(snapshot, step, receipt.hash);
      await this.verifyWrappedInitialize(snapshot);
      // Attest the initialization outcome, retaining the actual outer transaction.
      // This never authorizes a wallet to sign arbitrary envelope calls.
      step.initializationExecution = initializationExecution;
    }
    step.status = 'confirmed'; delete step.error;
  }

  private async verifyWrappedInitialize(snapshot: DeploymentSnapshot): Promise<void> {
    const coordinatorAddress = snapshot.addresses.AtomicDeployment;
    const coordinatorStep = snapshot.steps.find(item => item.id === 'AtomicDeployment');
    const code = await this.provider.getCode(coordinatorAddress);
    assert(coordinatorStep?.status === 'confirmed' && coordinatorStep.codehash === keccak256(code) &&
      runtimeMatches(this.bundle.artifacts.AtomicDeployment, code, snapshot.addresses, coordinatorAddress),
      '中转初始化的协调器代码与本次已核验构建不一致。');
    const coordinator = new Contract(coordinatorAddress, this.bundle.artifacts.AtomicDeployment.abi, this.provider);
    assert(sameAddress(await coordinator.deployer(), snapshot.account), '中转初始化的协调器固定部署者不匹配。');
    await this.verifyGraph(snapshot);
  }

  private async verifyGraph(snapshot: DeploymentSnapshot, requireInitialEmpty = false): Promise<DeploymentVerification> {
    await walletAccount(this.wallet, snapshot.account);
    const block = await this.provider.getBlock('latest');
    assert(block?.hash, '无法取得 BSC 最新区块，部署图校验已停止。');
    const blockTag = block.number;
    const atBlock = { blockTag };
    const coordinator = new Contract(snapshot.addresses.AtomicDeployment, this.bundle.artifacts.AtomicDeployment.abi, this.provider);
    const result = await coordinator.deployment(atBlock);
    const addresses = { timelock: getAddress(result.timelock), beacon: getAddress(result.beacon), factory: getAddress(result.factory), shareMarket: getAddress(result.shareMarket) };
    Object.assign(snapshot.addresses, addresses);
    if (snapshot.kind === 'integrated-v2') {
      const portfolio = await coordinator.portfolioDeployment(atBlock);
      Object.assign(snapshot.addresses, {
        portfolioFactory: getAddress(portfolio.factory), portfolioBeacon: getAddress(portfolio.beacon),
        portfolioShareMarket: getAddress(portfolio.shareMarket),
        portfolioFactoryImplementation: snapshot.addresses.BudgetPortfolioFactory,
        portfolioVaultImplementation: snapshot.addresses.BudgetPortfolioVault,
      });
    }
    const factory = new Contract(addresses.factory, this.bundle.artifacts[snapshot.kind === 'integrated-v2' ? 'FreshPoolFactory' : 'PoolFactory'].abi, this.provider);
    const lensAddress = getAddress(await factory.lens(atBlock));
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
    const factoryExpected = { owner: snapshot.input.ownerMultisig, operator: snapshot.input.operator, treasury: snapshot.input.treasury,
      timelock: addresses.timelock, beacon: addresses.beacon, shareMarket: addresses.shareMarket };
    const roles = (async () => {
      const [proposer, canceller, executor, admin] = await Promise.all([
        timelock.PROPOSER_ROLE(atBlock), timelock.CANCELLER_ROLE(atBlock), timelock.EXECUTOR_ROLE(atBlock), timelock.DEFAULT_ADMIN_ROLE(atBlock),
      ]);
      return Promise.all([
        timelock.hasRole(proposer, snapshot.input.ownerMultisig, atBlock), timelock.hasRole(canceller, snapshot.input.ownerMultisig, atBlock),
        timelock.hasRole(executor, ZeroAddress, atBlock), timelock.hasRole(admin, addresses.timelock, atBlock),
        timelock.hasRole(admin, snapshot.account, atBlock), timelock.hasRole(admin, snapshot.addresses.AtomicDeployment, atBlock),
      ]);
    })();
    // These reads are independent. Run them together and reuse each runtime bytecode
    // for both its codehash and the compiled-runtime comparison.
    const codeReads = new Map<string, Promise<string>>();
    const readCode = (address: string) => {
      const key = address.toLowerCase();
      if (!codeReads.has(key)) codeReads.set(key, this.provider.getCode(address, blockTag));
      return codeReads.get(key)!;
    };
    const [deployed, predictedFactory, factoryLens, lensFactory, factoryBindings, beaconBindings, marketBindings,
      delays, roleChecks, slots, poolCount, observedCodes] = await Promise.all([
      coordinator.deployed(atBlock), coordinator.predictedFactory(atBlock), factory.lens(atBlock), lens.factory(atBlock),
      Promise.all(Object.keys(factoryExpected).map(getter => factory[getter](atBlock))),
      Promise.all([beacon.owner(atBlock), beacon.implementation(atBlock), beacon.OFFICIAL_FACTORY(atBlock)]),
      Promise.all([market.factory(atBlock), market.timelock(atBlock), market.feeBps(atBlock), market.buyerFeeBps(atBlock), market.ORDER_DURATION(atBlock)]),
      Promise.all([timelock.getMinDelay(atBlock), timelock.MINIMUM_DELAY(atBlock)]), roles,
      Promise.all([this.provider.getStorage(addresses.factory, IMPLEMENTATION_SLOT, blockTag), this.provider.getStorage(addresses.shareMarket, IMPLEMENTATION_SLOT, blockTag)]),
      factory.poolCount(atBlock),
      Promise.all(Object.entries(snapshot.addresses).map(async ([name, address]) => [name, address, await readCode(address)] as const)),
    ]);
    check('协调器初始化完成', deployed, true);
    check('Factory CREATE 绑定', addresses.factory, predictedFactory);
    check('Factory.lens', factoryLens, lensAddress);
    check('Lens.factory', lensFactory, addresses.factory);
    Object.entries(factoryExpected).forEach(([getter, expected], index) => check(`Factory.${getter}`, factoryBindings[index], expected));
    check('Beacon.owner', beaconBindings[0], addresses.timelock);
    check('Beacon.implementation', beaconBindings[1], snapshot.addresses.PoolVault);
    check('Beacon.OFFICIAL_FACTORY', beaconBindings[2], addresses.factory);
    check('Market.factory', marketBindings[0], addresses.factory);
    check('Market.timelock', marketBindings[1], addresses.timelock);
    check('Market.feeBps', marketBindings[2], 100);
    check('Market.buyerFeeBps', marketBindings[3], 100);
    check('Market.ORDER_DURATION', marketBindings[4], 7 * 86400);
    check('升级最小延迟', delays[0], UPGRADE_DELAY_SECONDS);
    check('延迟硬下限', delays[1], UPGRADE_DELAY_SECONDS);
    const roleLabels = ['管理地址提案权', '管理地址取消权', '到期公开执行', 'Timelock 自管理', '部署者没有 Timelock admin', '协调器没有 Timelock admin'];
    roleChecks.forEach((actual, index) => check(roleLabels[index], actual, index < 4));
    const slotAddress = (slot: string) => getAddress(`0x${slot.slice(-40)}`);
    check('Factory UUPS 实现槽', slotAddress(slots[0]), snapshot.addresses[snapshot.kind === 'integrated-v2' ? 'FreshPoolFactory' : 'PoolFactory']);
    check('Market UUPS 实现槽', slotAddress(slots[1]), snapshot.addresses.ShareMarket);
    if (requireInitialEmpty) check('初始池子数量', poolCount, 0);
    else checks.push({ label: '当前池子数量', passed: true, actual: poolCount.toString(), expected: '部署完成后允许创建资金池' });
    if (snapshot.kind === 'integrated-v2') {
      const pf = new Contract(snapshot.addresses.portfolioFactory, this.bundle.artifacts.BudgetPortfolioFactory.abi, this.provider);
      const pb = new Contract(snapshot.addresses.portfolioBeacon, this.bundle.artifacts.PoolBeacon.abi, this.provider);
      const pm = new Contract(snapshot.addresses.portfolioShareMarket, this.bundle.artifacts.ShareMarket.abi, this.provider);
      const pv = new Contract(snapshot.addresses.BudgetPortfolioVault, this.bundle.artifacts.BudgetPortfolioVault.abi, this.provider);
      const expected = { owner: snapshot.input.ownerMultisig, operator: snapshot.input.operator, treasury: snapshot.input.treasury,
        timelock: addresses.timelock, beacon: snapshot.addresses.portfolioBeacon, legacyFactory: addresses.factory,
        shareMarket: snapshot.addresses.portfolioShareMarket };
      const [bindings, predicted, beaconValues, marketValues, vaultFactory, portfolioSlots, count] = await Promise.all([
        Promise.all(Object.keys(expected).map(getter => pf[getter](atBlock))), coordinator.predictedPortfolioFactory(atBlock),
        Promise.all([pb.owner(atBlock), pb.implementation(atBlock), pb.OFFICIAL_FACTORY(atBlock)]),
        Promise.all([pm.factory(atBlock), pm.timelock(atBlock), pm.feeBps(atBlock), pm.buyerFeeBps(atBlock), pm.ORDER_DURATION(atBlock)]),
        pv.OFFICIAL_FACTORY(atBlock),
        Promise.all([this.provider.getStorage(snapshot.addresses.portfolioFactory, IMPLEMENTATION_SLOT, blockTag),
          this.provider.getStorage(snapshot.addresses.portfolioShareMarket, IMPLEMENTATION_SLOT, blockTag)]), pf.portfolioCount(atBlock),
      ]);
      Object.entries(expected).forEach(([key, value], index) => check(`PortfolioFactory.${key}`, bindings[index], value));
      check('PortfolioFactory CREATE 绑定', snapshot.addresses.portfolioFactory, predicted);
      check('PortfolioBeacon.owner', beaconValues[0], addresses.timelock);
      check('PortfolioBeacon.implementation', beaconValues[1], snapshot.addresses.BudgetPortfolioVault);
      check('PortfolioBeacon.OFFICIAL_FACTORY', beaconValues[2], snapshot.addresses.portfolioFactory);
      check('PortfolioVault.OFFICIAL_FACTORY', vaultFactory, snapshot.addresses.portfolioFactory);
      check('PortfolioMarket.factory', marketValues[0], snapshot.addresses.portfolioFactory);
      check('PortfolioMarket.timelock', marketValues[1], addresses.timelock);
      check('PortfolioMarket.feeBps', marketValues[2], 100);
      check('PortfolioMarket.buyerFeeBps', marketValues[3], 100);
      check('PortfolioMarket.ORDER_DURATION', marketValues[4], 7 * 86400);
      check('PortfolioFactory UUPS 实现槽', slotAddress(portfolioSlots[0]), snapshot.addresses.BudgetPortfolioFactory);
      check('PortfolioMarket UUPS 实现槽', slotAddress(portfolioSlots[1]), snapshot.addresses.ShareMarket);
      if (requireInitialEmpty) check('初始多机项目数量', count, 0);
      else checks.push({ label: '当前多机项目数量', passed: true, actual: count.toString(), expected: '部署完成后允许创建多机项目' });
    }
    const code: Record<string, CodeRecord> = {};
    for (const [name, address, runtime] of observedCodes) {
      assert(runtime !== '0x', `${address} 没有合约代码。`);
      code[name] = { address: getAddress(address), codehash: keccak256(runtime), codeBytes: (runtime.length - 2) / 2 };
      const artifactName = ({ factory: 'ERC1967Proxy', shareMarket: 'ERC1967Proxy', timelock: 'PoolTimelock', beacon: 'PoolBeacon', lens: 'PoolLens',
        portfolioFactory: 'ERC1967Proxy', portfolioShareMarket: 'ERC1967Proxy', portfolioBeacon: 'PoolBeacon',
        portfolioFactoryImplementation: 'BudgetPortfolioFactory', portfolioVaultImplementation: 'BudgetPortfolioVault' } as Record<string, string>)[name] ?? name;
      check(`${name} 运行代码匹配`, runtimeMatches(this.bundle.artifacts[artifactName], runtime, snapshot.addresses, address), true);
    }
    const [currentBlock] = await Promise.all([this.provider.getBlock(blockTag), walletAccount(this.wallet, snapshot.account)]);
    assert(currentBlock?.hash === block.hash, '部署图校验期间区块发生重组，请重新核对。');
    const verification = { checkedAt: new Date().toISOString(), blockNumber: blockTag, checks, code };
    snapshot.verification = verification;
    assert(checks.every(item => item.passed), `部署后校验失败：${checks.filter(item => !item.passed).map(item => item.label).join('、')}`);
    return verification;
  }
}
