import { getAddress, getCreateAddress, keccak256, ZeroAddress, type Provider, type TransactionReceipt } from 'ethers';
import type { WalletProvider } from './wallet';
// Reuse the unchanged, tested nonce/finality/transmission gates. Governance
// batch receipt proofs and the journal namespace remain separate below.
import { validateFirstoBatchIntent, prepareFirstoBatchIntent, assertFirstoBatchIntentCurrent,
  waitForFirstoBatchFinality, submitFirstoBatchUpgrade } from './firsto-batch-upgrade-ui';
export const validateGovernance24Intent: typeof validateFirstoBatchIntent = validateFirstoBatchIntent;
export const prepareGovernance24Intent = prepareFirstoBatchIntent;
export const assertGovernance24IntentCurrent = assertFirstoBatchIntentCurrent;
export const waitForGovernance24Finality = waitForFirstoBatchFinality;
export const submitGovernance24Upgrade = submitFirstoBatchUpgrade;
// @ts-ignore Shared canonical digest has no TypeScript declarations.
import { evidenceDigest } from '../shared/firsto-upgrade-proof.mjs';
// @ts-ignore The shared verifier preserves canonical single-call, wallet-envelope and event bindings.
import { verifyGovernance24OperationReceipt } from '../shared/governance24-upgrade-proof.mjs';
export type Governance24Intent = { schemaVersion: 1; chainId: 56; nonce: number;
  anchor: { blockNumber: number; blockHash: string } };
export type UpgradeTransaction = { status: 'submitted' | 'confirmed' | 'uncertain'; from: string;
  dataHash: string; txHash?: string; address?: string; intent?: Governance24Intent };

// @ts-ignore The deployment order is shared with the strict reviewed plan builder.
import { governance24UpgradeDeploymentOrder } from '../shared/governance24-upgrade-plan.mjs';
export type Governance24Name = 'FlexiblePurchase' | 'PoolVault' | 'BudgetPortfolioVault' | 'PoolTimelock24'
  | 'CoreGovernance24Beacon' | 'PortfolioGovernance24Beacon' | 'CoreGovernance24Dispatcher' | 'PortfolioGovernance24Dispatcher'
  | 'Governance24Validation' | 'Governance24FreshPoolFactory' | 'Governance24BudgetPortfolioFactory'
  | 'CoreGovernance24ShareMarket' | 'PortfolioGovernance24ShareMarket';
export const GOVERNANCE24_DEPLOYMENTS: readonly Governance24Name[] = governance24UpgradeDeploymentOrder;
export type Governance24Context = { factory: string; genesisRecordDigest: string; genesisManifestDigest: string; candidateArtifactDigest: string; catalogDigest: string; predecessorInputDigest: string };
export type Governance24Journal = Governance24Context & {
  schemaVersion: 1; kind: 'governance24-upgrade-journal-v1'; salt: string; delaySeconds: number;
  deployments: Partial<Record<Governance24Name, UpgradeTransaction>>;
  schedule?: UpgradeTransaction; execute?: UpgradeTransaction;
  failedTransactions?: { step: Governance24Name | 'schedule' | 'execute'; transaction: UpgradeTransaction; evidence: FailedGovernance24Receipt }[];
  abandonedUnknownDeployments?: AbandonedUnknownGovernance24Deployment[];
};
export type AbandonedUnknownGovernance24Deployment = {
  step: Governance24Name; transaction: UpgradeTransaction;
  reason: 'user-canceled-wallet-request'; acknowledged: true; checkedAt: string;
  /** An observation made when archiving; this is never the unknown request's nonce. */
  observedIntent: Governance24Intent;
};
export type FailedGovernance24Receipt = { kind: 'governance24-finalized-failed-transaction-v1'; chainId: 56; status: 0;
  txHash: string; from: string; to: string | null; value: '0'; dataHash: string; blockNumber: number; blockHash: string;
  gasUsed: string; checkedAt: string };
