import { getAddress, getCreateAddress, keccak256, ZeroAddress, type Provider, type TransactionReceipt } from 'ethers';
import type { WalletProvider } from './wallet';
import { sendUpgradeTransaction, UncertainUpgradeSubmission } from './upgrade-transactions';
// @ts-ignore Shared canonical digest has no TypeScript declarations.
import { evidenceDigest } from '../shared/firsto-upgrade-proof.mjs';
// @ts-ignore The shared verifier preserves canonical single-call, wallet-envelope and event bindings.
import { verifyFirstoBatchOperationReceipt } from '../shared/firsto-batch-upgrade-proof.mjs';
export type FirstoBatchIntent = { schemaVersion: 1; chainId: 56; nonce: number;
  anchor: { blockNumber: number; blockHash: string } };
export type UpgradeTransaction = { status: 'submitted' | 'confirmed' | 'uncertain'; from: string;
  dataHash: string; txHash?: string; address?: string; intent?: FirstoBatchIntent };

export const FIRSTO_BATCH_DEPLOYMENTS = ['FlexiblePurchase', 'PoolVault'] as const;
export type FirstoBatchName = typeof FIRSTO_BATCH_DEPLOYMENTS[number];
export type FirstoBatchContext = { factory: string; genesisRecordDigest: string; genesisManifestDigest: string; candidateArtifactDigest: string; catalogDigest: string; priorCoreCatalogDigest: string; protocolReviewDigest: string };
export type FirstoBatchJournal = FirstoBatchContext & {
  schemaVersion: 1; kind: 'firsto-batch-upgrade-journal-v1'; salt: string; delaySeconds: number;
  deployments: Partial<Record<FirstoBatchName, UpgradeTransaction>>;
  schedule?: UpgradeTransaction; execute?: UpgradeTransaction;
  failedTransactions?: { step: FirstoBatchName | 'schedule' | 'execute'; transaction: UpgradeTransaction; evidence: FailedFirstoBatchReceipt }[];
  abandonedUnknownDeployments?: AbandonedUnknownFirstoBatchDeployment[];
};
export type AbandonedUnknownFirstoBatchDeployment = {
  step: FirstoBatchName; transaction: UpgradeTransaction;
  reason: 'user-canceled-wallet-request'; acknowledged: true; checkedAt: string;
  /** An observation made when archiving; this is never the unknown request's nonce. */
  observedIntent: FirstoBatchIntent;
};
export type FailedFirstoBatchReceipt = { kind: 'firsto-batch-finalized-failed-transaction-v1'; chainId: 56; status: 0;
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
export function validateFirstoBatchIntent(value: unknown): asserts value is FirstoBatchIntent {
  const intent = value as FirstoBatchIntent;
  need(intent && typeof intent === 'object' && !Array.isArray(intent)
    && Object.keys(intent).every(key => ['schemaVersion', 'chainId', 'nonce', 'anchor'].includes(key))
    && intent.schemaVersion === 1 && intent.chainId === 56 && nonceValue(intent.nonce)
    && intent.anchor && Object.keys(intent.anchor).every(key => ['blockNumber', 'blockHash'].includes(key))
    && nonceValue(intent.anchor.blockNumber) && intent.anchor.blockNumber > 0 && hash(intent.anchor.blockHash),
  '升级发送意图缺少有效的 nonce 或最终区块锚点。');
}
async function intentAnchor(provider: Provider, from: string, intent: FirstoBatchIntent) {
  validateFirstoBatchIntent(intent); const account = getAddress(from); need(account !== ZeroAddress, '发送者不能为零地址。');
  const [chain, block, count] = await Promise.all([chainRead(provider), provider.getBlock(intent.anchor.blockNumber),
    readNonce(provider, account, intent.anchor.blockNumber)]);
  chain56(chain);
  need(block?.number === intent.anchor.blockNumber && block.hash?.toLowerCase() === intent.anchor.blockHash.toLowerCase()
    && nonceValue(count) && count <= intent.nonce, '发送前区块锚点已变化，或该 nonce 在发送前已被消费。');
  return count;
}
/** Called before persisting a new intent. A busy wallet cannot donate its pending nonce to this upgrade. */
export async function prepareFirstoBatchIntent(provider: Provider, from: string): Promise<FirstoBatchIntent> {
  const account = getAddress(from); need(account !== ZeroAddress, '发送者不能为零地址。');
  const [chain, finalized, latest, pending] = await Promise.all([chainRead(provider), provider.getBlock('finalized'),
    readNonce(provider, account, 'latest'), readNonce(provider, account, 'pending')]);
  chain56(chain);
  need(finalized && nonceValue(finalized.number) && finalized.number > 0 && hash(finalized.hash), '无法读取发送前最终确认区块。');
  need(nonceValue(latest) && nonceValue(pending) && latest === pending, '钱包已有待处理交易或 nonce 不一致，请先处理原交易。');
  const intent: FirstoBatchIntent = { schemaVersion: 1, chainId: 56, nonce: latest,
    anchor: { blockNumber: finalized.number, blockHash: finalized.hash } };
  await assertFirstoBatchIntentCurrent(provider, account, intent); return intent;
}
/** Re-read immediately before the wallet request. This never clears or retransmits an existing intent. */
export async function assertFirstoBatchIntentCurrent(provider: Provider, from: string, intent: FirstoBatchIntent): Promise<void> {
  validateFirstoBatchIntent(intent);
  const [count, latest, pending, finalized] = await Promise.all([intentAnchor(provider, from, intent),
    readNonce(provider, from, 'latest'), readNonce(provider, from, 'pending'), provider.getBlock('finalized')]);
  need(count <= intent.nonce && latest === intent.nonce && pending === intent.nonce,
    '发送前钱包 nonce 已变化，请停止并核对原交易。');
  need(finalized && hash(finalized.hash) && nonceValue(finalized.number) && finalized.number >= intent.anchor.blockNumber,
    '最终确认区块未覆盖发送前锚点。');
}
type FirstoBatchRecoveryIdentity = { from: string; to?: string; dataHash: string; intent?: FirstoBatchIntent;
  /** Only governance calls may use the reviewed MetaMask wrapper; CREATE remains direct. */
  data?: string; operation?: 'schedule' | 'execute' };

/** At most 32 nonce bisections and one full block. No mempool absence can authorize a retry. */
export async function discoverFirstoBatchTransaction(provider: Provider, expected: FirstoBatchRecoveryIdentity): Promise<string | null> {
  if (!expected.intent) return null; // Legacy journal: no inference or migration from the current nonce.
  const intent = expected.intent; validateFirstoBatchIntent(intent);
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
    const receipt = await verifyFirstoBatchRecoveryReceipt(provider, tx.hash, expected);
    if (!receipt) return null;
  } catch (problem) {
    // Matching finalized failures are found too; the existing receipt verifier owns failure archiving.
    if (!(problem instanceof VerifiedFirstoBatchTransactionFailure)) throw problem;
  }
  await checkSnapshot(); return tx.hash;
}
const contextKeys = ['genesisRecordDigest', 'genesisManifestDigest', 'candidateArtifactDigest', 'catalogDigest', 'priorCoreCatalogDigest', 'protocolReviewDigest'] as const;
export function firstoBatchJournalKey(context: FirstoBatchContext) {
  need(contextKeys.every(key => hash(context[key])), '升级摘要格式无效。');
  need(getAddress(context.factory) !== ZeroAddress, '正式 Factory 地址无效。');
  return `bemine.firsto-batch-upgrade.v1.${getAddress(context.factory).toLowerCase()}.`
    + contextKeys.map(key => context[key].toLowerCase()).join('.');
}
export function newFirstoBatchJournal(context: FirstoBatchContext, salt: string): FirstoBatchJournal {
  firstoBatchJournalKey(context); need(hash(salt) && BigInt(salt) !== 0n, '本次升级 salt 必须为非零 32 字节。');
  return { ...context, schemaVersion: 1, kind: 'firsto-batch-upgrade-journal-v1', salt, delaySeconds: 172800, deployments: {} };
}
export function parseFirstoBatchJournal(value: unknown, context: FirstoBatchContext): FirstoBatchJournal {
  const item = value as FirstoBatchJournal;
  need(item && item.schemaVersion === 1 && item.kind === 'firsto-batch-upgrade-journal-v1'
    && firstoBatchJournalKey(item) === firstoBatchJournalKey(context), '升级记录与本页固定的正式图或候选产物不匹配。');
  need(Object.keys(item).every(key => ['factory', ...contextKeys, 'schemaVersion', 'kind', 'salt', 'delaySeconds',
    'deployments', 'schedule', 'execute', 'failedTransactions', 'abandonedUnknownDeployments'].includes(key)), '记录包含本次升级以外的操作。');
  need(hash(item.salt) && BigInt(item.salt) !== 0n && Number.isSafeInteger(item.delaySeconds) && item.delaySeconds >= 172800,
    '恢复记录需要非零 salt 和至少 48 小时。');
  need(item.deployments && typeof item.deployments === 'object' && !Array.isArray(item.deployments)
    && Object.keys(item.deployments).every(name => FIRSTO_BATCH_DEPLOYMENTS.includes(name as FirstoBatchName)), '只能恢复两个候选合约。');
  const addresses = new Set<string>(), transactions = new Set<string>(); let ended = false;
  function transaction(tx: UpgradeTransaction, deployment: boolean) {
    need(tx && typeof tx === 'object' && !Array.isArray(tx)
      && Object.keys(tx).every(key => ['status', 'from', 'dataHash', 'txHash', 'address', 'intent'].includes(key))
      && ['submitted', 'confirmed', 'uncertain'].includes(tx.status) && hash(tx.dataHash)
      && (tx.txHash === undefined || hash(tx.txHash)) && getAddress(tx.from) !== ZeroAddress, '升级交易字段无效。');
    need(tx.status === 'uncertain' || hash(tx.txHash), '已提交或确认交易缺少原交易哈希。');
    if (tx.intent !== undefined) validateFirstoBatchIntent(tx.intent);
    if (tx.txHash) { need(!transactions.has(tx.txHash.toLowerCase()), '原交易哈希重复。'); transactions.add(tx.txHash.toLowerCase()); }
    if (deployment && tx.status === 'confirmed') {
      need(tx.address && getAddress(tx.address) !== ZeroAddress, '已确认部署缺少合约地址。');
      need(!addresses.has(tx.address.toLowerCase()), '候选部署地址重复。'); addresses.add(tx.address.toLowerCase());
    } else need(tx.address === undefined, '未确认部署或时间锁不能记录已验证的合约地址。');
  }
  for (const name of FIRSTO_BATCH_DEPLOYMENTS) {
    const tx = item.deployments[name]; if (!tx) { ended = true; continue; }
    need(!ended, '候选部署必须按 FlexiblePurchase → PoolVault 顺序恢复。');
    transaction(tx, true); if (tx.status !== 'confirmed') ended = true;
  }
  for (const tx of [item.schedule, item.execute]) if (tx) {
    need(FIRSTO_BATCH_DEPLOYMENTS.every(name => item.deployments[name]?.status === 'confirmed'), '时间锁操作需要两个已确认部署。');
    transaction(tx, false);
  }
  if (item.execute) need(item.schedule?.status === 'confirmed', '执行升级必须先确认原排程。');
  need(item.failedTransactions === undefined || Array.isArray(item.failedTransactions) && item.failedTransactions.length <= 100,
    '失败回执归档格式无效。');
  for (const failed of item.failedTransactions ?? []) {
    need([...FIRSTO_BATCH_DEPLOYMENTS, 'schedule', 'execute'].includes(failed.step)
      && failed.transaction.status !== 'confirmed', '失败归档不能替代成功步骤。');
    transaction(failed.transaction, false); const evidence = failed.evidence;
    need(evidence?.kind === 'firsto-batch-finalized-failed-transaction-v1' && evidence.chainId === 56 && evidence.status === 0
      && evidence.value === '0' && hash(evidence.txHash) && hash(evidence.dataHash) && hash(evidence.blockHash)
      && evidence.txHash.toLowerCase() === failed.transaction.txHash?.toLowerCase()
      && evidence.dataHash.toLowerCase() === failed.transaction.dataHash.toLowerCase()
      && getAddress(evidence.from) === getAddress(failed.transaction.from)
      && (FIRSTO_BATCH_DEPLOYMENTS.includes(failed.step as FirstoBatchName) ? evidence.to === null : evidence.to !== null && getAddress(evidence.to) !== ZeroAddress)
      && Number.isSafeInteger(evidence.blockNumber) && evidence.blockNumber > 0 && /^[1-9]\d*$/.test(evidence.gasUsed)
      && Number.isFinite(Date.parse(evidence.checkedAt)), '失败归档缺少匹配的最终规范回执。');
  }
  need(item.abandonedUnknownDeployments === undefined || Array.isArray(item.abandonedUnknownDeployments)
    && item.abandonedUnknownDeployments.length <= 100, '已关闭旧钱包请求的归档格式无效。');
  let previousStep = -1;
  const previousUnknown = new Map<FirstoBatchName, UpgradeTransaction>();
  for (const abandoned of item.abandonedUnknownDeployments ?? []) {
    need(abandoned && typeof abandoned === 'object' && !Array.isArray(abandoned)
      && Object.keys(abandoned).length === 6
      && Object.keys(abandoned).every(key => ['step', 'transaction', 'reason', 'acknowledged', 'checkedAt', 'observedIntent'].includes(key))
      && FIRSTO_BATCH_DEPLOYMENTS.includes(abandoned.step), '只能归档本次两个候选合约的旧钱包请求。');
    const index = FIRSTO_BATCH_DEPLOYMENTS.indexOf(abandoned.step), original = abandoned.transaction;
    need(index >= previousStep && FIRSTO_BATCH_DEPLOYMENTS.slice(0, index)
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
    validateFirstoBatchIntent(abandoned.observedIntent);
    const prior = previousUnknown.get(abandoned.step), active = item.deployments[abandoned.step];
    for (const row of [prior, active]) if (row) need(getAddress(row.from) === getAddress(original.from)
      && row.dataHash.toLowerCase() === original.dataHash.toLowerCase(), '旧请求归档与同一步骤的发送者或 calldata 摘要不匹配。');
    previousUnknown.set(abandoned.step, original);
  }
  return JSON.parse(JSON.stringify(item)) as FirstoBatchJournal;
}

/** Full exports include a large, informational plan; only the validated journal is restored. */
export async function parseFirstoBatchImportFile(file: Pick<Blob, 'size' | 'text'>,
  context: FirstoBatchContext): Promise<FirstoBatchJournal> {
  const maxFileBytes = 512 * 1024, maxJournalBytes = 100000;
  need(Number.isSafeInteger(file.size) && file.size > 0 && file.size <= maxFileBytes,
    '恢复文件超过 512 KiB，或文件为空。');
  const contents = await file.text();
  need(new TextEncoder().encode(contents).byteLength <= maxFileBytes, '恢复文件超过 512 KiB。');
  const value: unknown = JSON.parse(contents);
  const candidate = value && typeof value === 'object' && 'journal' in value ? value.journal : value;
  const journal = parseFirstoBatchJournal(candidate, context);
  need(new TextEncoder().encode(JSON.stringify(journal)).byteLength <= maxJournalBytes,
    '升级记录超过 100,000 字节，不能保存。');
  return journal;
}

/** Acknowledges a closed legacy wallet request, without claiming its transaction was found or failed.
 * The caller must obtain currentIntent freshly and persist this result before allowing a later,
 * separate click to prepare a new send. observedIntent is evidence of that observation only. */
export function archiveLegacyFirstoBatchDeployment(source: FirstoBatchJournal, context: FirstoBatchContext, options: {
  step: FirstoBatchName | 'schedule' | 'execute'; acknowledged: true; checkedAt: string; currentIntent: FirstoBatchIntent;
}): FirstoBatchJournal {
  const current = parseFirstoBatchJournal(source, context);
  need(FIRSTO_BATCH_DEPLOYMENTS.includes(options.step as FirstoBatchName)
    && firstoBatchPending(current) === options.step, '只能归档当前待核验的候选合约部署，不能解除治理交易。');
  const step = options.step as FirstoBatchName, transaction = current.deployments[step]!;
  need(transaction.status === 'uncertain' && transaction.txHash === undefined
    && transaction.intent === undefined && transaction.address === undefined
    && Object.keys(transaction).length === 3,
  '已有交易哈希、发送意图或地址的请求必须恢复原交易，不能按旧钱包请求归档。');
  need(options.acknowledged === true, '请先明确确认已关闭或取消原钱包请求。');
  validateFirstoBatchIntent(options.currentIntent);
  const next: FirstoBatchJournal = { ...current, deployments: { ...current.deployments },
    abandonedUnknownDeployments: [...current.abandonedUnknownDeployments ?? [], {
      step, transaction, reason: 'user-canceled-wallet-request', acknowledged: true,
      checkedAt: options.checkedAt, observedIntent: options.currentIntent,
    }] };
  delete next.deployments[step];
  return parseFirstoBatchJournal(next, context);
}
export function firstoBatchPending(journal: FirstoBatchJournal) {
  return FIRSTO_BATCH_DEPLOYMENTS.find(name => journal.deployments[name] && journal.deployments[name]?.status !== 'confirmed')
    ?? (journal.schedule && journal.schedule.status !== 'confirmed' ? 'schedule'
      : journal.execute && journal.execute.status !== 'confirmed' ? 'execute' : null);
}
export function firstoBatchNext(journal: FirstoBatchJournal) {
  return firstoBatchPending(journal) ? null : FIRSTO_BATCH_DEPLOYMENTS.find(name => !journal.deployments[name]) ?? null;
}
export function confirmedFirstoBatchDeployments(journal: FirstoBatchJournal) {
  return Object.fromEntries(FIRSTO_BATCH_DEPLOYMENTS.filter(name => journal.deployments[name]?.status === 'confirmed')
    .map(name => [name, { address: journal.deployments[name]!.address!, txHash: journal.deployments[name]!.txHash! }]));
}
export function firstoBatchActionReady(options: {
  action: 'deploy' | 'schedule' | 'execute'; onBsc: boolean; signerAuthorized: boolean; pending: boolean;
  graphVerified: boolean; prefixVerified: boolean; completedDeployments: number;
  operation: 'unknown' | 'unscheduled' | 'waiting' | 'ready' | 'done'; scheduleConfirmed: boolean;
}) {
  if (!options.onBsc || !options.signerAuthorized || options.pending || !options.graphVerified || !options.prefixVerified) return false;
  if (options.action === 'deploy') return options.completedDeployments < 2 && options.operation !== 'done';
  if (options.completedDeployments !== 2) return false;
  return options.action === 'schedule' ? options.operation === 'unscheduled'
    : options.operation === 'ready' && options.scheduleConfirmed;
}

export type FirstoBatchStep = FirstoBatchName | 'schedule' | 'execute';
export type FirstoBatchOperation = 'unknown' | 'unscheduled' | 'waiting' | 'ready' | 'done';
export type FirstoBatchSequenceResult = { journal: FirstoBatchJournal; outcome: 'waiting' | 'unknown' | 'failed' | 'done'; readyAt?: number | null };

/** The last candidate opens governance; a prepared-only proof cannot classify its operation. */
export function firstoBatchRecoveryPhase(step: FirstoBatchStep) {
  return step === 'schedule' ? 'scheduled' as const : step === 'execute' ? 'done' as const
    : step === 'PoolVault' ? undefined : 'prepared' as const;
}

/** Advance only from verified, durable rows; an unknown wallet result is never resent. */
export async function runFirstoBatchUpgradeSequence(options: {
  journal: FirstoBatchJournal; assertCurrent: () => void;
  inspect: (source: FirstoBatchJournal) => Promise<{ operation: FirstoBatchOperation; readyAt?: number | null }>;
  submit: (source: FirstoBatchJournal, step: FirstoBatchStep) => Promise<FirstoBatchJournal>;
  recover: (source: FirstoBatchJournal, step: FirstoBatchStep) => Promise<{ journal: FirstoBatchJournal; outcome: 'confirmed' | 'waiting' | 'failed'; readyAt?: number | null }>;
}): Promise<FirstoBatchSequenceResult> {
  let source = options.journal;
  for (let advance = 0; advance < 16; advance++) {
    options.assertCurrent();
    const pending = firstoBatchPending(source);
    if (pending) {
      const original = pending === 'schedule' || pending === 'execute' ? source[pending]! : source.deployments[pending]!;
      if (!original.txHash) return { journal: source, outcome: 'unknown' };
      const recovered = await options.recover(source, pending); options.assertCurrent(); source = recovered.journal;
      if (recovered.outcome !== 'confirmed') return { journal: source, outcome: recovered.outcome };
      need(!firstoBatchPending(source), '原交易尚未确认，不能继续请求钱包。');
      // Even a suspended tab that wakes after 48h must require a new click to execute.
      if (pending === 'schedule') return { journal: source, outcome: 'waiting', readyAt: recovered.readyAt };
      if (pending === 'execute') return { journal: source, outcome: 'done', readyAt: recovered.readyAt };
      continue;
    }
    const state = await options.inspect(source); options.assertCurrent();
    if (state.operation === 'done' || state.operation === 'waiting')
      return { journal: source, outcome: state.operation, readyAt: state.readyAt };
    const next = firstoBatchNext(source);
    const step: FirstoBatchStep | null = next ?? (state.operation === 'unscheduled' ? 'schedule'
      : state.operation === 'ready' && source.schedule?.status === 'confirmed' ? 'execute' : null);
    need(step, '当前升级状态尚未核对完成，请稍后继续。');
    if (!next) need(!source[step as 'schedule' | 'execute'], '本机已有原交易，不能重复排程或执行。');
    source = await options.submit(source, step); options.assertCurrent();
    need(firstoBatchPending(source) === step, '钱包提交结果未写入对应升级步骤。');
  }
  throw new Error('升级步骤未按已验证记录推进，请检查原交易。');
}

/** A user-triggered bounded wait reads only the original receipt and finality head. */
export async function waitForFirstoBatchFinality(provider: Provider, originalHash: string, options: {
  assertCurrent: () => void; wait?: () => Promise<void>; attempts?: number;
}): Promise<boolean> {
  need(hash(originalHash), '原交易哈希格式无效。');
  const attempts = options.attempts ?? 15;
  need(Number.isInteger(attempts) && attempts > 0 && attempts <= 30, '原交易等待次数无效。');
  for (let attempt = 0; attempt < attempts; attempt++) {
    options.assertCurrent();
    const receipt = await provider.getTransactionReceipt(originalHash); options.assertCurrent();
    if (receipt) {
      need(receipt.hash.toLowerCase() === originalHash.toLowerCase() && Number.isSafeInteger(receipt.blockNumber)
        && receipt.blockNumber > 0, '返回的原交易回执不匹配。');
      const finalized = await provider.getBlock('finalized'); options.assertCurrent();
      need(finalized?.hash && Number.isSafeInteger(finalized.number), '无法读取最终确认区块。');
      if (receipt.blockNumber <= finalized.number) return true;
    }
    if (attempt + 1 < attempts) {
      await (options.wait ? options.wait() : new Promise<void>(resolve => setTimeout(resolve, 3000)));
      options.assertCurrent();
    }
  }
  return false;
}

/** The durable journal write must succeed before the first wallet request. */
export async function submitFirstoBatchUpgrade(wallet: WalletProvider, transaction: { from: string; to?: string; data: string; gasLimit?: string; intent?: FirstoBatchIntent },
  journal: { beforeRequest: () => void; submitted: (hash: string) => void; definitelyRejected: () => void }) {
  if (transaction.intent !== undefined) validateFirstoBatchIntent(transaction.intent);
  if (transaction.gasLimit !== undefined) need(/^[1-9]\d*$/.test(transaction.gasLimit)
    && BigInt(transaction.gasLimit) <= 9000000n, '部署 Gas 上限必须来自已审查的候选计划。');
  const sender: WalletProvider = transaction.gasLimit ? { request: args => {
    if (args.method !== 'eth_sendTransaction') return wallet.request(args);
    need(Array.isArray(args.params) && args.params.length === 1, '钱包交易格式无效。');
    return wallet.request({ ...args, params: [{ ...args.params[0], gas: `0x${BigInt(transaction.gasLimit!).toString(16)}` }] });
  } } : wallet;
  journal.beforeRequest();
  let hash: string;
  try { hash = await sendUpgradeTransaction(sender, { ...transaction,
    ...(transaction.intent ? { nonce: transaction.intent.nonce } : {}) }); }
  catch (problem) { if (!(problem instanceof UncertainUpgradeSubmission)) journal.definitelyRejected(); throw problem; }
  // A storage failure after submission must keep the earlier uncertain row; never roll back and retry.
  journal.submitted(hash); return hash;
}

/** Gas evidence addresses are local test data and are never turned into deployment claims. */
export function firstoBatchReviewedGas(evidence: any, pins: Record<string, string>, digest: string) {
  need(hash(digest) && evidenceDigest(evidence).toLowerCase() === digest.toLowerCase(), '候选 Gas 测量摘要不匹配。');
  need(evidence?.kind === 'firsto-batch-offline-create-gas-review-v1' && evidence.schemaVersion === 1
    && evidence.environment?.disposableLoopbackEvm === true && evidence.environment?.forked === false
    && evidence.environment?.productionTransactions === false && evidence.environment?.chainId === 56
    && evidence.environment?.ethEstimateGasCalls === 0 && evidence.fixedCeilingsTested === true,
  '需要本机一次性 EVM 的候选 CREATE 测量证据。');
  for (const key of ['trustedGenesisRecordDigest', 'trustedGenesisManifestDigest',
    'trustedUpgradeArtifactDigest', 'trustedReviewCatalogDigest', 'trustedPriorCoreCatalogDigest', 'trustedProtocolReviewDigest']) need(hash(pins[key])
    && evidence.pins?.[key]?.toLowerCase() === pins[key].toLowerCase(), 'Gas 测量与正式图或候选摘要不同。');
  need(evidence.margin?.percent === 20 && evidence.margin?.absoluteGas === 50000 && evidence.margin?.roundUpGas === 10000,
    '候选 Gas 余量策略不匹配。');
  need(Array.isArray(evidence.deployments) && evidence.deployments.length === 2, '候选 Gas 测量需要且仅需两个 CREATE。');
  const limits: Partial<Record<FirstoBatchName, string>> = {};
  for (const [index, name] of FIRSTO_BATCH_DEPLOYMENTS.entries()) {
    const row = evidence.deployments[index];
    need(row?.name === name && /^[1-9]\d*$/.test(row.gasUsed) && /^[1-9]\d*$/.test(row.gasLimit), 'Gas 测量顺序或数值无效。');
    const used = BigInt(row.gasUsed), expected = ((used * 120n + 99n) / 100n + 50000n + 9999n) / 10000n * 10000n;
    need(used > 0n && expected <= 9000000n && BigInt(row.gasLimit) === expected, '候选 Gas 上限或有界余量不匹配。');
    limits[name] = row.gasLimit;
  }
  return Object.freeze(limits as Record<FirstoBatchName, string>);
}

export class VerifiedFirstoBatchTransactionFailure extends Error {
  constructor(public readonly evidence: FailedFirstoBatchReceipt) { super('原交易已在规范链上最终失败，可归档后重试同一步。'); }
}

/** Both successful and failed recovery must prove the exact original transaction before changing the journal. */
export async function verifyFirstoBatchRecoveryReceipt(provider: Provider, hashValue: string,
  expected: FirstoBatchRecoveryIdentity): Promise<TransactionReceipt | null> {
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
  if (expected.operation) await verifyFirstoBatchOperationReceipt(provider, { tx, receipt, expected, finalized });
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
  if (receipt.status === 0) throw new VerifiedFirstoBatchTransactionFailure({ kind: 'firsto-batch-finalized-failed-transaction-v1',
    chainId: 56, status: 0, txHash: hashValue, from: tx.from, to: tx.to, value: '0', dataHash: expected.dataHash,
    blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, gasUsed: receipt.gasUsed.toString(), checkedAt: new Date().toISOString() });
  need(!!expected.to || receipt.contractAddress, '成功 CREATE 缺少合约地址。');
  if (!expected.to && expected.intent) need(getAddress(receipt.contractAddress!) === getCreateAddress({ from: expected.from, nonce: expected.intent.nonce }),
    'CREATE 地址与原发送者和 nonce 不一致。');
  return receipt;
}

export function archiveFirstoBatchFailure(source: FirstoBatchJournal, step: FirstoBatchName | 'schedule' | 'execute',
  evidence: FailedFirstoBatchReceipt, context: FirstoBatchContext) {
  need(firstoBatchPending(source) === step, '只能恢复当前待核验原交易。');
  const transaction = step === 'schedule' || step === 'execute' ? source[step]! : source.deployments[step]!;
  need(transaction.txHash, '本次发送结果仍未知，输入的失败回执不能证明原交易，不能解除重试限制。');
  need(transaction.txHash.toLowerCase() === evidence.txHash.toLowerCase(), '失败回执属于另一笔交易。');
  const next = { ...source, deployments: { ...source.deployments }, failedTransactions: [...source.failedTransactions ?? [], {
    step, transaction: { ...transaction, txHash: evidence.txHash }, evidence,
  }] };
  if (step === 'schedule' || step === 'execute') delete next[step]; else delete next.deployments[step];
  return parseFirstoBatchJournal(next, context);
}
