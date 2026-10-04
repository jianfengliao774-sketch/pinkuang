import { getAddress, keccak256, ZeroAddress, type Provider, type TransactionReceipt } from 'ethers';
import type { WalletProvider } from './wallet';
import { sendUpgradeTransaction, UncertainUpgradeSubmission } from './upgrade-transactions';
// @ts-ignore Shared canonical digest has no TypeScript declarations.
import { evidenceDigest } from '../shared/firsto-upgrade-proof.mjs';
export type UpgradeTransaction = { status: 'submitted' | 'confirmed' | 'uncertain'; from: string;
  dataHash: string; txHash?: string; address?: string };

export const TARGET_OWNER_DEPLOYMENTS = ['PoolFunds', 'FlexiblePurchase', 'PoolVault'] as const;
export type TargetOwnerName = typeof TARGET_OWNER_DEPLOYMENTS[number];
export type TargetOwnerContext = { factory: string; genesisRecordDigest: string; genesisManifestDigest: string; candidateArtifactDigest: string; catalogDigest: string };
export type TargetOwnerJournal = TargetOwnerContext & {
  schemaVersion: 1; kind: 'target-owner-upgrade-journal-v1'; salt: string; delaySeconds: number;
  deployments: Partial<Record<TargetOwnerName, UpgradeTransaction>>;
  schedule?: UpgradeTransaction; execute?: UpgradeTransaction;
  failedTransactions?: { step: TargetOwnerName | 'schedule' | 'execute'; transaction: UpgradeTransaction; evidence: FailedTargetOwnerReceipt }[];
};
export type FailedTargetOwnerReceipt = { kind: 'target-owner-finalized-failed-transaction-v1'; chainId: 56; status: 0;
  txHash: string; from: string; to: string | null; value: '0'; dataHash: string; blockNumber: number; blockHash: string;
  gasUsed: string; checkedAt: string };