const hash = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
const need: (ok: unknown, reason: string) => asserts ok = (ok, reason) => { if (!ok) throw new Error(reason); };
const nonceValue = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const rpcRead = (provider: Provider, method: string, params: unknown[]) => (provider as Provider & { send(method: string, params: unknown[]): Promise<any> }).send(method, params);
const chainRead = (provider: Provider) => rpcRead(provider, 'eth_chainId', []);
const rpcUint = (value: unknown): bigint => {
  need(typeof value === 'string' && /^0x(?:0|[1-9a-f][\da-f]*)$/i.test(value), '节点返回的整数不是规范 JSON-RPC quantity。');
  return BigInt(value);
};
const rpcTag = (tag: number | 'latest' | 'pending') => typeof tag === 'number' ? `0x${tag.toString(16)}` : tag;
async function readNonce(provider: Provider, from: string, tag: number | 'latest' | 'pending') {
  const value = rpcUint(await rpcRead(provider, 'eth_getTransactionCount', [getAddress(from), rpcTag(tag)]));
  need(value <= BigInt(Number.MAX_SAFE_INTEGER), '节点返回的 nonce 超出精确整数范围。'); return Number(value);
}
function chain56(value: unknown) { need(typeof value === 'string' && /^0x[\da-f]+$/i.test(value) && BigInt(value) === 56n, '恢复需要 BSC 主网。'); }
async function intentAnchor(provider: Provider, from: string, intent: Governance24Intent) {
  validateGovernance24Intent(intent); const account = getAddress(from); need(account !== ZeroAddress, '发送者不能为零地址。');
  const [chain, block, count] = await Promise.all([chainRead(provider), provider.getBlock(intent.anchor.blockNumber),
    readNonce(provider, account, intent.anchor.blockNumber)]);
  chain56(chain);
  need(block?.number === intent.anchor.blockNumber && block.hash?.toLowerCase() === intent.anchor.blockHash.toLowerCase()
    && nonceValue(count) && count <= intent.nonce, '发送前区块锚点已变化，或该 nonce 在发送前已被消费。');
  return count;
}
type Governance24RecoveryIdentity = { from: string; to?: string; dataHash: string; intent?: Governance24Intent;
  /** Only governance calls may use the reviewed MetaMask wrapper; CREATE remains direct. */
  data?: string; operation?: 'schedule' | 'execute'; input?: Record<string, any>; plan?: Record<string, any> };

