import {
  BrowserProvider, Contract, ContractFactory, Interface, ZeroAddress, getAddress, getCreateAddress,
  keccak256, parseEther, parseUnits, type Eip1193Provider, type TransactionReceipt,
} from 'ethers';
import {
  artifactDigest, DeploymentEngine, IMPLEMENTATION_SLOT, runtimeMatches, validateArtifacts,
  type ArtifactBundle, type DeploymentSnapshot, type StepRecord,
} from './deployment';
import { deploymentManifest, type DeploymentManifest } from './manifest';
import type { ServerJournal } from './server-journal';

export const FRESH_ADMIN_ONE = getAddress('0x7674fa446D42b1f7f150DC5e678cc525d275Ea53');
export const FRESH_ADMIN_TWO = getAddress('0xed2fcbe59ebe1754a3676aeb9ccfba20f193fcbb');
// Public address chosen for the fresh Authority. The v4 sender remains disabled
// until the active v2 sender has drained or both share one nonce coordinator.
export const FRESH_GAS_WALLET = getAddress('0xA285d1933e32b5990625aC1F5BEa205Cf2606619');
export function validatedFreshGasWallet(raw: string, hardwareWallet: string): string {
  if (!/^0x[\da-fA-F]{40}$/.test(raw.trim())) throw new Error('请填写 Gas 钱包完整的 42 字符公开地址；不要输入私钥。');
  const address = getAddress(raw.trim());
  requireThat(address !== ZeroAddress && !same(address, hardwareWallet)
    && !same(address, FRESH_ADMIN_ONE) && !same(address, FRESH_ADMIN_TWO),
    'Gas 钱包须与硬件钱包和两位管理员不同。');
  return address;
}
export const FRESH_ACTIVATION_STEPS = [
  'deployAuthority', 'coreOperator', 'coreTreasury', 'budgetOperator',
  'budgetTreasury', 'coreOwner', 'budgetOwner',
] as const;
export type FreshActivationStepId = typeof FRESH_ACTIVATION_STEPS[number];
const LABELS = ['部署平台权限合约', '单机 Factory 设置运营地址', '单机 Factory 设置手续费地址',
  '多机 Factory 设置运营地址', '多机 Factory 设置手续费地址',
  '单机 Factory 所有权移交 48 小时时间锁', '多机 Factory 所有权移交 48 小时时间锁'];