const hash = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
const need: (ok: unknown, reason: string) => asserts ok = (ok, reason) => { if (!ok) throw new Error(reason); };
const contextKeys = ['genesisRecordDigest', 'genesisManifestDigest', 'candidateArtifactDigest', 'catalogDigest'] as const;
export function targetOwnerJournalKey(context: TargetOwnerContext) {
  need(contextKeys.every(key => hash(context[key])), '升级摘要格式无效。');
  need(getAddress(context.factory) !== ZeroAddress, '正式 Factory 地址无效。');
  return `bemine.target-owner-upgrade.v1.${getAddress(context.factory).toLowerCase()}.`
    + contextKeys.map(key => context[key].toLowerCase()).join('.');
}
export function newTargetOwnerJournal(context: TargetOwnerContext, salt: string): TargetOwnerJournal {
  targetOwnerJournalKey(context); need(hash(salt) && BigInt(salt) !== 0n, '本次升级 salt 必须为非零 32 字节。');
  return { ...context, schemaVersion: 1, kind: 'target-owner-upgrade-journal-v1', salt, delaySeconds: 172800, deployments: {} };
}
export function parseTargetOwnerJournal(value: unknown, context: TargetOwnerContext): TargetOwnerJournal {
  const item = value as TargetOwnerJournal;
  need(item && item.schemaVersion === 1 && item.kind === 'target-owner-upgrade-journal-v1'
    && targetOwnerJournalKey(item) === targetOwnerJournalKey(context), '升级记录与本页固定的正式图或候选产物不匹配。');
  need(Object.keys(item).every(key => ['factory', ...contextKeys, 'schemaVersion', 'kind', 'salt', 'delaySeconds',
    'deployments', 'schedule', 'execute', 'failedTransactions'].includes(key)), '记录包含本次升级以外的操作。');
  need(hash(item.salt) && BigInt(item.salt) !== 0n && Number.isSafeInteger(item.delaySeconds) && item.delaySeconds >= 172800,
    '恢复记录需要非零 salt 和至少 48 小时。');
  need(item.deployments && typeof item.deployments === 'object' && !Array.isArray(item.deployments)
    && Object.keys(item.deployments).every(name => TARGET_OWNER_DEPLOYMENTS.includes(name as TargetOwnerName)), '只能恢复三个候选合约。');
  const addresses = new Set<string>(), transactions = new Set<string>(); let ended = false;
  function transaction(tx: UpgradeTransaction, deployment: boolean) {
    need(tx && ['submitted', 'confirmed', 'uncertain'].includes(tx.status) && hash(tx.dataHash)
      && (tx.txHash === undefined || hash(tx.txHash)) && getAddress(tx.from) !== ZeroAddress, '升级交易字段无效。');
    need(tx.status === 'uncertain' || hash(tx.txHash), '已提交或确认交易缺少原交易哈希。');
    if (tx.txHash) { need(!transactions.has(tx.txHash.toLowerCase()), '原交易哈希重复。'); transactions.add(tx.txHash.toLowerCase()); }
    if (deployment && tx.status === 'confirmed') {
      need(tx.address && getAddress(tx.address) !== ZeroAddress, '已确认部署缺少合约地址。');
      need(!addresses.has(tx.address.toLowerCase()), '候选部署地址重复。'); addresses.add(tx.address.toLowerCase());
    } else need(tx.address === undefined, '未确认部署或时间锁不能记录已验证的合约地址。');
  }
  for (const name of TARGET_OWNER_DEPLOYMENTS) {
    const tx = item.deployments[name]; if (!tx) { ended = true; continue; }
    need(!ended, '候选部署必须按 PoolFunds → FlexiblePurchase → PoolVault 顺序恢复。');
    transaction(tx, true); if (tx.status !== 'confirmed') ended = true;
  }
  for (const tx of [item.schedule, item.execute]) if (tx) {
    need(TARGET_OWNER_DEPLOYMENTS.every(name => item.deployments[name]?.status === 'confirmed'), '时间锁操作需要三个已确认部署。');
    transaction(tx, false);
  }
  if (item.execute) need(item.schedule?.status === 'confirmed', '执行升级必须先确认原排程。');
  need(item.failedTransactions === undefined || Array.isArray(item.failedTransactions) && item.failedTransactions.length <= 100,
    '失败回执归档格式无效。');
  for (const failed of item.failedTransactions ?? []) {
    need([...TARGET_OWNER_DEPLOYMENTS, 'schedule', 'execute'].includes(failed.step)
      && failed.transaction.status !== 'confirmed', '失败归档不能替代成功步骤。');
    transaction(failed.transaction, false); const evidence = failed.evidence;
    need(evidence?.kind === 'target-owner-finalized-failed-transaction-v1' && evidence.chainId === 56 && evidence.status === 0
      && evidence.value === '0' && hash(evidence.txHash) && hash(evidence.dataHash) && hash(evidence.blockHash)
      && evidence.txHash.toLowerCase() === failed.transaction.txHash?.toLowerCase()
      && evidence.dataHash.toLowerCase() === failed.transaction.dataHash.toLowerCase()
      && getAddress(evidence.from) === getAddress(failed.transaction.from)
      && (TARGET_OWNER_DEPLOYMENTS.includes(failed.step as TargetOwnerName) ? evidence.to === null : evidence.to !== null && getAddress(evidence.to) !== ZeroAddress)
      && Number.isSafeInteger(evidence.blockNumber) && evidence.blockNumber > 0 && /^[1-9]\d*$/.test(evidence.gasUsed)
      && Number.isFinite(Date.parse(evidence.checkedAt)), '失败归档缺少匹配的最终规范回执。');
  }
  return JSON.parse(JSON.stringify(item)) as TargetOwnerJournal;
}
export function targetOwnerPending(journal: TargetOwnerJournal) {
  return TARGET_OWNER_DEPLOYMENTS.find(name => journal.deployments[name] && journal.deployments[name]?.status !== 'confirmed')
    ?? (journal.schedule && journal.schedule.status !== 'confirmed' ? 'schedule'
      : journal.execute && journal.execute.status !== 'confirmed' ? 'execute' : null);
}
export function targetOwnerNext(journal: TargetOwnerJournal) {
  return targetOwnerPending(journal) ? null : TARGET_OWNER_DEPLOYMENTS.find(name => !journal.deployments[name]) ?? null;
}
export function confirmedTargetOwnerDeployments(journal: TargetOwnerJournal) {
  return Object.fromEntries(TARGET_OWNER_DEPLOYMENTS.filter(name => journal.deployments[name]?.status === 'confirmed')
    .map(name => [name, { address: journal.deployments[name]!.address!, txHash: journal.deployments[name]!.txHash! }]));
}
export function targetOwnerActionReady(options: {
  action: 'deploy' | 'schedule' | 'execute'; onBsc: boolean; signerAuthorized: boolean; pending: boolean;
  graphVerified: boolean; prefixVerified: boolean; completedDeployments: number;
  operation: 'unknown' | 'unscheduled' | 'waiting' | 'ready' | 'done'; scheduleConfirmed: boolean;
}) {
  if (!options.onBsc || !options.signerAuthorized || options.pending || !options.graphVerified || !options.prefixVerified) return false;
  if (options.action === 'deploy') return options.completedDeployments < 3 && options.operation !== 'done';
  if (options.completedDeployments !== 3) return false;
  return options.action === 'schedule' ? options.operation === 'unscheduled'
    : options.operation === 'ready' && options.scheduleConfirmed;
}