/** At most 32 nonce bisections and one full block. No mempool absence can authorize a retry. */
export async function discoverGovernance24Transaction(provider: Provider, expected: Governance24RecoveryIdentity): Promise<string | null> {
  if (!expected.intent) return null; // Legacy journal: no inference or migration from the current nonce.
  const intent = expected.intent; validateGovernance24Intent(intent);
  const from = getAddress(expected.from); need(from !== ZeroAddress && hash(expected.dataHash), '原发送者或 calldata 摘要无效。');
  if (expected.to !== undefined) need(getAddress(expected.to) !== ZeroAddress, '原交易目标无效。');
  const [anchorCount, finalized] = await Promise.all([intentAnchor(provider, from, intent), provider.getBlock('finalized')]);
  need(finalized && hash(finalized.hash) && nonceValue(finalized.number) && finalized.number >= intent.anchor.blockNumber,
    '最终确认区块未覆盖发送前锚点。');
  const checkSnapshot = async () => {
    const [chain, anchor, finality] = await Promise.all([chainRead(provider), provider.getBlock(intent.anchor.blockNumber), provider.getBlock(finalized.number)]);
    chain56(chain);
    need(anchor?.hash?.toLowerCase() === intent.anchor.blockHash.toLowerCase()
      && finality?.hash?.toLowerCase() === finalized.hash!.toLowerCase(), '查找期间规范链或最终区块发生变化。');
  };
  const finalCount = await readNonce(provider, from, finalized.number);
  need(nonceValue(finalCount) && finalCount >= anchorCount, '最终区块 nonce 响应不一致。');
  if (finalCount <= intent.nonce) { await checkSnapshot(); return null; }
  need(finalized.number - intent.anchor.blockNumber <= 0xffff_ffff, '原交易查找超出有界区块范围，需要人工核对。');
  let low = intent.anchor.blockNumber, high = finalized.number, lowCount = anchorCount, highCount = finalCount;
  for (let round = 0; high - low > 1; round++) {
    need(round < 32, '原交易查找超过有界读取次数。');
    const middle = low + Math.floor((high - low) / 2), count = await readNonce(provider, from, middle);
    need(nonceValue(count) && count >= lowCount && count <= highCount, '历史 nonce 响应不单调，停止恢复。');
    if (count > intent.nonce) { high = middle; highCount = count; } else { low = middle; lowCount = count; }
  }
  // The facade may obtain these two extra read methods from the selected wallet;
  // headers and exact transaction/receipt proofs still come from the pinned public provider.
  const [full, block] = await Promise.all([rpcRead(provider, 'eth_getBlockByNumber', [rpcTag(high), true]), provider.getBlock(high)]);
  need(block?.number === high && hash(block.hash) && full && rpcUint(full.number) === BigInt(high)
    && typeof full.hash === 'string' && full.hash.toLowerCase() === block.hash.toLowerCase(), '完整区块与公开节点规范区块不一致。');
  const transactions = full.transactions;
  need(Array.isArray(transactions) && transactions.length <= 10_000 && transactions.length === block.transactions.length
    && transactions.every((tx, index) => tx && typeof tx === 'object' && hash(tx.hash)
      && tx.hash.toLowerCase() === block.transactions[index]?.toLowerCase()),
    '节点未提供有界完整区块交易，不能证明原 nonce。');
  const matches = transactions.filter(tx => typeof tx.from === 'string' && tx.from.toLowerCase() === from.toLowerCase()
    && rpcUint(tx.nonce) === BigInt(intent.nonce));
  need(matches.length === 1, '原 nonce 已消费，但未能找到唯一交易，需人工核对。');
  const tx = matches[0];
  need(hash(tx.hash) && (tx.chainId === undefined || rpcUint(tx.chainId) === 56n) && rpcUint(tx.value) === 0n
    && typeof tx.input === 'string' && /^0x(?:[\da-f]{2})*$/i.test(tx.input)
    && (expected.operation ? !!expected.to && !!expected.data
      : keccak256(tx.input).toLowerCase() === expected.dataHash.toLowerCase()
        && (expected.to ? tx.to && getAddress(tx.to) === getAddress(expected.to) : tx.to === null))
    && rpcUint(tx.blockNumber) === BigInt(high) && tx.blockHash?.toLowerCase() === block.hash.toLowerCase(),
  '原 nonce 已被另一笔交易消费；不能把取消或替换交易当成升级成功。');
  await checkSnapshot();
  try {
    const receipt = await verifyGovernance24RecoveryReceipt(provider, tx.hash, expected);
    if (!receipt) return null;
  } catch (problem) {
    // Matching finalized failures are found too; the existing receipt verifier owns failure archiving.
    if (!(problem instanceof VerifiedGovernance24TransactionFailure)) throw problem;
  }
  await checkSnapshot(); return tx.hash;
}
const contextKeys = ['genesisRecordDigest', 'genesisManifestDigest', 'candidateArtifactDigest', 'catalogDigest', 'predecessorInputDigest'] as const;
export function governance24JournalKey(context: Governance24Context) {
  need(contextKeys.every(key => hash(context[key])), '升级摘要格式无效。');
  need(getAddress(context.factory) !== ZeroAddress, '正式 Factory 地址无效。');
  return `bemine.governance24-upgrade.v1.${getAddress(context.factory).toLowerCase()}.`
    + contextKeys.map(key => context[key].toLowerCase()).join('.');
}
export function newGovernance24Journal(context: Governance24Context, salt: string): Governance24Journal {
  governance24JournalKey(context); need(hash(salt) && BigInt(salt) !== 0n, '本次升级 salt 必须为非零 32 字节。');
  return { ...context, schemaVersion: 1, kind: 'governance24-upgrade-journal-v1', salt, delaySeconds: 172800, deployments: {} };
}
export function parseGovernance24Journal(value: unknown, context: Governance24Context): Governance24Journal {
  const item = value as Governance24Journal;
  need(item && item.schemaVersion === 1 && item.kind === 'governance24-upgrade-journal-v1'
    && governance24JournalKey(item) === governance24JournalKey(context), '升级记录与本页固定的正式图或候选产物不匹配。');
  need(Object.keys(item).every(key => ['factory', ...contextKeys, 'schemaVersion', 'kind', 'salt', 'delaySeconds',
    'deployments', 'schedule', 'execute', 'failedTransactions', 'abandonedUnknownDeployments'].includes(key)), '记录包含本次升级以外的操作。');
  need(hash(item.salt) && BigInt(item.salt) !== 0n && Number.isSafeInteger(item.delaySeconds) && item.delaySeconds >= 172800,
    '恢复记录需要非零 salt 和至少 48 小时。');
  need(item.deployments && typeof item.deployments === 'object' && !Array.isArray(item.deployments)
    && Object.keys(item.deployments).every(name => GOVERNANCE24_DEPLOYMENTS.includes(name as Governance24Name)), '只能恢复本页固定顺序的候选合约。');
  const addresses = new Set<string>(), transactions = new Set<string>(); let ended = false;
  function transaction(tx: UpgradeTransaction, deployment: boolean) {
    need(tx && typeof tx === 'object' && !Array.isArray(tx)
      && Object.keys(tx).every(key => ['status', 'from', 'dataHash', 'txHash', 'address', 'intent'].includes(key))
      && ['submitted', 'confirmed', 'uncertain'].includes(tx.status) && hash(tx.dataHash)
      && (tx.txHash === undefined || hash(tx.txHash)) && getAddress(tx.from) !== ZeroAddress, '升级交易字段无效。');
    need(tx.status === 'uncertain' || hash(tx.txHash), '已提交或确认交易缺少原交易哈希。');
    if (tx.intent !== undefined) validateGovernance24Intent(tx.intent);
    if (tx.txHash) { need(!transactions.has(tx.txHash.toLowerCase()), '原交易哈希重复。'); transactions.add(tx.txHash.toLowerCase()); }
    if (deployment && tx.status === 'confirmed') {
      need(tx.address && getAddress(tx.address) !== ZeroAddress, '已确认部署缺少合约地址。');
      need(!addresses.has(tx.address.toLowerCase()), '候选部署地址重复。'); addresses.add(tx.address.toLowerCase());
    } else need(tx.address === undefined, '未确认部署或时间锁不能记录已验证的合约地址。');
  }
  for (const name of GOVERNANCE24_DEPLOYMENTS) {
    const tx = item.deployments[name]; if (!tx) { ended = true; continue; }
    need(!ended, '候选部署必须按本页固定步骤顺序恢复。');
    transaction(tx, true); if (tx.status !== 'confirmed') ended = true;
  }
  for (const tx of [item.schedule, item.execute]) if (tx) {
    need(GOVERNANCE24_DEPLOYMENTS.every(name => item.deployments[name]?.status === 'confirmed'), '时间锁操作需要全部已确认部署。');
    transaction(tx, false);
  }
  if (item.execute) need(item.schedule?.status === 'confirmed', '执行升级必须先确认原排程。');
  need(item.failedTransactions === undefined || Array.isArray(item.failedTransactions) && item.failedTransactions.length <= 100,
    '失败回执归档格式无效。');
  for (const failed of item.failedTransactions ?? []) {
    need([...GOVERNANCE24_DEPLOYMENTS, 'schedule', 'execute'].includes(failed.step)
      && failed.transaction.status !== 'confirmed', '失败归档不能替代成功步骤。');
    transaction(failed.transaction, false); const evidence = failed.evidence;
    need(evidence?.kind === 'governance24-finalized-failed-transaction-v1' && evidence.chainId === 56 && evidence.status === 0
      && evidence.value === '0' && hash(evidence.txHash) && hash(evidence.dataHash) && hash(evidence.blockHash)
      && evidence.txHash.toLowerCase() === failed.transaction.txHash?.toLowerCase()
      && evidence.dataHash.toLowerCase() === failed.transaction.dataHash.toLowerCase()
      && getAddress(evidence.from) === getAddress(failed.transaction.from)
      && (GOVERNANCE24_DEPLOYMENTS.includes(failed.step as Governance24Name) ? evidence.to === null : evidence.to !== null && getAddress(evidence.to) !== ZeroAddress)
      && Number.isSafeInteger(evidence.blockNumber) && evidence.blockNumber > 0 && /^[1-9]\d*$/.test(evidence.gasUsed)
      && Number.isFinite(Date.parse(evidence.checkedAt)), '失败归档缺少匹配的最终规范回执。');
  }
  need(item.abandonedUnknownDeployments === undefined || Array.isArray(item.abandonedUnknownDeployments)
    && item.abandonedUnknownDeployments.length <= 100, '已关闭旧钱包请求的归档格式无效。');
  let previousStep = -1;
  const previousUnknown = new Map<Governance24Name, UpgradeTransaction>();
  for (const abandoned of item.abandonedUnknownDeployments ?? []) {
    need(abandoned && typeof abandoned === 'object' && !Array.isArray(abandoned)
      && Object.keys(abandoned).length === 6
      && Object.keys(abandoned).every(key => ['step', 'transaction', 'reason', 'acknowledged', 'checkedAt', 'observedIntent'].includes(key))
      && GOVERNANCE24_DEPLOYMENTS.includes(abandoned.step), '只能归档本次固定候选合约的旧钱包请求。');
    const index = GOVERNANCE24_DEPLOYMENTS.indexOf(abandoned.step), original = abandoned.transaction;
    need(index >= previousStep && GOVERNANCE24_DEPLOYMENTS.slice(0, index)
      .every(name => item.deployments[name]?.status === 'confirmed'), '旧钱包请求归档必须保留已确认的部署前缀和步骤顺序。');
    previousStep = index;
    need(original && typeof original === 'object' && !Array.isArray(original)
      && Object.keys(original).length === 3
      && Object.keys(original).every(key => ['status', 'from', 'dataHash'].includes(key))
      && original.status === 'uncertain' && hash(original.dataHash) && getAddress(original.from) !== ZeroAddress,
    '归档原请求只能是没有哈希、nonce 意图或地址的旧部署未知记录。');
    need(abandoned.reason === 'user-canceled-wallet-request' && abandoned.acknowledged === true
      && typeof abandoned.checkedAt === 'string' && Number.isFinite(Date.parse(abandoned.checkedAt))
      && new Date(abandoned.checkedAt).toISOString() === abandoned.checkedAt, '旧钱包请求归档需要明确关闭确认和有效的观测时间。');
    validateGovernance24Intent(abandoned.observedIntent);
    const prior = previousUnknown.get(abandoned.step), active = item.deployments[abandoned.step];
    for (const row of [prior, active]) if (row) need(getAddress(row.from) === getAddress(original.from)
      && row.dataHash.toLowerCase() === original.dataHash.toLowerCase(), '旧请求归档与同一步骤的发送者或 calldata 摘要不匹配。');
    previousUnknown.set(abandoned.step, original);
  }
  return JSON.parse(JSON.stringify(item)) as Governance24Journal;
}

