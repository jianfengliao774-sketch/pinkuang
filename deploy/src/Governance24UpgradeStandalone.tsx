import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Contract, FetchRequest, JsonRpcProvider, getAddress, keccak256, makeError,
  type JsonRpcPayload, type JsonRpcResult } from 'ethers';
// The reviewed helpers are deliberately shared with the read-only product graph verifier.
// @ts-ignore ESM helper has runtime validation; this standalone entry supplies pinned JSON only.
import { buildGovernance24UpgradePlan, prepareGovernance24UpgradeDeployment, validateGovernance24UpgradeReview, governance24Cancellations } from '../shared/governance24-upgrade-plan.mjs';
// @ts-ignore ESM proof module is reviewed and tested independently of this wallet UI.
import { validateGovernance24UpgradePreflight, governance24VerifiedUpgrade } from '../shared/governance24-upgrade-proof.mjs';
import { discoverWallets, messageOf, readWallet, switchToBsc, type WalletOption, type WalletState } from './wallet';
import { normalizeWalletRecoveryResult } from './upgrade-transactions';
import { GOVERNANCE24_DEPLOYMENTS, confirmedGovernance24Deployments, newGovernance24Journal, parseGovernance24Journal,
  parseGovernance24ImportFile,
  governance24JournalKey, governance24Pending, runGovernance24UpgradeSequence, waitForGovernance24Finality, governance24RecoveryPhase, submitGovernance24Upgrade, governance24ReviewedGas,
  verifyGovernance24RecoveryReceipt, VerifiedGovernance24TransactionFailure, archiveGovernance24Failure,
  prepareGovernance24Intent, assertGovernance24IntentCurrent, discoverGovernance24Transaction, archiveLegacyGovernance24Deployment,
  isGovernance24Cancellation, governance24Transaction, withGovernance24Transaction, confirmedGovernance24Cancellations,
  type Governance24Journal, type Governance24Name, type Governance24Step, type Governance24Operation, type UpgradeTransaction } from './governance24-upgrade-ui';
import './target-owner-upgrade.css';

type Json = Record<string, any>;
type Release = { kind: string; sourceCommit: string; sourceDiffDigest: string; candidateSourceCommit: string;
  pins: Record<string, string>; files: Record<string, { path: string; sha256: string }>; rpcPath: string; gasEvidenceDigest: string;
  liveReviewEvidenceDigest: string; liveReviewAnchor: { blockNumber: number; blockHash: string; checkedAt: string } };
declare const __GOVERNANCE24_RELEASE__: Release;
type Operation = Governance24Operation;
type Session = { provider: JsonRpcProvider; assertCurrent: () => void; bindWallet: (option: WalletOption) => void;
  read: <T>(action: () => Promise<T>, timeout?: number) => Promise<T>;
  lock: (action: (source: Governance24Journal | null) => Promise<void>) => Promise<void>;
  persist: (item: Governance24Journal) => Governance24Journal; wait: () => Promise<void>; };
type Preflight = { blockNumber: number; blockHash: string; [name: string]: any };
const release = __GOVERNANCE24_RELEASE__;
const GOVERNANCE24_DEPLOYER = '0x042B23288E2316DFb6503488292FD0Ad2F811Ae7';
const GOVERNANCE24_PREFLIGHT_TIMEOUT_MS = 10 * 60 * 1000;
const explorer = 'https://bscscan.com';
const formatOldEta = (value: string) => { const seconds = BigInt(value);
  return seconds <= 8640000000000n ? new Date(Number(seconds) * 1000).toLocaleString('zh-CN') : '超出本机日期显示范围，原秒数已保留'; };