const FACTORY_ABI = new Interface([
  'function setOperator(address)', 'function setTreasury(address)', 'function transferOwnership(address)',
  'function owner() view returns(address)', 'function operator() view returns(address)',
  'function treasury() view returns(address)', 'function timelock() view returns(address)',
  'function shareMarket() view returns(address)', 'function poolCount() view returns(uint256)',
  'function portfolioCount() view returns(uint256)', 'function creationPaused() view returns(bool)',
]);
const AUTHORITY_ABI = [
  'function owner() view returns(address)', 'function coreFactory() view returns(address)',
  'function budgetFactory() view returns(address)', 'function administratorOne() view returns(address)',
  'function administratorTwo() view returns(address)', 'function gasWallet() view returns(address)',
];
const TIMELOCK_ABI = [
  'function getMinDelay() view returns(uint256)', 'function PROPOSER_ROLE() view returns(bytes32)',
  'function CANCELLER_ROLE() view returns(bytes32)', 'function hasRole(bytes32,address) view returns(bool)',
];
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const requireThat: (ok: unknown, message: string) => asserts ok = (ok, message) => { if (!ok) throw new Error(message); };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function invalidEnvelopeError(error: unknown): boolean {
  const failure = error as { message?: unknown; shortMessage?: unknown;
    info?: { error?: { message?: unknown } }; data?: { message?: unknown } } | null;
  return [failure?.message, failure?.shortMessage, failure?.info?.error?.message, failure?.data?.message]
    .some(value => typeof value === 'string'
      && /invalid transaction envelope type/i.test(value)
      && /\btype\s*["']?0x4["']?/i.test(value)
      && /\bgasPrice\b/.test(value) && /\bmaxFeePerGas\b/.test(value)
      && /\bmaxPriorityFeePerGas\b/.test(value) && /instead of/i.test(value));
}

type FreshActivationStepRecord = Omit<StepRecord, 'rejectionKind'> & {
  rejectionKind?: StepRecord['rejectionKind'] | 'nonce-witnessed';
};

export interface FreshActivationRecord {
  schemaVersion: 1;
  kind: 'fresh-authority';
  chainId: 56;
  account: string;
  deploymentId: string;
  genesisArtifactDigest: string;
  genesis: { factory: string; portfolioFactory: string; timelock: string;
    shareMarket: string; portfolioMarket: string; codehash: Record<string, string> };
  administratorOne: string;
  administratorTwo: string;
  gasWallet: string;
  authorityAddress?: string;
  createdAt: string;
  updatedAt: string;
  maxGasBudgetBnb: string;
  gasPriceCapGwei: string;
  spentWei: string;
  status: 'ready' | 'paused' | 'complete' | 'aborted';
  steps: FreshActivationStepRecord[];
  error?: string;
}

export interface FreshActivationEvidence {
  schemaVersion: 1;
  kind: 'fresh-authority';
  chainId: 56;
  deploymentId: string;
  genesisArtifactDigest: string;
  authority: { address: string; deploymentTxHash: string; administratorOne: string;
    administratorTwo: string; gasWallet: string };
  steps: { id: FreshActivationStepId; txHash: string; blockNumber: number; blockHash: string }[];
  verifiedAt: string;
}

/** Exact send plan; no amount of BNB is transferred by these seven calls. */
export async function activationTransaction(record: FreshActivationRecord, bundle: ArtifactBundle,
  id: FreshActivationStepId): Promise<{ to?: string; data: string; value: bigint; gasLimit: bigint }> {
  const { factory, portfolioFactory, timelock } = record.genesis;
  if (id === 'deployAuthority') {
    const artifact = bundle.artifacts.PlatformAuthority;
    requireThat(artifact && Object.keys(artifact.linkReferences).length === 0,
      '平台权限合约存在未解析库地址，不能部署。');
    const transaction = await new ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(
      factory, portfolioFactory, record.administratorOne, record.administratorTwo, record.gasWallet);
    requireThat(typeof transaction.data === 'string' && transaction.data.startsWith('0x'), '权限合约部署数据不存在。');
    return { data: transaction.data, value: 0n, gasLimit: 6_000_000n };
  }
  requireThat(record.authorityAddress && getAddress(record.authorityAddress) !== ZeroAddress,
    '权限合约地址尚未通过已确认交易核验。');
  const authority = record.authorityAddress;
  const actions: Record<Exclude<FreshActivationStepId, 'deployAuthority'>, [string, string, string]> = {
    coreOperator: [factory, 'setOperator', authority], coreTreasury: [factory, 'setTreasury', authority],
    budgetOperator: [portfolioFactory, 'setOperator', authority],
    budgetTreasury: [portfolioFactory, 'setTreasury', authority],
    coreOwner: [factory, 'transferOwnership', timelock],
    budgetOwner: [portfolioFactory, 'transferOwnership', timelock],
  };
  const [to, method, destination] = actions[id];
  return { to, data: FACTORY_ABI.encodeFunctionData(method, [destination]), value: 0n, gasLimit: 150_000n };
}

export function activationEvidence(record: FreshActivationRecord): FreshActivationEvidence {
  requireThat(record.status === 'complete' && record.authorityAddress && ADDRESS.test(record.authorityAddress),
    '只有完成全部七笔交易并核验最终权限后，才可导出激活证据。');
  requireThat(record.steps.length === FRESH_ACTIVATION_STEPS.length, '激活交易数量错误。');
  const steps = record.steps.map((step, index) => {
    requireThat(step.id === FRESH_ACTIVATION_STEPS[index] && step.status === 'confirmed'
      && step.txHash && HASH.test(step.txHash) && step.receipt?.status === 1
      && Number.isSafeInteger(step.receipt.blockNumber) && HASH.test(step.receipt.blockHash),
    `第 ${index + 1} 笔尚未通过链上核验。`);
    return { id: step.id as FreshActivationStepId, txHash: step.txHash,
      blockNumber: step.receipt.blockNumber, blockHash: step.receipt.blockHash };
  });
  return { schemaVersion: 1, kind: 'fresh-authority', chainId: 56,
    deploymentId: record.deploymentId, genesisArtifactDigest: record.genesisArtifactDigest,
    authority: { address: record.authorityAddress, deploymentTxHash: steps[0].txHash,
      administratorOne: record.administratorOne, administratorTwo: record.administratorTwo,
      gasWallet: record.gasWallet }, steps, verifiedAt: new Date().toISOString() };
}

export interface ActivatedDeploymentManifest extends DeploymentManifest {
  authority: string;
  gasWallet: string;
  freshAuthority: {
    address: string;
    codehash: string;
    deploymentTxHash: string;
    administratorOne: string;
    administratorTwo: string;
    gasWallet: string;
  };
}

/** Public build-pinned manifest augmentation; no private key or authority to transact. */
export function activatedDeploymentManifest(base: DeploymentManifest,
  evidence: FreshActivationEvidence, authorityCodehash: string): ActivatedDeploymentManifest {
  requireThat(base.kind === 'integrated-v2' && base.artifactDigest === evidence.genesisArtifactDigest
    && base.chainId === evidence.chainId && ADDRESS.test(evidence.authority.address)
    && HASH.test(authorityCodehash) && evidence.steps.length === FRESH_ACTIVATION_STEPS.length
    && evidence.steps.every((step, index) => step.id === FRESH_ACTIVATION_STEPS[index]
      && HASH.test(step.txHash) && HASH.test(step.blockHash)
      && Number.isSafeInteger(step.blockNumber) && step.blockNumber >= base.deployment.blockNumber),
  '新合约激活证据与已核验的原始部署清单不一致。');
  return { ...base, authority: getAddress(evidence.authority.address),
    gasWallet: getAddress(evidence.authority.gasWallet),
    freshAuthority: {
      address: getAddress(evidence.authority.address), codehash: authorityCodehash,
      deploymentTxHash: evidence.authority.deploymentTxHash,
      administratorOne: getAddress(evidence.authority.administratorOne),
      administratorTwo: getAddress(evidence.authority.administratorTwo),
      gasWallet: getAddress(evidence.authority.gasWallet),
    },
    verifiedAt: evidence.verifiedAt,
    verifiedBlockNumber: evidence.steps.at(-1)!.blockNumber,
  };
}

export class FreshActivationEngine {
  private readonly provider: BrowserProvider;
  private busy = false;
  constructor(private readonly wallet: Eip1193Provider, private readonly bundle: ArtifactBundle,
    private readonly journal: ServerJournal, private readonly genesis: DeploymentSnapshot,
    private readonly onUpdate?: (record: FreshActivationRecord) => void) {
    validateArtifacts(bundle);
    this.provider = new BrowserProvider(wallet, 'any', { cacheTimeout: -1, pollingInterval: 1500 });
  }

  private async account() {
    const accounts = await this.wallet.request({ method: 'eth_accounts' }) as string[];
    requireThat(Array.isArray(accounts) && accounts.length > 0 && same(getAddress(accounts[0]), this.genesis.account),
      '当前硬件钱包与原始部署者不一致。');
    requireThat((await this.provider.getNetwork()).chainId === 56n, '仅可在 BSC 主网激活。');
    return getAddress(accounts[0]);
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    requireThat(!this.busy, '激活操作已经进行中。');
    this.busy = true;
    try {
      requireThat(typeof navigator === 'undefined' || !!navigator.locks,
        '浏览器不支持跨页面部署锁；请使用支持 Web Locks 的 HTTPS 浏览器。');
      if (typeof navigator !== 'undefined') return await navigator.locks.request('pinkuang-deployment-chain56',
        { ifAvailable: true }, async lock => { requireThat(lock, '另一个部署页面正在使用此钱包。'); return action(); });
      return await action();
    } finally { this.busy = false; }
  }

  private async save(record: FreshActivationRecord) {
    record.updatedAt = new Date().toISOString();
    const copy = clone(record);
    try { await this.journal.saveFreshActivation(copy); }
    catch (error) {
      this.onUpdate?.(copy);
      throw new Error(`服务器未能持久保存激活记录；已停止后续签名。请保留交易哈希：${String(error)}`);
    }
    this.onUpdate?.(copy);
  }

  private async latest(saved?: FreshActivationRecord) {
    const record = await this.journal.loadFreshActivation();
    requireThat(record && (!saved || record.deploymentId === saved.deploymentId),
      '激活记录已变化，先刷新服务器记录。');
    requireThat(record.account.toLowerCase() === this.genesis.account.toLowerCase()
      && record.deploymentId === this.genesis.id
      && record.genesisArtifactDigest === artifactDigest(this.bundle),
      '激活记录与原始部署及当前构建不一致。');
    return clone(record);
  }

  private async verifyPinnedState(record: FreshActivationRecord, completed: number) {
    await this.account();
    const block = await this.provider.getBlock('latest');
    requireThat(block?.hash, 'BSC 区块不可用。');
    const at = { blockTag: block.number };
    const names = ['factory','portfolioFactory','shareMarket','portfolioMarket','timelock'];
    await Promise.all(names.map(async name => {
      const address = name === 'portfolioMarket' ? record.genesis.portfolioMarket
        : record.genesis[name as keyof FreshActivationRecord['genesis']] as string;
      const code = await this.provider.getCode(address, block.number);
      requireThat(code !== '0x' && keccak256(code) === record.genesis.codehash[name],
        `${name} 运行代码已变更，停止激活。`);
    }));
    const implementationBindings = [
      [record.genesis.factory, this.genesis.addresses.FreshPoolFactory, 'FreshPoolFactory'],
      [record.genesis.portfolioFactory, this.genesis.addresses.BudgetPortfolioFactory, 'BudgetPortfolioFactory'],
    ] as const;
    await Promise.all(implementationBindings.map(async ([proxy, implementation, label]) => {
      requireThat(implementation && ADDRESS.test(implementation)
        && this.genesis.verification?.code[label]?.address
        && same(this.genesis.verification.code[label].address, implementation),
      `${label} 原始实现地址未核验。`);
      const slot = await this.provider.getStorage(proxy, IMPLEMENTATION_SLOT, block.number);
      requireThat(same(getAddress(`0x${slot.slice(-40)}`), implementation),
        `${label} 的 UUPS 实现槽已变更。`);
      const code = await this.provider.getCode(implementation, block.number);
      requireThat(code !== '0x' && keccak256(code) === this.genesis.verification!.code[label].codehash,
        `${label} 的实现代码已变更。`);
    }));
    const core = new Contract(record.genesis.factory, FACTORY_ABI, this.provider);
    const budget = new Contract(record.genesis.portfolioFactory, FACTORY_ABI, this.provider);
    const time = new Contract(record.genesis.timelock, TIMELOCK_ABI, this.provider);
    const [coreValues, budgetValues, delay, proposer, canceller] = await Promise.all([
      Promise.all([core.owner(at), core.operator(at), core.treasury(at), core.timelock(at), core.shareMarket(at), core.poolCount(at), core.creationPaused(at)]),
      Promise.all([budget.owner(at), budget.operator(at), budget.treasury(at), budget.timelock(at), budget.shareMarket(at), budget.portfolioCount(at), budget.creationPaused(at)]),
      time.getMinDelay(at), time.PROPOSER_ROLE(at), time.CANCELLER_ROLE(at),
    ]);
    const authority = record.authorityAddress;
    const expectations = [
      [record.genesis.factory, coreValues, completed >= 6 ? record.genesis.timelock : record.account,
        completed >= 2 ? authority : record.account, completed >= 3 ? authority : record.account,
        record.genesis.shareMarket],
      [record.genesis.portfolioFactory, budgetValues, completed >= 7 ? record.genesis.timelock : record.account,
        completed >= 4 ? authority : record.account, completed >= 5 ? authority : record.account,
        record.genesis.portfolioMarket],
    ] as const;
    for (const [label, actual, owner, operator, treasury, market] of expectations) {
      requireThat(owner && operator && treasury && same(actual[0], owner) && same(actual[1], operator)
        && same(actual[2], treasury) && same(actual[3], record.genesis.timelock)
        && same(actual[4], market) && actual[6] === false,
        `${label} 权限或市场绑定与已确认步骤不一致。`);
      if (completed < 7) requireThat(actual[5] === 0n, '激活尚未结束，新 Factory 已产生池子；停止继续签名。');
    }
    requireThat(delay >= 48n * 60n * 60n
      && await time.hasRole(proposer, record.account, at)
      && await time.hasRole(canceller, record.account, at),
      '硬件钱包没有 48 小时时间锁提案/取消权限。');
    if (completed >= 1) {
      requireThat(authority, '权限合约地址尚未保存。');
      const code = await this.provider.getCode(authority, block.number);
      requireThat(code !== '0x' && runtimeMatches(this.bundle.artifacts.PlatformAuthority, code,
        { ...this.genesis.addresses, factory: record.genesis.factory,
          portfolioFactory: record.genesis.portfolioFactory, timelock: record.genesis.timelock }, authority),
        '权限合约代码与构建不一致。');
      const contract = new Contract(authority, AUTHORITY_ABI, this.provider);
      const actual = await Promise.all(['owner','coreFactory','budgetFactory','administratorOne','administratorTwo','gasWallet']
        .map(name => contract[name](at)));
      const expected = [record.genesis.timelock, record.genesis.factory, record.genesis.portfolioFactory,
        record.administratorOne, record.administratorTwo, record.gasWallet];
      requireThat(actual.every((value, index) => same(value, expected[index])),
        '权限合约的 Factory、管理员、Gas 钱包或所有者绑定错误。');
    }
    requireThat((await this.provider.getBlock(block.number))?.hash === block.hash,
      '核验过程中区块发生重组。');
    return block;
  }

  async verifiedManifest(saved: FreshActivationRecord): Promise<ActivatedDeploymentManifest> {
    return this.exclusive(async () => {
      const record = await this.latest(saved);
      const evidence = activationEvidence(record);
      const base = deploymentManifest(this.genesis, this.bundle);
      const block = await this.verifyPinnedState(record, FRESH_ACTIVATION_STEPS.length);
      const code = await this.provider.getCode(record.authorityAddress!, block.number);
      requireThat(code !== '0x' && runtimeMatches(this.bundle.artifacts.PlatformAuthority, code,
        this.genesis.addresses, record.authorityAddress!), '平台权限合约的运行代码已变更。');
      requireThat((await this.provider.getBlock(block.number))?.hash === block.hash,
        '激活清单核验期间区块发生重组。');
      return activatedDeploymentManifest(base, evidence, keccak256(code));
    });
  }

  async prepare(maxGasBudgetBnb: string, gasPriceCapGwei: string,
    gasWalletInput: string): Promise<FreshActivationRecord> {
    return this.exclusive(async () => {
      requireThat(await this.journal.loadFreshActivation() === null, '已有激活记录，请恢复该记录。');
      const account = await this.account();
      const gasWallet = validatedFreshGasWallet(gasWalletInput, account);
      const credential = await this.journal.freshActivationCredentialStatus();
      requireThat(credential.credentialVerified && credential.gasWallet
        && same(credential.gasWallet, gasWallet),
      '服务器中的 Gas 钱包凭据尚未核验，或派生公开地址与填写地址不一致。');
      requireThat(this.genesis.kind === 'integrated-v2' && this.genesis.status === 'complete'
        && same(this.genesis.input.ownerMultisig, account)
        && same(this.genesis.input.operator, account)
        && same(this.genesis.input.treasury, account),
      '新硬件钱包必须是此完整新部署的初始 owner、operator 和 treasury。');
      requireThat(artifactDigest(this.bundle) === this.genesis.artifactDigest,
        '当前合约构建不是这次部署使用的构建。');
      requireThat(parseEther(maxGasBudgetBnb) > 0n && parseUnits(gasPriceCapGwei, 'gwei') > 0n,
        '激活 Gas 预算和单价上限必须大于零。');
      // Re-run the complete genesis proof before any role is changed.
      const verifier = new DeploymentEngine(this.wallet, this.bundle, {
        persist: () => { throw new Error('只读核验不得保存部署进度。'); },
      });
      const inspected = await verifier.inspectGraphForManifest(this.genesis);
      const manifest: DeploymentManifest = deploymentManifest(inspected, this.bundle);
      requireThat(manifest.kind === 'integrated-v2' && manifest.portfolioFactory && manifest.portfolioMarket,
        '这不是完整的单机与多机一体化部署。');
      const now = new Date().toISOString();
      const record: FreshActivationRecord = {
        schemaVersion: 1, kind: 'fresh-authority', chainId: 56, account,
        deploymentId: this.genesis.id, genesisArtifactDigest: this.genesis.artifactDigest,
        genesis: { factory: manifest.factory, portfolioFactory: manifest.portfolioFactory,
          timelock: manifest.timelock, shareMarket: manifest.shareMarket,
          portfolioMarket: manifest.portfolioMarket, codehash: manifest.codehash },
        administratorOne: FRESH_ADMIN_ONE, administratorTwo: FRESH_ADMIN_TWO,
        gasWallet, createdAt: now, updatedAt: now,
        maxGasBudgetBnb, gasPriceCapGwei, spentWei: '0', status: 'ready',
        steps: FRESH_ACTIVATION_STEPS.map((id, index) => ({ id, label: LABELS[index], status: 'waiting' })),
      };
      await this.verifyPinnedState(record, 0);
      await this.save(record);
      return record;
    });
  }

  async sendNext(saved: FreshActivationRecord): Promise<FreshActivationRecord> {
    return this.exclusive(async () => {
      const record = await this.latest(saved);
      requireThat(record.status !== 'complete' && record.status !== 'aborted', '激活已经完成或终止。');
      // A restored server journal is not the authority for the initial role
      // owners or the two fixed administrators. Keep read-only recovery open,
      // but pin these values again before asking the hardware wallet to sign.
      requireThat(this.genesis.kind === 'integrated-v2' && this.genesis.status === 'complete'
        && same(this.genesis.input.ownerMultisig, record.account)
        && same(this.genesis.input.operator, record.account)
        && same(this.genesis.input.treasury, record.account)
        && same(record.administratorOne, FRESH_ADMIN_ONE)
        && same(record.administratorTwo, FRESH_ADMIN_TWO),
      '恢复的部署角色或管理员地址与已确认的新部署方案不一致；停止签名。');
      const index = record.steps.findIndex(step => step.status !== 'confirmed');
      requireThat(index >= 0, '所有交易已发送；请执行最终核验。');
      const step = record.steps[index];
      requireThat(step.status === 'waiting' || step.status === 'rejected',
        '交易处于待确认或结果不明状态；只可核验，不能重发。');
      const credential = await this.journal.freshActivationCredentialStatus();
      requireThat(credential.credentialVerified && credential.gasWallet
        && same(credential.gasWallet, record.gasWallet), '服务器 Gas 钱包凭据派生地址已变化，停止请求硬件钱包签名。');
      await this.verifyPinnedState(record, index);
      const account = await this.account();
      const planned = await activationTransaction(record, this.bundle, step.id as FreshActivationStepId);
      const [fees, balance, block, nonce, walletLatest, walletPending] = await Promise.all([
        this.provider.getFeeData(), this.provider.getBalance(account), this.provider.getBlock('latest'),
        this.journal.readCurrentNonce(), this.provider.getTransactionCount(account, 'latest'),
        this.provider.getTransactionCount(account, 'pending'),
      ]);
      requireThat(nonce.latest === nonce.pending && walletLatest <= nonce.latest && walletPending <= nonce.latest,
        '钱包存在其他待确认交易或节点 nonce 不一致；停止签名。');
      requireThat(record.steps.filter(item => item.status === 'confirmed').every(item => item.nonce! < nonce.latest),
        '账户 nonce 落后于已确认激活交易。');
      const recovered = step.status === 'rejected' && step.rejectionKind === 'nonce-witnessed';
      const gasPrice = recovered ? BigInt(step.gasPriceWei ?? '0') : fees.gasPrice;
      requireThat(gasPrice && gasPrice > 0n
        && gasPrice <= parseUnits(record.gasPriceCapGwei, 'gwei'), 'Gas 单价超过激活上限。');
      requireThat(block && planned.gasLimit <= block.gasLimit, '激活交易 Gas 上限超出区块限制。');
      const feeLimit = planned.gasLimit * gasPrice;
      requireThat(BigInt(record.spentWei) + feeLimit <= parseEther(record.maxGasBudgetBnb)
        && balance >= feeLimit, '激活 Gas 预算或钱包余额不足。');
      // A wallet may wrap a request in an EIP-7702 type-4 envelope. Dynamic
      // fee fields remain valid in that envelope, while legacy gasPrice does not.
      const tx = { chainId: '0x38', from: account, ...(planned.to ? { to: planned.to } : {}),
        data: planned.data, value: '0x0', nonce: `0x${nonce.latest.toString(16)}`,
        gas: `0x${planned.gasLimit.toString(16)}`,
        maxFeePerGas: `0x${gasPrice.toString(16)}`,
        maxPriorityFeePerGas: `0x${gasPrice.toString(16)}`, type: '0x2' };
      if (step.status === 'rejected') {
        requireThat(step.nonce === nonce.latest && step.dataHash === keccak256(planned.data),
          '上次拒签后 nonce 或交易内容已变化；不能按原写前记录重新签名，必须先核对链上。');
        if (recovered) requireThat(step.gasLimit === planned.gasLimit.toString()
          && step.maxFeeWei === feeLimit.toString(),
        '已恢复交易的 Gas 字段与原写前记录不一致；不能重新签名。');
      }
      Object.assign(step, { status: 'signing', nonce: nonce.latest,
        dataHash: keccak256(planned.data), gasLimit: planned.gasLimit.toString(),
        gasPriceWei: gasPrice.toString(), maxFeeWei: feeLimit.toString() });
      delete step.rejectionKind;
      record.status = 'paused'; delete record.error;
      await this.save(record); // Durable write-ahead intent before hardware-wallet request.
      let hash: string;
      let attemptedBroadcast = false;
      let nonceConflict = false;
      try {
        await this.account();
        await this.journal.assertCurrentArtifact(record.genesisArtifactDigest);
        const currentCredential = await this.journal.freshActivationCredentialStatus();
        requireThat(currentCredential.credentialVerified && currentCredential.gasWallet
          && same(currentCredential.gasWallet, record.gasWallet),
        '签名前服务器 Gas 钱包凭据已变化。');
        const current = await this.journal.readCurrentNonce();
        if (current.latest !== step.nonce || current.pending !== step.nonce) {
          nonceConflict = true;
          throw new Error('签名前 nonce 变化；保留意图，必须核验。');
        }
        await this.account();
        attemptedBroadcast = true;
        hash = await this.wallet.request({ method: 'eth_sendTransaction', params: [tx] }) as string;
        requireThat(typeof hash === 'string' && HASH.test(hash), '钱包未返回有效哈希。');
      } catch (error) {
        const failure = error as { code?: number | string; info?: { error?: { code?: number } } };
        const walletRejected = attemptedBroadcast && (failure.code === 4001
          || failure.code === 'ACTION_REJECTED' || failure.info?.error?.code === 4001);
        const definiteNoSend = !attemptedBroadcast && !nonceConflict;
        let invalidEnvelopeNotSent = false;
        if (attemptedBroadcast && !step.txHash && invalidEnvelopeError(error)) {
          try {
            // This envelope validation failure occurs before broadcast, but
            // two independent nonce views must still agree before retry.
            const [independent, walletLatest, walletPending] = await Promise.all([
              this.journal.readCurrentNonce(), this.provider.getTransactionCount(account, 'latest'),
              this.provider.getTransactionCount(account, 'pending'),
            ]);
            invalidEnvelopeNotSent = independent.latest === step.nonce && independent.pending === step.nonce
              && walletLatest === step.nonce && walletPending === step.nonce;
          } catch { /* An unavailable nonce witness leaves the intent uncertain. */ }
        }
        step.status = definiteNoSend || walletRejected || invalidEnvelopeNotSent ? 'rejected' : 'uncertain';
        if (step.status === 'rejected') step.rejectionKind = walletRejected ? 'wallet-rejected' : 'pre-send';
        step.error = String(error).slice(0, 600);
        record.error = invalidEnvelopeNotSent
          ? '钱包拒绝了旧式 Gas 交易格式，双重 nonce 核对仍未使用。现可手动重试；不会自动发送。'
          : step.status === 'rejected'
          ? '钱包尚未广播此笔交易。核对 nonce 和交易内容后，可手动再次请求硬件钱包。'
          : '签名或广播结果不明。请用钱包交易哈希核验，不会自动重发。';
        await this.save(record);
        throw error;
      }
      step.txHash = hash; step.status = 'submitted';
      await this.save(record);
      return record;
    });
  }

  /** Release only a hashless write-ahead intent whose nonce is still unused in both views. */
  async releaseUnusedSigning(saved: FreshActivationRecord): Promise<FreshActivationRecord> {
    return this.exclusive(async () => {
      const record = await this.latest(saved);
      const index = record.steps.findIndex(step => step.status !== 'confirmed');
      const step = record.steps[index];
      requireThat(record.status === 'paused' && step?.status === 'signing'
        && !step.txHash && !step.receipt && Number.isSafeInteger(step.nonce),
      '当前没有可用 nonce 核对解除的无哈希签名记录。');
      requireThat(this.genesis.kind === 'integrated-v2' && this.genesis.status === 'complete'
        && same(this.genesis.input.ownerMultisig, record.account)
        && same(this.genesis.input.operator, record.account)
        && same(this.genesis.input.treasury, record.account)
        && same(record.administratorOne, FRESH_ADMIN_ONE)
        && same(record.administratorTwo, FRESH_ADMIN_TWO),
      '恢复的部署角色或管理员地址与已确认的新部署方案不一致；停止恢复。');
      const planned = await activationTransaction(record, this.bundle, step.id as FreshActivationStepId);
      requireThat(step.dataHash === keccak256(planned.data)
        && step.gasLimit === planned.gasLimit.toString()
        && step.gasPriceWei && BigInt(step.gasPriceWei) > 0n
        && step.maxFeeWei === (planned.gasLimit * BigInt(step.gasPriceWei)).toString(),
      '写前记录中的交易内容或 Gas 字段与当前方案不一致，不能解除。');
      await this.verifyPinnedState(record, index);
      const account = await this.account();
      const [server, walletLatest, walletPending] = await Promise.all([
        this.journal.readCurrentNonce(), this.provider.getTransactionCount(account, 'latest'),
        this.provider.getTransactionCount(account, 'pending'),
      ]);
      requireThat(server.latest === step.nonce && server.pending === step.nonce
        && walletLatest === step.nonce && walletPending === step.nonce,
      '服务器或钱包的 nonce 已变化或存在待确认交易；先核对原交易哈希。');
      const released = await this.journal.releaseUnusedFreshSigning(step.id, step.nonce, step.dataHash);
      requireThat(released.deploymentId === record.deploymentId && same(released.account, account)
        && released.steps[index]?.id === step.id
        && released.genesis.factory === record.genesis.factory
        && released.genesis.portfolioFactory === record.genesis.portfolioFactory
        && released.genesis.timelock === record.genesis.timelock
        && released.authorityAddress === record.authorityAddress
        && released.steps[index]?.status === 'rejected'
        && released.steps[index].rejectionKind === 'nonce-witnessed'
        && released.steps[index].nonce === step.nonce
        && released.steps[index].dataHash === step.dataHash
        && released.steps[index].gasLimit === step.gasLimit
        && released.steps[index].gasPriceWei === step.gasPriceWei
        && released.steps[index].maxFeeWei === step.maxFeeWei
        && !released.steps[index].txHash,
      '服务器返回的 nonce 恢复状态与原签名记录不一致。');
      this.onUpdate?.(clone(released));
      return released;
    });
  }

  private async finalizedReceipt(hash: string): Promise<TransactionReceipt | null> {
    const receipt = await this.provider.getTransactionReceipt(hash);
    if (!receipt) return null;
    const [canonical, finalized, latest] = await Promise.all([
      this.provider.getBlock(receipt.blockNumber), this.provider.getBlock('finalized'), this.provider.getBlock('latest'),
    ]);
    if (!canonical?.hash || !finalized?.hash || !latest
      || canonical.hash !== receipt.blockHash || finalized.number < receipt.blockNumber
      || latest.number - receipt.blockNumber + 1 < 2) return null;
    requireThat(receipt.status === 0 || receipt.status === 1, '规范链回执缺少明确执行状态。');
    requireThat((await this.provider.getTransactionReceipt(hash))?.blockHash === receipt.blockHash
      && (await this.provider.getBlock(receipt.blockNumber))?.hash === receipt.blockHash,
      '规范链回执在核验中变化。');
    return receipt;
  }

  async reconcile(saved: FreshActivationRecord, recoveryHash?: string): Promise<FreshActivationRecord> {
    return this.exclusive(async () => {
      const record = await this.latest(saved);
      const index = record.steps.findIndex(step => step.status !== 'confirmed');
      if (index === -1) {
        await this.verifyPinnedState(record, FRESH_ACTIVATION_STEPS.length);
        record.status = 'complete'; delete record.error;
        await this.save(record); return record;
      }
      const step = record.steps[index];
      requireThat(['signing','submitted','uncertain'].includes(step.status),
        '此步骤没有待核验交易。');
      const hash = recoveryHash?.trim() || step.txHash;
      requireThat(hash && HASH.test(hash), '请输入钱包中的原交易、加速或取消交易哈希。');
      const tx = await this.provider.getTransaction(hash);
      const receipt = await this.finalizedReceipt(hash);
      if (!tx || !receipt) return record; // Still pending or not finalized; never resend.
      requireThat(tx.chainId === 56n && same(tx.from, record.account)
        && tx.nonce === step.nonce && same(receipt.from, record.account)
        && tx.blockHash === receipt.blockHash && tx.blockNumber === receipt.blockNumber,
        '交易链、签名钱包、nonce 或规范链身份与写前记录不一致。');
      const planned = await activationTransaction(record, this.bundle, step.id as FreshActivationStepId);
      const exact = tx.value === 0n && keccak256(tx.data) === step.dataHash
        && keccak256(planned.data) === step.dataHash
        && (planned.to === undefined ? tx.to === null : tx.to !== null && same(tx.to, planned.to));
      if (!exact || receipt.status !== 1) {
        step.status = receipt.status !== 1 ? 'failed' : 'replaced';
        if (step.txHash && !same(step.txHash, hash)) step.replacementHash = hash;
        step.txHash = step.txHash || hash;
        step.receipt = { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
          status: receipt.status!, gasUsed: receipt.gasUsed.toString(),
          gasPrice: receipt.gasPrice.toString(), feeWei: receipt.fee.toString() };
        record.spentWei = record.steps.reduce((sum, item) => sum + BigInt(item.receipt?.feeWei ?? '0'), 0n).toString();
        record.status = 'aborted'; record.error = '激活交易已被取消、替换或链上失败。此七步计划已终止，禁止重发。';
        await this.save(record);
        return record;
      }
      if (step.txHash && !same(step.txHash, hash)) {
        // A successful same-payload acceleration is valid, but the original
        // hash remains in evidence as immutable provenance in the journal.
        step.previousTxHashes = [...(step.previousTxHashes ?? []), step.txHash];
        step.finalizedRecovery = true;
      }
      step.txHash = hash;
      step.receipt = { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
        status: 1, gasUsed: receipt.gasUsed.toString(), gasPrice: receipt.gasPrice.toString(),
        feeWei: receipt.fee.toString() };
      if (step.id === 'deployAuthority') {
        const predicted = getCreateAddress({ from: record.account, nonce: step.nonce! });
        requireThat(receipt.contractAddress && same(receipt.contractAddress, predicted),
          '权限合约 CREATE 地址与部署者/nonce 不一致。');
        record.authorityAddress = predicted;
        step.address = predicted;
      }
      // Successful receipt is recorded even if an unrelated state mutation
      // makes the next step unsafe; the journal cannot erase a mined tx.
      step.status = 'confirmed';
      record.spentWei = record.steps.reduce((sum, item) => sum + BigInt(item.receipt?.feeWei ?? '0'), 0n).toString();
      record.status = 'paused'; delete record.error;
      await this.save(record);
      await this.verifyPinnedState(record, index + 1);
      if (index + 1 === FRESH_ACTIVATION_STEPS.length) {
        record.status = 'complete';
        await this.save(record);
      }
      return record;
    });
  }
}