/** Full exports include a large, informational plan; only the validated journal is restored. */
export async function parseGovernance24ImportFile(file: Pick<Blob, 'size' | 'text'>,
  context: Governance24Context): Promise<Governance24Journal> {
  const maxFileBytes = 512 * 1024, maxJournalBytes = 100000;
  need(Number.isSafeInteger(file.size) && file.size > 0 && file.size <= maxFileBytes,
    '恢复文件超过 512 KiB，或文件为空。');
  const contents = await file.text();
  need(new TextEncoder().encode(contents).byteLength <= maxFileBytes, '恢复文件超过 512 KiB。');
  const value: unknown = JSON.parse(contents);
  const candidate = value && typeof value === 'object' && 'journal' in value ? value.journal : value;
  const journal = parseGovernance24Journal(candidate, context);
  need(new TextEncoder().encode(JSON.stringify(journal)).byteLength <= maxJournalBytes,
    '升级记录超过 100,000 字节，不能保存。');
  return journal;
}

/** Acknowledges a closed legacy wallet request, without claiming its transaction was found or failed.
 * The caller must obtain currentIntent freshly and persist this result before allowing a later,
 * separate click to prepare a new send. observedIntent is evidence of that observation only. */
export function archiveLegacyGovernance24Deployment(source: Governance24Journal, context: Governance24Context, options: {
  step: Governance24Name | 'schedule' | 'execute'; acknowledged: true; checkedAt: string; currentIntent: Governance24Intent;
}): Governance24Journal {
  const current = parseGovernance24Journal(source, context);
  need(GOVERNANCE24_DEPLOYMENTS.includes(options.step as Governance24Name)
    && governance24Pending(current) === options.step, '只能归档当前待核验的候选合约部署，不能解除治理交易。');
  const step = options.step as Governance24Name, transaction = current.deployments[step]!;
  need(transaction.status === 'uncertain' && transaction.txHash === undefined
    && transaction.intent === undefined && transaction.address === undefined
    && Object.keys(transaction).length === 3,
  '已有交易哈希、发送意图或地址的请求必须恢复原交易，不能按旧钱包请求归档。');
  need(options.acknowledged === true, '请先明确确认已关闭或取消原钱包请求。');
  validateGovernance24Intent(options.currentIntent);
  const next: Governance24Journal = { ...current, deployments: { ...current.deployments },
    abandonedUnknownDeployments: [...current.abandonedUnknownDeployments ?? [], {
      step, transaction, reason: 'user-canceled-wallet-request', acknowledged: true,
      checkedAt: options.checkedAt, observedIntent: options.currentIntent,
    }] };
  delete next.deployments[step];
  return parseGovernance24Journal(next, context);
}
export function governance24Pending(journal: Governance24Journal) {
  return GOVERNANCE24_DEPLOYMENTS.find(name => journal.deployments[name] && journal.deployments[name]?.status !== 'confirmed')
    ?? (journal.schedule && journal.schedule.status !== 'confirmed' ? 'schedule'
      : journal.execute && journal.execute.status !== 'confirmed' ? 'execute' : null);
}
export function governance24Next(journal: Governance24Journal) {
  return governance24Pending(journal) ? null : GOVERNANCE24_DEPLOYMENTS.find(name => !journal.deployments[name]) ?? null;
}
export function confirmedGovernance24Deployments(journal: Governance24Journal) {
  return Object.fromEntries(GOVERNANCE24_DEPLOYMENTS.filter(name => journal.deployments[name]?.status === 'confirmed')
    .map(name => [name, { address: journal.deployments[name]!.address!, txHash: journal.deployments[name]!.txHash! }]));
}
export function governance24ActionReady(options: {
  action: 'deploy' | 'schedule' | 'execute'; onBsc: boolean; signerAuthorized: boolean; pending: boolean;
  graphVerified: boolean; prefixVerified: boolean; completedDeployments: number;
  operation: 'unknown' | 'unscheduled' | 'waiting' | 'ready' | 'done'; scheduleConfirmed: boolean;
}) {
  if (!options.onBsc || !options.signerAuthorized || options.pending || !options.graphVerified || !options.prefixVerified) return false;
  if (options.action === 'deploy') return options.completedDeployments < GOVERNANCE24_DEPLOYMENTS.length && options.operation !== 'done';
  if (options.completedDeployments !== GOVERNANCE24_DEPLOYMENTS.length) return false;
  return options.action === 'schedule' ? options.operation === 'unscheduled'
    : options.operation === 'ready' && options.scheduleConfirmed;
}