/** The durable journal write must succeed before the first wallet request. */
export async function submitTargetOwnerUpgrade(wallet: WalletProvider, transaction: { from: string; to?: string; data: string; gasLimit?: string },
  journal: { beforeRequest: () => void; submitted: (hash: string) => void; definitelyRejected: () => void }) {
  if (transaction.gasLimit !== undefined) need(/^[1-9]\d*$/.test(transaction.gasLimit)
    && BigInt(transaction.gasLimit) <= 9000000n, '部署 Gas 上限必须来自已审查的候选计划。');
  const sender: WalletProvider = transaction.gasLimit ? { request: args => {
    if (args.method !== 'eth_sendTransaction') return wallet.request(args);
    need(Array.isArray(args.params) && args.params.length === 1, '钱包交易格式无效。');
    return wallet.request({ ...args, params: [{ ...args.params[0], gas: `0x${BigInt(transaction.gasLimit!).toString(16)}` }] });
  } } : wallet;
  journal.beforeRequest();
  let hash: string;
  try { hash = await sendUpgradeTransaction(sender, transaction); }
  catch (problem) { if (!(problem instanceof UncertainUpgradeSubmission)) journal.definitelyRejected(); throw problem; }
  // A storage failure after submission must keep the earlier uncertain row; never roll back and retry.
  journal.submitted(hash); return hash;
}

/** Gas evidence addresses are local test data and are never turned into deployment claims. */
export function targetOwnerReviewedGas(evidence: any, pins: Record<string, string>, digest: string) {
  need(hash(digest) && evidenceDigest(evidence).toLowerCase() === digest.toLowerCase(), '候选 Gas 测量摘要不匹配。');
  need(evidence?.kind === 'target-owner-offline-create-gas-review-v1' && evidence.schemaVersion === 1
    && evidence.environment?.disposableLoopbackEvm === true && evidence.environment?.forked === false
    && evidence.environment?.productionTransactions === false && evidence.environment?.chainId === 56
    && evidence.environment?.ethEstimateGasCalls === 0 && evidence.fixedCeilingsTested === true,
  '需要本机一次性 EVM 的候选 CREATE 测量证据。');
  for (const key of ['trustedGenesisRecordDigest', 'trustedGenesisManifestDigest', 'trustedGenesisArtifactDigest',
    'trustedUpgradeArtifactDigest', 'trustedReviewCatalogDigest']) need(hash(pins[key])
    && evidence.pins?.[key]?.toLowerCase() === pins[key].toLowerCase(), 'Gas 测量与正式图或候选摘要不同。');
  need(evidence.margin?.percent === 20 && evidence.margin?.absoluteGas === 50000 && evidence.margin?.roundUpGas === 10000,
    '候选 Gas 余量策略不匹配。');
  need(Array.isArray(evidence.deployments) && evidence.deployments.length === 3, '候选 Gas 测量需要且仅需三个 CREATE。');
  const limits: Partial<Record<TargetOwnerName, string>> = {};
  for (const [index, name] of TARGET_OWNER_DEPLOYMENTS.entries()) {
    const row = evidence.deployments[index];
    need(row?.name === name && /^[1-9]\d*$/.test(row.gasUsed) && /^[1-9]\d*$/.test(row.gasLimit), 'Gas 测量顺序或数值无效。');
    const used = BigInt(row.gasUsed), expected = ((used * 120n + 99n) / 100n + 50000n + 9999n) / 10000n * 10000n;
    need(used > 0n && expected <= 9000000n && BigInt(row.gasLimit) === expected, '候选 Gas 上限或有界余量不匹配。');
    limits[name] = row.gasLimit;
  }
  return Object.freeze(limits as Record<TargetOwnerName, string>);
}

export class VerifiedTargetOwnerTransactionFailure extends Error {
  constructor(public readonly evidence: FailedTargetOwnerReceipt) { super('原交易已在规范链上最终失败，可归档后重试同一步。'); }
}