const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;
const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const json = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);
const canonical = (value: any): string => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([json(value)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function newSalt() { const bytes = crypto.getRandomValues(new Uint8Array(32)); if (bytes.every(value => value === 0)) bytes[31] = 1;
  return `0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`; }
/** One exact retry for temporary public HTTP failures; never wraps a wallet or caches a proof read. */
export function createGovernance24ReadProvider(url: string, signal?: AbortSignal, timeoutMs = 15000): JsonRpcProvider {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 15000) throw new Error('Invalid read deadline.');
  const methods = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getStorageAt',
    'eth_call', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getLogs']);
  class ReadProvider extends JsonRpcProvider {
    private readonly active = new Set<() => void>();
    private stopped = false;
    async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
      if (Array.isArray(payload) || !methods.has(payload.method)) throw makeError('Public provider only reads.', 'UNSUPPORTED_OPERATION');
      const alive = () => { if (this.stopped || this.destroyed || signal?.aborted) throw makeError('Read stopped.', 'CANCELLED'); };
      alive(); const body = JSON.stringify(payload), expires = Date.now() + timeoutMs;
      let request: FetchRequest | null = null, timer: ReturnType<typeof setTimeout> | undefined;
      let rejectWait: ((error: Error) => void) | undefined, waitTimer: ReturnType<typeof setTimeout> | undefined;
      let rejectStopped: (error: Error) => void = () => {};
      const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
      const cancel = (error = makeError('Read stopped.', 'CANCELLED')) => {
        try { request?.cancel(); } catch { /* An unsent or completed HTTP request has no pending work. */ }
        if (waitTimer) clearTimeout(waitTimer); rejectWait?.(error); rejectStopped(error);
      };
      const cancelActive = () => cancel(); this.active.add(cancelActive);
      timer = setTimeout(() => cancel(makeError('Read deadline exceeded.', 'TIMEOUT', { operation: payload.method, reason: 'timeout' })), timeoutMs);
      const perform = async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          alive(); const remaining = expires - Date.now();
          if (remaining <= 0) throw makeError('Read deadline exceeded.', 'TIMEOUT', { operation: payload.method, reason: 'timeout' });
          request = new FetchRequest(url); request.timeout = remaining; request.body = body;
          request.setHeader('content-type', 'application/json');
          request.setThrottleParams({ maxAttempts: 1 }); request.retryFunc = async () => false;
          const response = await request.send(); alive();
          if (attempt === 0 && [429, 502, 503].includes(response.statusCode)) {
            // An RPC response is already a result, even if a gateway labels it
            // with a temporary HTTP status. Retry only a transport failure.
            const shaped = (value: any): boolean => value && typeof value === 'object'
              && (['jsonrpc', 'id', 'result'].some(key => Object.hasOwn(value, key))
                || value.error && typeof value.error === 'object' && Object.hasOwn(value.error, 'code'));
            let rpcResponse: boolean;
            try { const value = response.bodyJson; rpcResponse = Array.isArray(value) ? value.some(shaped) : !!shaped(value); }
            catch { try { rpcResponse = /^\s*[\[{]/.test(response.bodyText); }
              catch { rpcResponse = true; } }
            if (rpcResponse) response.assertOk();
            // All attempts share one deadline, including this short backoff.
            await new Promise<void>((resolve, reject) => { rejectWait = reject;
              waitTimer = setTimeout(resolve, 100); });
            rejectWait = undefined; waitTimer = undefined; continue;
          }
          response.assertOk(); const result = response.bodyJson;
          return Array.isArray(result) ? result : [result];
        }
        throw new Error('Read retry limit exceeded.');
      };
      try { return await Promise.race([perform(), stopped]); }
      finally { if (timer) clearTimeout(timer); if (waitTimer) clearTimeout(waitTimer); this.active.delete(cancelActive); }
    }
    destroy() {
      if (this.stopped) return; this.stopped = true;
      signal?.removeEventListener('abort', abortRead);
      for (const cancel of this.active) cancel(); this.active.clear(); super.destroy();
    }
  }
  const provider = new ReadProvider(url, 56, { batchMaxCount: 1, cacheTimeout: -1, staticNetwork: true });
  const abortRead = () => provider.destroy();
  if (signal?.aborted) provider.destroy(); else signal?.addEventListener('abort', abortRead, { once: true });
  return provider;
}
function rpc(signal: AbortSignal) { return createGovernance24ReadProvider(new URL(release.rpcPath, window.location.href).href, signal); }
async function pinnedJson(name: string, signal: AbortSignal): Promise<Json> {
  const file = release.files[name]; if (!file) throw new Error(`发布包缺少已审查文件 ${name}。`);
  const response = await fetch(new URL(file.path, window.location.href), { signal, cache: 'no-store', redirect: 'error', credentials: 'same-origin' });
  if (!response.ok || !/\bapplication\/json\b/i.test(response.headers.get('content-type') || '')) throw new Error(`无法加载已审查文件 ${name}。`);
  const bytes = await response.arrayBuffer(); if (!bytes.byteLength || bytes.byteLength > 12_000_000 || !crypto.subtle) throw new Error('文件大小或安全上下文不允许核验。');
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== file.sha256) throw new Error(`文件 ${name} 与固定发布摘要不同。`);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
// The public proxy intentionally excludes historical nonce/full-block reads. Obtain only
// those two read methods from the selected wallet; all headers and receipt proofs stay public.
function recoveryProvider(session: Session, selected: WalletOption): JsonRpcProvider {
  return new Proxy(session.provider, { get(target, property) {
    if (property === 'send') return async (method: string, params: unknown[]) => {
      if (!['eth_getTransactionCount', 'eth_getBlockByNumber'].includes(method)
        || method === 'eth_getBlockByNumber' && params[1] !== true) return target.send(method, params);
      session.assertCurrent();
      const chain = await selected.provider.request({ method: 'eth_chainId' });
      if (BigInt(chain as string) !== 56n) throw new Error('钱包只读节点已离开 BSC 主网。');
      session.assertCurrent(); const value = await selected.provider.request({ method, params });
      session.assertCurrent(); return normalizeWalletRecoveryResult(method, value);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

export function Governance24UpgradeStandalone() {
  const [common, setCommon] = useState<Json | null>(null), [loadError, setLoadError] = useState('');
  const [gasLimits, setGasLimits] = useState<Record<Governance24Name, string> | null>(null);
  const [wallets, setWallets] = useState<WalletOption[]>([]), [wallet, setWallet] = useState<WalletOption | null>(null);
  const [walletState, setWalletState] = useState<WalletState | null>(null), [journal, setJournal] = useState<Governance24Journal | null>(null);
  const [proof, setProof] = useState<Preflight | null>(null), [result, setResult] = useState<Preflight | null>(null);
  const [operation, setOperation] = useState<Operation>('unknown'), [readyAt, setReadyAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [recoveryHash, setRecoveryHash] = useState('');
  const [unwrittenHash, setUnwrittenHash] = useState('');
  const [closedOldRequest, setClosedOldRequest] = useState(false);
  const busyRef = useRef(false), epoch = useRef(0), abort = useRef<AbortController | null>(null);
  const walletRef = useRef<WalletOption | null>(null), mounted = useRef(true);
  const returnedHash = useRef<{ key: string; raw: string; step: Governance24Step; hash: string } | null>(null);
  const cancellationPlan = useMemo(() => common ? governance24Cancellations(common) as Json[] : [], [common]);
  const context = useMemo(() => common ? { cancellationIds: cancellationPlan.map(item => item.id as `cancel-${string}`), factory: common.predecessorInput.genesisRecord.addresses.factory,
    genesisRecordDigest: common.predecessorInput.trustedGenesisRecordDigest,
    genesisManifestDigest: common.predecessorInput.trustedGenesisManifestDigest,
    candidateArtifactDigest: release.pins.trustedUpgradeArtifactDigest, catalogDigest: release.pins.trustedReviewCatalogDigest,
    predecessorInputDigest: release.pins.trustedPredecessorInputDigest } : null, [common, cancellationPlan]);
  const key = context ? governance24JournalKey(context) : null;
  const account = walletState?.address;
  const reviewedCatalog = common?.reviewCatalog;
  const deployer = reviewedCatalog?.deployer as string | undefined, proposer = reviewedCatalog?.bindings?.proposer as string | undefined;
  const pending = journal ? governance24Pending(journal) : null;
  const pendingTransaction = pending && journal ? governance24Transaction(journal, pending) : null;
  const needsOriginalHash = !!pending && !pendingTransaction?.txHash && !pendingTransaction?.intent;
  const canResumeLegacyDeployment = needsOriginalHash && GOVERNANCE24_DEPLOYMENTS.includes(pending as Governance24Name);
  const completed = journal ? Object.keys(confirmedGovernance24Deployments(journal)).length : 0;
  const plan = useMemo(() => {
    if (!common || !journal || completed !== GOVERNANCE24_DEPLOYMENTS.length) return null;
    try { return buildGovernance24UpgradePlan({ ...common, replacements: Object.fromEntries(Object.entries(confirmedGovernance24Deployments(journal))
      .map(([name, item]) => [name, item.address])), salt: journal.salt, delaySeconds: journal.delaySeconds }); }
    catch (problem) { return { invalid: messageOf(problem) }; }
  }, [common, journal, completed]);
  function stop() { epoch.current++; abort.current?.abort(); setProof(null); setResult(null); setOperation('unknown'); setClosedOldRequest(false);
    if (busyRef.current) setMessage('钱包或本机记录已变化，流程已停止。请核对原交易后继续。'); }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; abort.current?.abort(); }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    const names = ['predecessorInput', 'upgradeBundle', 'reviewCatalog', 'gasEvidence', 'liveReview'];
    void Promise.all(names.map(name => pinnedJson(name, controller.signal)))
      .then(values => {
        const input = Object.fromEntries(names.slice(0, 3).map((name, index) => [name, values[index]]));
        const reviewed: Json = { ...input, ...release.pins };
        validateGovernance24UpgradeReview(reviewed);
        if (reviewed.reviewCatalog.profile !== 'formal' || !same(reviewed.reviewCatalog.deployer, GOVERNANCE24_DEPLOYER)
          || !same(reviewed.reviewCatalog.bindings?.proposer, GOVERNANCE24_DEPLOYER)) throw new Error('此页面只接受指定部署钱包的正式部署图。');
        const gas = governance24ReviewedGas(values[3], release.pins, release.gasEvidenceDigest);
        if (!controller.signal.aborted) { setGasLimits(gas); setCommon(reviewed); }
      }).catch(problem => { if (!controller.signal.aborted) setLoadError(messageOf(problem)); });
    return () => controller.abort();
  }, []);
  useEffect(() => discoverWallets(options => {
    const selected = walletRef.current, replacement = selected && options.find(option => option.id === selected.id);
    if (selected && replacement && selected.provider !== replacement.provider) {
      stop(); walletRef.current = replacement; setWallet(replacement); setWalletState(null);
    }
    setWallets(options);
  }), []);
  useEffect(() => {
    if (!wallet) return; let active = true;
    const changed = () => { stop(); void readWallet(wallet.provider).then(value => {
      if (active) setWalletState(value ? { ...value, address: getAddress(value.address) } : null);
    }).catch(problem => { if (active) { setWalletState(null); setError(messageOf(problem)); } }); };
    const disconnected = () => { if (active) { stop(); setWalletState(null); } };
    wallet.provider.on?.('accountsChanged', changed); wallet.provider.on?.('chainChanged', changed); wallet.provider.on?.('disconnect', disconnected);
    return () => { active = false; wallet.provider.removeListener?.('accountsChanged', changed);
      wallet.provider.removeListener?.('chainChanged', changed); wallet.provider.removeListener?.('disconnect', disconnected); };
  }, [wallet]);
  useEffect(() => {
    if (!key || !context) return;
    const restore = () => { try { const raw = localStorage.getItem(key); setJournal(raw ? parseGovernance24Journal(JSON.parse(raw), context) : null);
      setProof(null); setResult(null); setOperation('unknown'); setReadyAt(null); }
    catch (problem) { setJournal(null); setError(messageOf(problem)); } };
    restore(); const storage = (event: StorageEvent) => { if (event.key === key || event.key === null) { stop(); restore(); } };
    window.addEventListener('storage', storage); return () => window.removeEventListener('storage', storage);
  }, [key]);
  async function run(label: string, action: (session: Session) => Promise<void>) {
    if (busyRef.current || !context || !key) return;
    busyRef.current = true; setBusy(label); setError(''); setMessage('');
    const revision = epoch.current, controller = new AbortController(), provider = rpc(controller.signal); abort.current = controller;
    let expectedRaw: string | null = null, locked = false;
    const boundWallet: { current: WalletOption | null } = { current: null };
    const current = () => mounted.current && revision === epoch.current && !controller.signal.aborted;
    const assertCurrent = () => {
      if (!current() || boundWallet.current && walletRef.current?.provider !== boundWallet.current.provider)
        throw new Error('钱包、网络或记录已变化，本次流程已停止。');
      if (localStorage.getItem(key) !== expectedRaw) throw new Error('另一标签已更新升级记录，请重新继续。');
    };
    const cancel = () => { stop(); };
    const session: Session = { provider, assertCurrent,
      bindWallet: option => { boundWallet.current = option;
        for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) option.provider.on?.(event, cancel); },
      read: async (read, timeout = 60000) => {
        assertCurrent(); let timer: ReturnType<typeof setTimeout> | undefined;
        let cancelRead: (() => void) | undefined;
        try {
          const value = await Promise.race([read(), new Promise<never>((_, reject) => {
            cancelRead = () => reject(new Error('流程已停止。'));
            controller.signal.addEventListener('abort', cancelRead, { once: true });
            timer = setTimeout(() => { reject(new Error('读取超时，已停止后续钱包请求。请稍后继续。')); controller.abort(); }, timeout);
          })]); assertCurrent(); return value;
        } finally { if (timer) clearTimeout(timer); if (cancelRead) controller.signal.removeEventListener('abort', cancelRead); }
      },
      lock: async lockedAction => {
        assertCurrent(); if (!navigator.locks) throw new Error('请使用支持交易记录锁的最新 Chrome、Edge 或 Safari。');
        await navigator.locks.request(key, { mode: 'exclusive', ifAvailable: true }, async lock => {
          if (!lock) throw new Error('另一标签正在处理本次升级，请稍后继续。');
          assertCurrent(); locked = true;
          try { await lockedAction(expectedRaw ? parseGovernance24Journal(JSON.parse(expectedRaw), context) : null); }
          finally { locked = false; }
        });
      },
      persist: item => {
        // A returned hash remains durable even when a wallet event stopped the run.
        if (!locked || localStorage.getItem(key) !== expectedRaw) throw new Error('升级记录已变化，不能覆盖原交易。');
        const checked = parseGovernance24Journal(item, context), raw = JSON.stringify(checked);
        localStorage.setItem(key, raw);
        if (localStorage.getItem(key) !== raw) throw new Error('升级记录未完整保存，已停止后续钱包请求。');
        expectedRaw = raw;
        if (mounted.current) setJournal(checked); return checked;
      },
      wait: () => new Promise<void>((resolve, reject) => {
        assertCurrent(); const canceled = () => { clearTimeout(timer); reject(new Error('流程已停止。')); };
        const timer = setTimeout(() => { controller.signal.removeEventListener('abort', canceled); resolve(); }, 3000);
        controller.signal.addEventListener('abort', canceled, { once: true });
      }),
    };
    try { expectedRaw = localStorage.getItem(key); await action(session); }
    catch (problem) { if (mounted.current && (current() || controller.signal.aborted && revision === epoch.current)) setError(messageOf(problem)); }
    finally {
      for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) boundWallet.current?.provider.removeListener?.(event, cancel);
      provider.destroy(); if (abort.current === controller) abort.current = null;
      busyRef.current = false; if (mounted.current) setBusy('');
    }
  }
  async function operationState(provider: JsonRpcProvider, currentPlan: Json) {
    const block = await provider.getBlock('finalized'); if (!block?.hash) throw new Error('无法读取最终确认区块。');
    const chain = await provider.send('eth_chainId', []); if (BigInt(chain) !== 56n) throw new Error('只读节点不属于 BSC 主网。');
    const lock = new Contract(currentPlan.timelock, ['function getTimestamp(bytes32) view returns(uint256)'], provider);
    const timestamp = await lock.getTimestamp(currentPlan.operationId, { blockTag: block.number }) as bigint;
    const canonical = await provider.getBlock(block.number);
    if (!canonical?.hash || !same(canonical.hash, block.hash)) throw new Error('最终确认区块已变化。');
    return { operation: (timestamp === 0n ? 'unscheduled' : timestamp === 1n ? 'done'
      : timestamp <= BigInt(block.timestamp) ? 'ready' : 'waiting') as Operation,
    readyAt: timestamp > 1n ? Number(timestamp) : null, snapshot: block };
  }
  function planFor(source: Governance24Journal) {
    const deployments = confirmedGovernance24Deployments(source);
    return Object.keys(deployments).length === GOVERNANCE24_DEPLOYMENTS.length ? buildGovernance24UpgradePlan({ ...common,
      replacements: Object.fromEntries(Object.entries(deployments).map(([name, item]) => [name, item.address])),
      salt: source.salt, delaySeconds: source.delaySeconds }) : null;
  }
  async function preflight(provider: JsonRpcProvider, source: Governance24Journal | null, assertCurrent: () => void, force?: 'prepared' | 'unscheduled' | 'scheduled' | 'done') {
    if (!common) throw new Error('已审查发布文件尚未加载。');
    assertCurrent(); setResult(null); const currentPlan = source ? planFor(source) : null;
    // Abandonment is a user decision, never a failed-receipt or non-broadcast proof.
    // Recheck its original payload against the reviewed candidate before allowing progress.
    for (const abandoned of source?.abandonedUnknownDeployments ?? []) {
      const prefix = Object.fromEntries(GOVERNANCE24_DEPLOYMENTS.slice(0, GOVERNANCE24_DEPLOYMENTS.indexOf(abandoned.step))
        .map(name => [name, source!.deployments[name]!.address!]));
      const data = prepareGovernance24UpgradeDeployment(abandoned.step, common, { deploymentsPrefix: prefix }).data;
      if (!same(abandoned.transaction.from, deployer) || !same(keccak256(data), abandoned.transaction.dataHash))
        throw new Error('保留的旧未知部署与固定候选步骤不同。');
    }
    // Imported failure rows are claims too. Re-prove status0 before they can clear a retry gate.
    for (const failed of source?.failedTransactions ?? []) {
      const cancellation = isGovernance24Cancellation(failed.step), governance = cancellation || failed.step === 'schedule' || failed.step === 'execute';
      const prior = source ? Object.fromEntries(GOVERNANCE24_DEPLOYMENTS.slice(0, GOVERNANCE24_DEPLOYMENTS.indexOf(failed.step as Governance24Name))
        .filter(name => source.deployments[name]?.status === 'confirmed').map(name => [name, source.deployments[name]!.address!])) : {};
      const data = cancellation ? currentPlan?.cancellations.find((item: Json) => item.id === failed.step)?.data : governance ? currentPlan?.[`${failed.step}Data`]
        : prepareGovernance24UpgradeDeployment(failed.step, common, { deploymentsPrefix: prior }).data;
      if (!data || !same(keccak256(data), failed.transaction.dataHash)
        || !same(failed.transaction.from, governance ? proposer : deployer)) throw new Error('归档失败交易与本次固定步骤不符。');
      try {
        await verifyGovernance24RecoveryReceipt(provider, failed.evidence.txHash, { from: failed.transaction.from,
          dataHash: failed.transaction.dataHash, intent: failed.transaction.intent,
          ...(governance ? { to: currentPlan.timelock, data, operation: cancellation ? 'cancel' as const : failed.step as 'schedule' | 'execute', ...(cancellation ? { cancellationId: failed.step as `cancel-${string}` } : {}), input: common!, plan: currentPlan } : {}) });
        throw new Error('归档交易没有已验证的最终失败回执。');
      } catch (problem) {
        if (!(problem instanceof VerifiedGovernance24TransactionFailure)) throw problem;
        if (!same(problem.evidence.blockHash, failed.evidence.blockHash) || problem.evidence.blockNumber !== failed.evidence.blockNumber)
          throw new Error('失败归档的规范区块已变化。');
      }
    }
    const cancellationsComplete = !!source && source.cancellationIds.every(id => source.cancellations[id]?.status === 'confirmed');
    const currentState = currentPlan && cancellationsComplete && force !== 'prepared' ? await operationState(provider, currentPlan)
      : { operation: 'unknown' as Operation, readyAt: null, snapshot: undefined };
    const phase = force || (currentState.operation === 'done' ? 'done'
      : ['waiting', 'ready'].includes(currentState.operation) ? 'scheduled' : currentPlan && cancellationsComplete ? 'unscheduled' : 'prepared');
    assertCurrent(); setBusy(phase === 'done' ? '只读核验升级结果（可能需要几分钟）' : '只读核验升级条件（可能需要几分钟）');
    const checked = await validateGovernance24UpgradePreflight(provider, common, { phase,
      ...(currentState.snapshot ? { snapshot: currentState.snapshot } : {}),
      cancellationTxHashes: source ? confirmedGovernance24Cancellations(source) : {},
      deployments: source ? confirmedGovernance24Deployments(source) : {}, ...(currentPlan ? { plan: currentPlan } : {}),
      ...(source?.schedule?.txHash ? { scheduleTxHash: source.schedule.txHash } : {}),
      ...(source?.execute?.txHash ? { executeTxHash: source.execute.txHash } : {}) });
    assertCurrent(); const state = { operation: (checked.operation || currentState.operation) as Operation,
      readyAt: checked.readyAt ?? currentState.readyAt };
    setProof(checked); setOperation(state.operation); setReadyAt(state.readyAt);
    if (phase === 'done') {
      if (checked.codeUpgradeComplete !== true || checked.governanceMigrationComplete !== true || checked.coverageVerified !== true
        || checked.businessDelaySeconds !== 86400 || checked.legacyRecoveryDelaySeconds !== 172800
        || !Array.isArray(checked.confirmedCancellationIds)
        || checked.confirmedCancellationIds.length !== source?.cancellationIds.length
        || !source?.cancellationIds.every(id => checked.confirmedCancellationIds.some((proofId: string) => same(proofId, id.slice(7)))))
        throw new Error('全业务治理迁移尚未完整核验，不能标记完成。');
      setResult(governance24VerifiedUpgrade(checked));
    }
    return { checked, ...state };
  }
  async function begin(readOnly = false) { await run(readOnly ? '核对原交易' : '准备升级', async session => {
    if (!common || !context || !gasLimits) throw new Error('升级文件尚未加载完成。');
    const selected = walletRef.current ?? wallets[0];
    if (!selected) throw new Error('请安装并解锁浏览器钱包后刷新。');
    setBusy('请在钱包中确认连接');
    await selected.provider.request({ method: 'eth_requestAccounts' }); session.assertCurrent();
    const state = await readWallet(selected.provider); session.assertCurrent();
    if (!state) throw new Error('钱包没有提供账户。');
    walletRef.current = selected; setWallet(selected); setWalletState({ ...state, address: getAddress(state.address) }); session.bindWallet(selected);
    if (state.chainId !== 56) { setBusy('请在钱包中切换 BSC 主网'); await switchToBsc(selected.provider);
      setMessage('请确认钱包已切换到 BSC 主网，再点击继续。'); return; }
    if (!same(state.address, deployer) || !same(state.address, proposer)) throw new Error(`请切换到部署钱包 ${deployer} 后继续。`);
    const provider = recoveryProvider(session, selected);
    await session.lock(async restored => {
      if (readOnly && !restored) throw new Error('本机没有待核对的原交易记录。');
      let source = restored ?? session.persist(newGovernance24Journal(context, newSalt()));
      let proven: { raw: string; state: { operation: Governance24Operation; readyAt: number | null } } | null = null;
      const inspect = async (item: Governance24Journal, force?: 'prepared' | 'unscheduled' | 'scheduled' | 'done') => {
        const raw = JSON.stringify(item);
        if (!force && proven?.raw === raw) { session.assertCurrent(); return proven.state; }
        const checked = await session.read(() => preflight(provider, item, session.assertCurrent, force), GOVERNANCE24_PREFLIGHT_TIMEOUT_MS);
        proven = { raw, state: { operation: checked.operation, readyAt: checked.readyAt } }; return proven.state;
      };
      const recover = async (item: Governance24Journal, step: Governance24Step, suppliedHash?: string) => {
        let transaction = governance24Transaction(item, step)!;
        const cancellation = isGovernance24Cancellation(step), governance = cancellation || step === 'schedule' || step === 'execute', currentPlan = planFor(item);
        const trusted = returnedHash.current;
        const originalRaw = JSON.stringify(item);
        const returned = trusted?.key === key && trusted.raw === originalRaw && trusted.step === step ? trusted.hash : undefined;
        const data = cancellation ? currentPlan?.cancellations.find((item: Json) => item.id === step)?.data : governance ? currentPlan?.[`${step}Data`]
          : prepareGovernance24UpgradeDeployment(step, common, { deploymentsPrefix: confirmedGovernance24Deployments(item) }).data;
        if (!data || !same(keccak256(data), transaction.dataHash)) throw new Error('本机原交易与固定升级步骤不同。');
        const expected = { from: transaction.from, dataHash: transaction.dataHash, intent: transaction.intent,
          ...(governance ? { to: currentPlan.timelock, data, operation: cancellation ? 'cancel' as const : step as 'schedule' | 'execute', ...(cancellation ? { cancellationId: step as `cancel-${string}` } : {}), input: common!, plan: currentPlan } : {}) };
        let hash = transaction.txHash || returned || suppliedHash?.trim(), discovered = false;
        if (!hash && transaction.intent) {
          setBusy('自动找回当前交易');
          hash = await session.read(() => discoverGovernance24Transaction(provider, expected), 60000) ?? undefined;
          if (!hash) { setMessage('当前交易尚未最终确认，记录已保留。稍后点击“核对当前交易”；不会重新发送。');
            return { journal: item, outcome: 'waiting' as const }; }
          discovered = true;
        }
        if (!hash || !/^0x[\da-f]{64}$/i.test(hash)) throw new Error('请从钱包交易记录复制完整的原交易哈希。');
        if (!same(transaction.from, governance ? proposer : deployer)) throw new Error('原交易发送者与指定钱包不同。');
        if (!transaction.txHash && (returned || discovered)) {
          transaction = { ...transaction, txHash: hash, status: 'submitted' };
          item = session.persist(withGovernance24Transaction(item, step, transaction));
          returnedHash.current = null; setUnwrittenHash('');
        }
        setBusy('等待当前交易确认');
        const finalized = await session.read(() => waitForGovernance24Finality(provider, hash!,
          { assertCurrent: session.assertCurrent, wait: session.wait }), 75000);
        if (!finalized) return { journal: item, outcome: 'waiting' as const };
        let receipt;
        try { receipt = await session.read(() => verifyGovernance24RecoveryReceipt(provider, hash!, expected), 30000); }
        catch (problem) {
          if (!(problem instanceof VerifiedGovernance24TransactionFailure)) throw problem;
          if (!transaction.txHash && !transaction.intent && !returned) throw new Error('输入的交易已失败，但不能证明它是本次未知发送。请回到原钱包请求或原标签取得带原哈希的记录；当前步骤不会重发。');
          if (!transaction.txHash) {
            transaction = { ...transaction, txHash: hash, status: 'submitted' };
            item = session.persist(withGovernance24Transaction(item, step, transaction));
          }
          session.assertCurrent(); const archived = session.persist(archiveGovernance24Failure(item, step, problem.evidence, context));
          setOperation('unknown'); setRecoveryHash('');
          setMessage('当前交易执行失败，原回执已保存。准备好后点击继续重试这一步。');
          return { journal: archived, outcome: 'failed' as const };
        }
        if (!receipt) return { journal: item, outcome: 'waiting' as const };
        if (!transaction.txHash && !transaction.intent && !returned) throw new Error('输入的交易已确认，但不能证明它是本次未知发送。请回到原钱包请求或原标签取得带原哈希的记录；当前步骤不会继续发送。');
        const confirmed: UpgradeTransaction = { ...transaction, txHash: hash, status: 'confirmed',
          ...(governance ? {} : { address: getAddress(receipt.contractAddress!) }) };
        const candidate = withGovernance24Transaction(item, step, confirmed);
        const checked = await inspect(candidate, governance24RecoveryPhase(step, candidate));
        session.assertCurrent(); const saved = session.persist(candidate); setRecoveryHash(''); setUnwrittenHash(''); returnedHash.current = null;
        return { journal: saved, outcome: 'confirmed' as const, readyAt: checked.readyAt };
      };
      const submit = async (item: Governance24Journal, step: Governance24Step) => {
        session.assertCurrent(); const cancellation = isGovernance24Cancellation(step), governance = cancellation || step === 'schedule' || step === 'execute';
        const currentPlan = governance ? planFor(item) : null;
        const prepared = cancellation ? currentPlan.cancellations.find((item: Json) => item.id === step) : governance ? { data: currentPlan[`${step}Data`] }
          : prepareGovernance24UpgradeDeployment(step, common, { deploymentsPrefix: confirmedGovernance24Deployments(item) });
        setBusy('准备当前交易');
        const intent = await session.read(() => prepareGovernance24Intent(provider, state.address));
        const transaction: UpgradeTransaction = { status: 'uncertain', from: getAddress(state.address), dataHash: keccak256(prepared.data), intent };
        let saved = item;
        const put = (value: UpgradeTransaction) => withGovernance24Transaction(item, step, value);
        setBusy(cancellation ? `请在钱包中签名取消旧排程 ${currentPlan.cancellations.findIndex((item: Json) => item.id === step) + 1} / ${currentPlan.cancellations.length}` : governance ? step === 'schedule' ? '请在钱包中确认等待期排程' : '请在钱包中确认执行升级'
          : `请在钱包中确认第 ${GOVERNANCE24_DEPLOYMENTS.indexOf(step as Governance24Name) + 1} 笔部署`);
        const guardedWallet = { request: async (request: Parameters<typeof selected.provider.request>[0]) => {
          try { session.assertCurrent(); } catch (problem) { throw Object.assign(problem as Error, { code: 'ACTION_REJECTED' }); }
          if (request.method === 'eth_sendTransaction') {
            try { await session.read(() => assertGovernance24IntentCurrent(provider, transaction.from, intent)); }
            catch (problem) { throw Object.assign(problem as Error, { code: 'ACTION_REJECTED' }); }
          }
          return selected.provider.request(request);
        } };
        await submitGovernance24Upgrade(guardedWallet, { from: transaction.from, data: prepared.data, intent,
          ...(governance ? { to: currentPlan.timelock } : { gasLimit: gasLimits[step as Governance24Name] }) }, {
          beforeRequest: () => { session.assertCurrent(); saved = session.persist(put(transaction)); },
          definitelyRejected: () => { saved = session.persist(item); },
          submitted: hash => { returnedHash.current = { key: key!, raw: JSON.stringify(saved), step, hash };
            try { saved = session.persist(put({ ...transaction, status: 'submitted', txHash: hash })); returnedHash.current = null; if (mounted.current) setUnwrittenHash(''); }
            catch (problem) { if (mounted.current) setUnwrittenHash(hash); throw new Error(`原交易已发送，记录未能保存。请保存此哈希 ${hash}。${messageOf(problem)}`); } },
        });
        proven = null; session.assertCurrent(); return saved;
      };
      const original = governance24Pending(source);
      const originalTransaction = original ? governance24Transaction(source, original) : null;
      if (original && (readOnly || !originalTransaction?.txHash && (originalTransaction?.intent || recoveryHash.trim() || returnedHash.current))) {
        const recovered = await recover(source, original, recoveryHash); source = recovered.journal;
        if (readOnly && recovered.outcome === 'confirmed') setMessage('原交易已确认并保存。点击“继续升级”处理下一步。');
        if (readOnly || recovered.outcome !== 'confirmed' || original === 'schedule' || original === 'execute') return;
      }
      if (readOnly) {
        const checked = await inspect(source);
        setMessage(checked.operation === 'ready' ? '原排程已到期。点击“确认执行升级”，在钱包确认执行交易。'
          : checked.operation === 'done' ? '原升级已经完成。' : '原升级进度已核对，记录已保留。'); return;
      }
      const advanced = await runGovernance24UpgradeSequence({ journal: source, assertCurrent: session.assertCurrent, inspect, submit, recover });
      if (advanced.outcome === 'unknown') setMessage('钱包没有返回原交易哈希。请回到原钱包请求或原标签等待哈希保存，或取回带原哈希的原记录；页面不会重发。');
      else if (advanced.outcome === 'waiting') setMessage(advanced.journal.schedule?.status === 'confirmed'
        ? '排程已确认。等待 48 小时后，再点击同一按钮执行升级。'
        : '当前交易仍在确认。记录已保存，稍后点击继续即可。');
      else if (advanced.outcome === 'done') setMessage('全业务治理迁移已完成，所有范围与恢复通道已核验。');
    });
  }); }
  async function resumeLegacyDeployment() { await run('恢复旧部署流程', async session => {
    if (!closedOldRequest || !common || !context) throw new Error('请先关闭旧钱包请求，再勾选确认。');
    const selected = walletRef.current ?? wallets[0];
    if (!selected) throw new Error('请连接原部署钱包。');
    walletRef.current = selected; setWallet(selected); session.bindWallet(selected);
    const state = await session.read(() => readWallet(selected.provider));
    if (!state || state.chainId !== 56 || !same(state.address, deployer) || !same(state.address, proposer))
      throw new Error('请连接指定部署钱包并切换 BSC 主网。');
    setWalletState({ ...state, address: getAddress(state.address) });
    const provider = recoveryProvider(session, selected);
    await session.lock(async source => {
      if (!source) throw new Error('原升级记录已变化，请刷新页面。');
      const step = governance24Pending(source);
      if (!step || !GOVERNANCE24_DEPLOYMENTS.includes(step as Governance24Name)) throw new Error('只能恢复旧的合约部署步骤。');
      const original = source.deployments[step as Governance24Name]!;
      const prepared = prepareGovernance24UpgradeDeployment(step, common, { deploymentsPrefix: confirmedGovernance24Deployments(source) });
      if (!same(original.from, deployer) || !same(original.dataHash, keccak256(prepared.data)))
        throw new Error('旧未知记录的发送者或部署字节码与固定候选不同，原记录已保留。');
      await session.read(() => preflight(provider, source, session.assertCurrent, 'prepared'), GOVERNANCE24_PREFLIGHT_TIMEOUT_MS);
      const observedIntent = await session.read(() => prepareGovernance24Intent(provider, state.address));
      const candidate = archiveLegacyGovernance24Deployment(source, context, {
        step: step as Governance24Name, acknowledged: true, checkedAt: new Date().toISOString(), currentIntent: observedIntent,
      });
      session.assertCurrent(); session.persist(candidate); setClosedOldRequest(false); setRecoveryHash('');
      setOperation('unknown'); setMessage('旧未知记录已完整保留，部署流程已恢复。本次没有发送交易；点击“继续升级”发起新的部署请求。');
    });
  }); }
  async function importJournal(file: File) { await run('恢复升级记录', async session => {
    if (!context) throw new Error('升级文件尚未就绪。');
    const imported = await parseGovernance24ImportFile(file, context); session.assertCurrent();
    await session.lock(async existing => {
      if (existing) {
        const step = governance24Pending(existing), cancellation = isGovernance24Cancellation(step), governance = cancellation || step === 'schedule' || step === 'execute';
        if (!step) throw new Error('本机已有完整记录，不能覆盖。');
        const original = governance24Transaction(existing, step)!;
        const replacement = governance24Transaction(imported, step)!;
        const restored = withGovernance24Transaction(imported, step, original);
        if (!original.intent || original.txHash || !replacement?.txHash
          || canonical(restored) !== canonical(existing)
          || canonical({ ...replacement, status: original.status, txHash: undefined, address: undefined }) !== canonical(original))
          throw new Error('恢复文件不能证明是本次发送，或包含不同进度；原记录已保留。');
        const selected = walletRef.current ?? wallets[0]; if (!selected) throw new Error('请先连接原部署钱包。');
        walletRef.current = selected; setWallet(selected); session.bindWallet(selected);
        const state = await session.read(() => readWallet(selected.provider));
        if (!state || state.chainId !== 56 || !same(state.address, original.from)) throw new Error('请连接原部署钱包并切换 BSC 主网。');
        const provider = recoveryProvider(session, selected), currentPlan = planFor(existing);
        const data = cancellation ? currentPlan?.cancellations.find((item: Json) => item.id === step)?.data : governance ? currentPlan?.[`${step}Data`] : undefined;
        const expected = { from: original.from, dataHash: original.dataHash, intent: original.intent,
          ...(governance ? { to: currentPlan.timelock, data, operation: cancellation ? 'cancel' as const : step as 'schedule' | 'execute', ...(cancellation ? { cancellationId: step as `cancel-${string}` } : {}), input: common!, plan: currentPlan } : {}) };
        try {
          const receipt = await session.read(() => verifyGovernance24RecoveryReceipt(provider, replacement.txHash!, expected));
          if (!receipt) throw new Error('原交易尚未最终确认，记录未合并。');
        } catch (problem) { if (!(problem instanceof VerifiedGovernance24TransactionFailure)) throw problem; }
        const submitted = { ...original, status: 'submitted' as const, txHash: replacement.txHash };
        session.persist(withGovernance24Transaction(existing, step, submitted));
        setMessage('原交易哈希已合并。点击“核对当前交易”确认结果，该按钮不会发送新交易。'); return;
      }
      let provider = session.provider;
      if (imported.failedTransactions?.some(row => row.transaction.intent)) {
        const selected = walletRef.current ?? wallets[0]; if (!selected) throw new Error('请连接原部署钱包以核对失败记录。');
        walletRef.current = selected; setWallet(selected); session.bindWallet(selected);
        const state = await session.read(() => readWallet(selected.provider));
        if (!state || state.chainId !== 56 || !same(state.address, deployer)) throw new Error('请连接原部署钱包并切换 BSC 主网。');
        provider = recoveryProvider(session, selected);
      }
      await session.read(() => preflight(provider, imported, session.assertCurrent), GOVERNANCE24_PREFLIGHT_TIMEOUT_MS);
      session.assertCurrent(); session.persist(imported); setMessage('记录已恢复，点击继续即可。');
    });
  }); }
  function exportRecord() { if (!journal) return; download('bemine-governance24-upgrade-record.json', {
    schemaVersion: 1, kind: 'fixed-governance24-upgrade-wallet-record-v1', exportedAt: new Date().toISOString(),
    release, journal, plan: !plan || plan.invalid ? null : { ...plan, deployments: plan.deployments?.map((entry: Json) => ({
      name: entry.name, address: entry.address, codehash: entry.codehash, constructorArgs: entry.constructorArgs,
      libraries: entry.libraries })) }, preflight: proof, postUpgradeProof: result,
    deploymentComplete: completed === GOVERNANCE24_DEPLOYMENTS.length, activated: !!result && operation === 'done', productActive: false, governance24Activated: !!result && operation === 'done' }); }
  function selectWallet(id: string) {
    const option = wallets.find(item => item.id === id); if (!option || option.provider === walletRef.current?.provider) return;
    stop(); setClosedOldRequest(false); walletRef.current = option; setWallet(option); setWalletState(null);
  }
  const done = !!result && operation === 'done', scheduled = journal?.schedule?.status === 'confirmed';
  const stateLabel = done ? '升级已完成' : operation === 'waiting' ? '等待 48 小时'
    : operation === 'ready' ? '等待期已结束，可以执行升级' : canResumeLegacyDeployment ? '旧部署记录需要恢复' : pending ? '当前交易待确认'
      : scheduled ? '排程已确认，继续时自动检查等待期' : completed === GOVERNANCE24_DEPLOYMENTS.length && journal?.cancellationIds.some(id => journal.cancellations[id]?.status !== 'confirmed') ? '新部署已确认，请在钱包签名取消旧排程' : completed ? `部署进度 ${completed} / ${GOVERNANCE24_DEPLOYMENTS.length}` : '准备就绪后，点击下方按钮开始';
  return <main className="to-shell">
    <div className="to-top"><span className="to-mark">BEMINE / 合约升级</span><span className="to-status">BSC 主网</span></div>
    <h1>全业务 24 小时治理升级</h1>
    <p className="to-lead">连接指定部署钱包，按提示确认 {GOVERNANCE24_DEPLOYMENTS.length} 笔新部署，再亲自签名取消被完整升级覆盖的旧排程，并确认原时间锁排程；首次等待 48 小时后，再回来执行。迁移完成后，正常业务升级等待 24 小时。</p>
    <section className="to-card to-main">
      <ol className="to-steps" aria-label="升级进度">
        <li className={completed === GOVERNANCE24_DEPLOYMENTS.length ? 'to-complete' : 'to-current'}><span>1</span><div>部署升级组件<small>{completed} / {GOVERNANCE24_DEPLOYMENTS.length} 已确认</small></div></li>
        <li className={done ? 'to-complete' : scheduled ? 'to-current' : ''}><span>2</span><div>等待 48 小时<small>{scheduled ? '排程已确认' : '确认新部署及旧排程取消后排程'}</small></div></li>
        <li className={done ? 'to-complete' : operation === 'ready' ? 'to-current' : ''}><span>3</span><div>完成升级<small>{done ? '结果已确认' : '等待期后钱包确认'}</small></div></li>
      </ol>
      <h2 className="to-state" data-testid="activation-state">{stateLabel}</h2>
      {readyAt && <p>最早执行时间：{new Date(readyAt * 1000).toLocaleString('zh-CN')}</p>}
      {(loadError || error) && <p role="alert" className="to-note to-error">{loadError || error}</p>}
      {message && <p role="status" className="to-note">{message}</p>}
      {busy.startsWith('只读核验') && <p role="status" className="to-note">正在核对链上记录，请保持页面打开；完成检查后才会请求下一笔钱包确认。</p>}
      {wallets.length > 1 && <label className="to-wallet">选择钱包<select aria-label="选择钱包" value={wallet?.id ?? wallets[0]?.id ?? ''} disabled={!!busy}
        onChange={event => selectWallet(event.target.value)}>{wallets.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>}
      {!!cancellationPlan.length && <div className="to-note to-wait" data-testid="signed-cancellation-notice">
        <strong>本次将取消已被完整升级覆盖的旧排程，原项目与资金不变。</strong>
        <p>全部新部署确认后，你需要在钱包逐笔签名取消下列旧排程，再签名确认新的 48 小时排程。点击“继续升级”表示进入这个流程；每次取消都由你在钱包审批。</p>
        <p className="to-small">原操作参数和最早执行时间保留在技术信息及导出记录中。取消旧排程不会直接执行升级。</p>
        {cancellationPlan.map(item => <div className="to-technical-row" key={item.id}><strong>{item.name}</strong><code>{item.operationId}</code>
          <span>{journal?.cancellations[item.id as `cancel-${string}`]?.status === 'confirmed' ? '取消已核验' : journal?.cancellations[item.id as `cancel-${string}`] ? '取消交易待核验' : '待用户签名取消'}</span></div>)}
      </div>}
      <button className="to-primary" disabled={!!busy || !common || !gasLimits || !!loadError || done || !wallets.length || needsOriginalHash}
        onClick={() => begin()}>{busy || (done ? '升级已完成' : needsOriginalHash ? '请先处理下方旧记录' : account ? operation === 'ready' ? '确认执行升级' : '继续升级' : '连接钱包并开始升级')}</button>
      {journal && <button disabled={!!busy || !common || !wallets.length || needsOriginalHash && !recoveryHash.trim() && !unwrittenHash} onClick={() => begin(true)}>{pending ? '核对当前交易' : '核对升级进度'}</button>}
      <p className="to-small">{account ? `当前钱包 ${short(account)}` : `请使用部署钱包 ${deployer ? short(deployer) : '正在加载…'}`}
        {busy && ' · 关闭页面后可从原交易继续'}</p>
      {!wallets.length && <p className="to-small">请安装并解锁浏览器钱包后刷新页面。</p>}
      {unwrittenHash && <div className="to-note to-wait"><strong>已取得原交易哈希，等待保存</strong><input aria-label="未保存的原交易哈希" value={unwrittenHash} readOnly/>
        <p className="to-small">释放本机存储空间后，点击“核对当前交易”保存并确认原交易。该按钮不会发送新交易。</p></div>}
      {pendingTransaction?.intent && !pendingTransaction.txHash && <p className="to-small">已保存本次交易的定位信息。点击“核对当前交易”自动找回，无需手动输入哈希。</p>}
      {canResumeLegacyDeployment ? <div className="to-note to-wait" data-testid="legacy-deployment-recovery"><strong>恢复卡住的部署</strong>
        <p>旧记录没有保存交易哈希或定位信息。请先关闭其他升级标签，并在钱包中取消旧的部署请求；如果已有交易哈希，请保留它，不要重新部署。</p>
        <p className="to-small">旧记录会保留为“结果仍未知”，不会被标成失败。若旧请求随后发出，可能额外消耗 Gas 并导致交易冲突；重新部署仅适用于当前组件，不会绕过升级等待期。</p>
        <label className="to-ack"><input type="checkbox" checked={closedOldRequest} disabled={!!busy}
          onChange={event => setClosedOldRequest(event.target.checked)}/>我已关闭其他升级标签，并取消钱包中的旧部署请求；没有可用的交易哈希</label>
        <button disabled={!!busy || !closedOldRequest || !common || !gasLimits || !!loadError || !wallets.length}
          onClick={() => resumeLegacyDeployment()}>保留旧记录并恢复部署</button>
        <p className="to-small">这一步不发送交易。恢复后再点击“继续升级”，由你在钱包中确认新的部署。</p>
      </div> : needsOriginalHash && <div className="to-note to-wait"><strong>需要找回带原哈希的记录</strong><p className="to-small">钱包发送结果不明。请回到原钱包请求或原标签等待哈希保存，或取回带原哈希的原记录。下方输入仅供只读核验，不能解除重复发送限制。</p>
        <input aria-label="原交易哈希" placeholder="0x… 原交易哈希" value={recoveryHash} onChange={event => setRecoveryHash(event.target.value)} disabled={!!busy}/></div>}
    </section>
    <details className="to-card to-details"><summary>升级覆盖范围与记录恢复</summary>
      <p>首次迁移：原时间锁等待 48 小时。迁移后：正常业务升级等待 24 小时。原时间锁和旧 Beacon 继续保留 48 小时恢复通道。</p>
      <table aria-label="全业务升级覆盖清单"><thead><tr><th>范围</th><th>迁移结果</th></tr></thead><tbody>
        <tr><td>核心矿池</td><td>二级 Beacon 与 Dispatcher 接入 24 小时业务治理</td></tr>
        <tr><td>组合矿池</td><td>二级 Beacon 与 Dispatcher 接入 24 小时业务治理</td></tr>
        <tr><td>两类 Factory、两类 Market</td><td>UUPS 治理迁移至新时间锁</td></tr>
        <tr><td>Authority、两类 Factory 所有权</td><td>由新 24 小时时间锁管理</td></tr>
        <tr><td>固定链接库</td><td>由已审查的父实现覆盖，不声称单独可升级</td></tr>
        <tr><td>Helper、Lens、外部协议</td><td>保留现有地址与代码，不声称可升级</td></tr>
      </tbody></table>
      {common?.reviewCatalog?.coverage && <details><summary>已审查的逐项覆盖台账</summary><pre>{json(common.reviewCatalog.coverage)}</pre></details>}
      <p className="to-small">每次钱包提交前自动检查正式部署与当前角色。已提交交易只读取原回执；确认后核对准确代码和依赖。</p>
      {common && <dl className="to-meta"><dt>原 Factory</dt><dd><code>{context?.factory}</code></dd><dt>原 Beacon</dt><dd><code>{reviewedCatalog?.bindings?.beacon}</code></dd>
        <dt>原 Timelock</dt><dd><code>{reviewedCatalog?.bindings?.timelock}</code></dd><dt>部署 / 执行钱包</dt><dd><code>{deployer}</code></dd>
        <dt>候选摘要</dt><dd><code>{release.pins.trustedUpgradeArtifactDigest}</code></dd>

        {plan && !plan.invalid && <><dt>操作 ID</dt><dd><code>{plan.operationId}</code></dd></>}
        {proof && <><dt>核验区块</dt><dd>#{proof.blockNumber} <code>{proof.blockHash}</code></dd></>}
      </dl>}
      {GOVERNANCE24_DEPLOYMENTS.map(name => { const transaction = journal?.deployments[name]; return <div className="to-technical-row" key={name}>
        <strong>{name}</strong><span>{transaction?.status === 'confirmed' ? '已确认' : transaction ? '待确认' : '尚未部署'}</span>
        {transaction?.address && <code>{transaction.address}</code>}
        {transaction?.txHash && <a href={`${explorer}/tx/${transaction.txHash}`} target="_blank" rel="noreferrer">查看原交易</a>}
      </div>; })}
      {cancellationPlan.map(item => <details key={item.id}><summary>原排程 {short(item.operationId)} · {journal?.cancellations[item.id as `cancel-${string}`]?.status === 'confirmed' ? '用户取消已核验' : '待用户取消'}</summary>
        <p>原最早执行时间：{formatOldEta(item.originalOperation.timestamp)}</p>
        <pre>{json({ originalOperation: item.originalOperation, effects: item.effects })}</pre>
        {journal?.cancellations[item.id as `cancel-${string}`]?.txHash && <a href={`${explorer}/tx/${journal.cancellations[item.id as `cancel-${string}`]!.txHash}`} target="_blank" rel="noreferrer">查看用户取消原交易</a>}
      </details>)}
      {journal?.schedule?.txHash && <p><a href={`${explorer}/tx/${journal.schedule.txHash}`} target="_blank" rel="noreferrer">查看排程原交易</a></p>}
      {journal?.execute?.txHash && <p><a href={`${explorer}/tx/${journal.execute.txHash}`} target="_blank" rel="noreferrer">查看执行原交易</a></p>}
      {!!journal?.failedTransactions?.length && <p className="to-small">已保留 {journal.failedTransactions.length} 笔最终失败回执。</p>}
      {!!journal?.abandonedUnknownDeployments?.length && <p className="to-small">已保留 {journal.abandonedUnknownDeployments.length} 条用户放弃关联的旧部署记录，原发送结果仍未知。</p>}
      <div className="to-actions"><button disabled={!journal || !!busy} onClick={exportRecord}>导出记录</button>
        <label className="to-import">导入恢复记录<input type="file" accept="application/json,.json" disabled={!!busy || !common}
          onChange={event => { const file = event.target.files?.[0]; if (file) void importJournal(file); event.target.value = ''; }}/></label></div>
      <p className="to-small">本次覆盖核心矿池与组合矿池的二级 Beacon 和 Dispatcher、两类 Factory 与两类 Market 的 UUPS 治理、Authority 与 Factory 的所有权，以及随父实现更新的固定库。Helper、Lens 与外部协议保持原地址；原 48 小时时间锁与旧 Beacon 恢复通道保留。</p>
      <a className="to-small" href={release.files.liveReview.path} target="_blank" rel="noreferrer">发布前只读证据</a>
      <p className="to-footer">页面源码 {short(release.sourceCommit)} · 候选源码 {short(release.candidateSourceCommit)}</p>
    </details>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Governance24UpgradeStandalone/>);