export type Governance24Step = Governance24Name | 'schedule' | 'execute';
export type Governance24Operation = 'unknown' | 'unscheduled' | 'waiting' | 'ready' | 'done';
export type Governance24SequenceResult = { journal: Governance24Journal; outcome: 'waiting' | 'unknown' | 'failed' | 'done'; readyAt?: number | null };

/** The last candidate opens governance; a prepared-only proof cannot classify its operation. */
export function governance24RecoveryPhase(step: Governance24Step) {
  return step === 'schedule' ? 'scheduled' as const : step === 'execute' ? 'done' as const
    : step === GOVERNANCE24_DEPLOYMENTS.at(-1) ? undefined : 'prepared' as const;
}

/** Advance only from verified, durable rows; an unknown wallet result is never resent. */
export async function runGovernance24UpgradeSequence(options: {
  journal: Governance24Journal; assertCurrent: () => void;
  inspect: (source: Governance24Journal) => Promise<{ operation: Governance24Operation; readyAt?: number | null }>;
  submit: (source: Governance24Journal, step: Governance24Step) => Promise<Governance24Journal>;
  recover: (source: Governance24Journal, step: Governance24Step) => Promise<{ journal: Governance24Journal; outcome: 'confirmed' | 'waiting' | 'failed'; readyAt?: number | null }>;
}): Promise<Governance24SequenceResult> {
  let source = options.journal;
  for (let advance = 0; advance < GOVERNANCE24_DEPLOYMENTS.length * 2 + 8; advance++) {
    options.assertCurrent();
    const pending = governance24Pending(source);
    if (pending) {
      const original = pending === 'schedule' || pending === 'execute' ? source[pending]! : source.deployments[pending]!;
      if (!original.txHash) return { journal: source, outcome: 'unknown' };
      const recovered = await options.recover(source, pending); options.assertCurrent(); source = recovered.journal;
      if (recovered.outcome !== 'confirmed') return { journal: source, outcome: recovered.outcome };
      need(!governance24Pending(source), '原交易尚未确认，不能继续请求钱包。');
      // Even a suspended tab that wakes after 48h must require a new click to execute.
      if (pending === 'schedule') return { journal: source, outcome: 'waiting', readyAt: recovered.readyAt };
      if (pending === 'execute') return { journal: source, outcome: 'done', readyAt: recovered.readyAt };
      continue;
    }
    const state = await options.inspect(source); options.assertCurrent();
    if (state.operation === 'done' || state.operation === 'waiting')
      return { journal: source, outcome: state.operation, readyAt: state.readyAt };
    const next = governance24Next(source);
    const step: Governance24Step | null = next ?? (state.operation === 'unscheduled' ? 'schedule'
      : state.operation === 'ready' && source.schedule?.status === 'confirmed' ? 'execute' : null);
    need(step, '当前升级状态尚未核对完成，请稍后继续。');
    if (!next) need(!source[step as 'schedule' | 'execute'], '本机已有原交易，不能重复排程或执行。');
    source = await options.submit(source, step); options.assertCurrent();
    need(governance24Pending(source) === step, '钱包提交结果未写入对应升级步骤。');
  }
  throw new Error('升级步骤未按已验证记录推进，请检查原交易。');
}