/** Both successful and failed recovery must prove the exact original transaction before changing the journal. */
export async function verifyTargetOwnerRecoveryReceipt(provider: Provider, hashValue: string,
  expected: { from: string; to?: string; dataHash: string }): Promise<TransactionReceipt | null> {
  need(hash(hashValue) && hash(expected.dataHash), '原交易哈希或 calldata 摘要无效。');
  const read = provider as Provider & { send(method: string, params: unknown[]): Promise<any> };
  const [chain, finalized, tx, receipt] = await Promise.all([read.send('eth_chainId', []), provider.getBlock('finalized'),
    provider.getTransaction(hashValue), provider.getTransactionReceipt(hashValue)]);
  need(BigInt(chain) === 56n && finalized?.hash, '恢复需要 BSC 主网最终确认区块。');
  if (!tx || !receipt || receipt.blockNumber > finalized.number) return null;
  const matchingAddress = (left: string | null, right: string | undefined) => right ? !!left && getAddress(left) === getAddress(right) : left === null;
  need(tx.hash.toLowerCase() === hashValue.toLowerCase() && receipt.hash.toLowerCase() === hashValue.toLowerCase()
    && tx.chainId === 56n && getAddress(tx.from) === getAddress(expected.from) && getAddress(receipt.from) === getAddress(expected.from)
    && matchingAddress(tx.to, expected.to) && matchingAddress(receipt.to, expected.to) && tx.value === 0n
    && keccak256(tx.data).toLowerCase() === expected.dataHash.toLowerCase()
    && tx.blockNumber === receipt.blockNumber && tx.blockHash?.toLowerCase() === receipt.blockHash.toLowerCase()
    && (receipt.status === 0 || receipt.status === 1), '原交易发送者、目标、金额、calldata 或回执不匹配。');
  const block = await provider.getBlock(receipt.blockNumber);
  need(block?.hash?.toLowerCase() === receipt.blockHash.toLowerCase() && block.number === receipt.blockNumber
    && Number.isSafeInteger(receipt.index) && receipt.index >= 0
    && block.transactions[receipt.index]?.toLowerCase() === hashValue.toLowerCase(), '原回执不属于最终规范链交易。');
  const [againChain, againFinality, againBlock, againReceipt] = await Promise.all([read.send('eth_chainId', []),
    provider.getBlock(finalized.number), provider.getBlock(receipt.blockNumber), provider.getTransactionReceipt(hashValue)]);
  need(BigInt(againChain) === 56n && againFinality?.hash?.toLowerCase() === finalized.hash.toLowerCase()
    && againBlock?.hash?.toLowerCase() === block.hash.toLowerCase() && againReceipt?.status === receipt.status
    && againReceipt.hash.toLowerCase() === receipt.hash.toLowerCase() && againReceipt.blockHash.toLowerCase() === receipt.blockHash.toLowerCase()
    && againReceipt.blockNumber === receipt.blockNumber && againReceipt.index === receipt.index,
  '恢复期间规范链或原交易回执发生变化。');
  if (receipt.status === 0) throw new VerifiedTargetOwnerTransactionFailure({ kind: 'target-owner-finalized-failed-transaction-v1',
    chainId: 56, status: 0, txHash: hashValue, from: tx.from, to: tx.to, value: '0', dataHash: expected.dataHash,
    blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, gasUsed: receipt.gasUsed.toString(), checkedAt: new Date().toISOString() });
  need(!!expected.to || receipt.contractAddress, '成功 CREATE 缺少合约地址。'); return receipt;
}

export function archiveTargetOwnerFailure(source: TargetOwnerJournal, step: TargetOwnerName | 'schedule' | 'execute',
  evidence: FailedTargetOwnerReceipt, context: TargetOwnerContext) {
  need(targetOwnerPending(source) === step, '只能恢复当前待核验原交易。');
  const transaction = step === 'schedule' || step === 'execute' ? source[step]! : source.deployments[step]!;
  need(transaction.txHash === undefined || transaction.txHash.toLowerCase() === evidence.txHash.toLowerCase(), '失败回执属于另一笔交易。');
  const next = { ...source, deployments: { ...source.deployments }, failedTransactions: [...source.failedTransactions ?? [], {
    step, transaction: { ...transaction, txHash: evidence.txHash }, evidence,
  }] };
  if (step === 'schedule' || step === 'execute') delete next[step]; else delete next.deployments[step];
  return parseTargetOwnerJournal(next, context);
}