/** Gas evidence addresses are local test data and are never turned into deployment claims. */
export function governance24ReviewedGas(evidence: any, pins: Record<string, string>, digest: string) {
  need(hash(digest) && evidenceDigest(evidence).toLowerCase() === digest.toLowerCase(), '候选 Gas 测量摘要不匹配。');
  need(evidence?.kind === 'governance24-offline-create-gas-review-v1' && evidence.schemaVersion === 1
    && evidence.environment?.disposableLoopbackEvm === true && evidence.environment?.forked === false
    && evidence.environment?.productionTransactions === false && evidence.environment?.chainId === 56
    && evidence.environment?.ethEstimateGasCalls === 0 && evidence.fixedCeilingsTested === true,
  '需要本机一次性 EVM 的候选 CREATE 测量证据。');
  for (const key of ['trustedGenesisRecordDigest', 'trustedGenesisManifestDigest',
    'trustedUpgradeArtifactDigest', 'trustedReviewCatalogDigest', 'trustedPredecessorInputDigest']) need(hash(pins[key])
    && evidence.pins?.[key]?.toLowerCase() === pins[key].toLowerCase(), 'Gas 测量与正式图或候选摘要不同。');
  need(evidence.margin?.percent === 20 && evidence.margin?.absoluteGas === 50000 && evidence.margin?.roundUpGas === 10000,
    '候选 Gas 余量策略不匹配。');
  need(Array.isArray(evidence.deployments) && evidence.deployments.length === GOVERNANCE24_DEPLOYMENTS.length, '候选 Gas 测量必须覆盖且仅覆盖全部 CREATE。');
  const limits: Partial<Record<Governance24Name, string>> = {};
  for (const [index, name] of GOVERNANCE24_DEPLOYMENTS.entries()) {
    const row = evidence.deployments[index];
    need(row?.name === name && /^[1-9]\d*$/.test(row.gasUsed) && /^[1-9]\d*$/.test(row.gasLimit), 'Gas 测量顺序或数值无效。');
    const used = BigInt(row.gasUsed), expected = ((used * 120n + 99n) / 100n + 50000n + 9999n) / 10000n * 10000n;
    need(used > 0n && expected <= 9000000n && BigInt(row.gasLimit) === expected, '候选 Gas 上限或有界余量不匹配。');
    limits[name] = row.gasLimit;
  }
  return Object.freeze(limits as Record<Governance24Name, string>);
}

export class VerifiedGovernance24TransactionFailure extends Error {
  constructor(public readonly evidence: FailedGovernance24Receipt) { super('原交易已在规范链上最终失败，可归档后重试同一步。'); }
}

/** Both successful and failed recovery must prove the exact original transaction before changing the journal. */
export async function verifyGovernance24RecoveryReceipt(provider: Provider, hashValue: string,
  expected: Governance24RecoveryIdentity): Promise<TransactionReceipt | null> {
  need(hash(hashValue) && hash(expected.dataHash), '原交易哈希或 calldata 摘要无效。');
  if (expected.intent) await intentAnchor(provider, expected.from, expected.intent);
  const read = provider as Provider & { send(method: string, params: unknown[]): Promise<any> };
  const [chain, finalized, tx, receipt] = await Promise.all([read.send('eth_chainId', []), provider.getBlock('finalized'),
    provider.getTransaction(hashValue), provider.getTransactionReceipt(hashValue)]);
  need(BigInt(chain) === 56n && finalized?.hash, '恢复需要 BSC 主网最终确认区块。');
  if (!tx || !receipt || receipt.blockNumber > finalized.number) return null;
  const matchingAddress = (left: string | null, right: string | undefined) => right ? !!left && getAddress(left) === getAddress(right) : left === null;
  need(tx.hash.toLowerCase() === hashValue.toLowerCase() && receipt.hash.toLowerCase() === hashValue.toLowerCase()
    && tx.chainId === 56n && getAddress(tx.from) === getAddress(expected.from) && getAddress(receipt.from) === getAddress(expected.from)
    && (expected.operation ? !!expected.to && !!expected.data
      : matchingAddress(tx.to, expected.to) && matchingAddress(receipt.to, expected.to)
        && keccak256(tx.data).toLowerCase() === expected.dataHash.toLowerCase()) && tx.value === 0n
    && (!expected.intent || tx.nonce === expected.intent.nonce && receipt.blockNumber > expected.intent.anchor.blockNumber)
    && tx.blockNumber === receipt.blockNumber && tx.blockHash?.toLowerCase() === receipt.blockHash.toLowerCase()
    && (receipt.status === 0 || receipt.status === 1), '原交易发送者、目标、金额、calldata 或回执不匹配。');
  if (expected.operation) await verifyGovernance24OperationReceipt(provider, { tx, receipt, expected, finalized });
  const originalTransaction = { hash: tx.hash, from: tx.from, to: tx.to, value: tx.value, data: tx.data, nonce: tx.nonce,
    chainId: tx.chainId, blockNumber: tx.blockNumber, blockHash: tx.blockHash, index: tx.index, type: tx.type };
  const logDigest = (value: TransactionReceipt) => evidenceDigest(value.logs.map(log => ({ address: log.address,
    data: log.data, topics: [...log.topics], transactionHash: log.transactionHash, blockHash: log.blockHash,
    blockNumber: log.blockNumber, index: log.index, transactionIndex: log.transactionIndex, removed: log.removed })));
  const originalLogs = expected.operation ? logDigest(receipt) : null;
  const block = await provider.getBlock(receipt.blockNumber);
  need(block?.hash?.toLowerCase() === receipt.blockHash.toLowerCase() && block.number === receipt.blockNumber
    && Number.isSafeInteger(receipt.index) && receipt.index >= 0
    && block.transactions[receipt.index]?.toLowerCase() === hashValue.toLowerCase(), '原回执不属于最终规范链交易。');
  const [againChain, againFinality, againBlock, againReceipt, againTransaction] = await Promise.all([read.send('eth_chainId', []),
    provider.getBlock(finalized.number), provider.getBlock(receipt.blockNumber), provider.getTransactionReceipt(hashValue),
    provider.getTransaction(hashValue)]);
  need(BigInt(againChain) === 56n && againFinality?.hash?.toLowerCase() === finalized.hash.toLowerCase()
    && againBlock?.hash?.toLowerCase() === block.hash.toLowerCase() && againReceipt?.status === receipt.status
    && againReceipt.hash.toLowerCase() === receipt.hash.toLowerCase() && againReceipt.blockHash.toLowerCase() === receipt.blockHash.toLowerCase()
    && againReceipt.blockNumber === receipt.blockNumber && againReceipt.index === receipt.index
    && againReceipt.from === receipt.from && againReceipt.to === receipt.to && againReceipt.contractAddress === receipt.contractAddress
    && againTransaction && Object.entries(originalTransaction).every(([key, value]) =>
      (againTransaction as unknown as Record<string, unknown>)[key] === value)
    && (!expected.operation || !againTransaction.authorizationList?.length)
    && (!expected.operation || logDigest(againReceipt) === originalLogs),
  '恢复期间规范链或原交易回执发生变化。');
  if (expected.intent) {
    await intentAnchor(provider, expected.from, expected.intent);
    const count = await readNonce(provider, expected.from, finalized.number);
    need(nonceValue(count) && count > expected.intent.nonce, '最终区块未证明原 nonce 已消费。');
  }
  if (receipt.status === 0) throw new VerifiedGovernance24TransactionFailure({ kind: 'governance24-finalized-failed-transaction-v1',
    chainId: 56, status: 0, txHash: hashValue, from: tx.from, to: tx.to, value: '0', dataHash: expected.dataHash,
    blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, gasUsed: receipt.gasUsed.toString(), checkedAt: new Date().toISOString() });
  need(!!expected.to || receipt.contractAddress, '成功 CREATE 缺少合约地址。');
  if (!expected.to && expected.intent) need(getAddress(receipt.contractAddress!) === getCreateAddress({ from: expected.from, nonce: expected.intent.nonce }),
    'CREATE 地址与原发送者和 nonce 不一致。');
  return receipt;
}

export function archiveGovernance24Failure(source: Governance24Journal, step: Governance24Name | 'schedule' | 'execute',
  evidence: FailedGovernance24Receipt, context: Governance24Context) {
  need(governance24Pending(source) === step, '只能恢复当前待核验原交易。');
  const transaction = step === 'schedule' || step === 'execute' ? source[step]! : source.deployments[step]!;
  need(transaction.txHash, '本次发送结果仍未知，输入的失败回执不能证明原交易，不能解除重试限制。');
  need(transaction.txHash.toLowerCase() === evidence.txHash.toLowerCase(), '失败回执属于另一笔交易。');
  const next = { ...source, deployments: { ...source.deployments }, failedTransactions: [...source.failedTransactions ?? [], {
    step, transaction: { ...transaction, txHash: evidence.txHash }, evidence,
  }] };
  if (step === 'schedule' || step === 'execute') delete next[step]; else delete next.deployments[step];
  return parseGovernance24Journal(next, context);
}
