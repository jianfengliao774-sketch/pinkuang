import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Contract, FetchRequest, JsonRpcProvider, getAddress, keccak256, makeError,
  type JsonRpcPayload, type JsonRpcResult } from 'ethers';
// The reviewed helpers are deliberately shared with the read-only product graph verifier.
// @ts-ignore ESM helper has runtime validation; this standalone entry supplies pinned JSON only.
import { buildFirstoBatchUpgradePlan, prepareFirstoBatchUpgradeDeployment, validateFirstoBatchUpgradeReview } from '../shared/firsto-batch-upgrade-plan.mjs';
// @ts-ignore ESM proof module is reviewed and tested independently of this wallet UI.
import { validateFirstoBatchUpgradePreflight } from '../shared/firsto-batch-upgrade-proof.mjs';
import { discoverWallets, messageOf, readWallet, switchToBsc, type WalletOption, type WalletState } from './wallet';
import { normalizeWalletRecoveryResult } from './upgrade-transactions';
import { FIRSTO_BATCH_DEPLOYMENTS, confirmedFirstoBatchDeployments, newFirstoBatchJournal, parseFirstoBatchJournal,
  parseFirstoBatchImportFile,
  firstoBatchJournalKey, firstoBatchPending, runFirstoBatchUpgradeSequence, waitForFirstoBatchFinality, firstoBatchRecoveryPhase, submitFirstoBatchUpgrade, firstoBatchReviewedGas,
  verifyFirstoBatchRecoveryReceipt, VerifiedFirstoBatchTransactionFailure, archiveFirstoBatchFailure,
  prepareFirstoBatchIntent, assertFirstoBatchIntentCurrent, discoverFirstoBatchTransaction, archiveLegacyFirstoBatchDeployment,
  type FirstoBatchJournal, type FirstoBatchName, type FirstoBatchStep, type FirstoBatchOperation, type UpgradeTransaction } from './firsto-batch-upgrade-ui';
import './target-owner-upgrade.css';

type Json = Record<string, any>;
type Release = { kind: string; sourceCommit: string; sourceDiffDigest: string; candidateSourceCommit: string;
  pins: Record<string, string>; files: Record<string, { path: string; sha256: string }>; rpcPath: string; gasEvidenceDigest: string;
  liveReviewEvidenceDigest: string; liveReviewAnchor: { blockNumber: number; blockHash: string; checkedAt: string } };
declare const __FIRSTO_BATCH_RELEASE__: Release;
type Operation = FirstoBatchOperation;
type Session = { provider: JsonRpcProvider; assertCurrent: () => void; bindWallet: (option: WalletOption) => void;
  read: <T>(action: () => Promise<T>, timeout?: number) => Promise<T>;
  lock: (action: (source: FirstoBatchJournal | null) => Promise<void>) => Promise<void>;
  persist: (item: FirstoBatchJournal) => FirstoBatchJournal; wait: () => Promise<void>; };
type Preflight = { blockNumber: number; blockHash: string; [name: string]: any };
const release = __FIRSTO_BATCH_RELEASE__;
const explorer = 'https://bscscan.com';
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
export function createFirstoBatchReadProvider(url: string, signal?: AbortSignal, timeoutMs = 15000): JsonRpcProvider {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 15000) throw new Error('Invalid read deadline.');
  const methods = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getStorageAt',
    'eth_call', 'eth_getTransactionByHash', 'eth_getTransactionReceipt']);
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
function rpc(signal: AbortSignal) { return createFirstoBatchReadProvider(new URL(release.rpcPath, window.location.href).href, signal); }
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

export function FirstoBatchUpgradeStandalone() {
  const [common, setCommon] = useState<Json | null>(null), [loadError, setLoadError] = useState('');
  const [gasLimits, setGasLimits] = useState<Record<FirstoBatchName, string> | null>(null);
  const [wallets, setWallets] = useState<WalletOption[]>([]), [wallet, setWallet] = useState<WalletOption | null>(null);
  const [walletState, setWalletState] = useState<WalletState | null>(null), [journal, setJournal] = useState<FirstoBatchJournal | null>(null);
  const [proof, setProof] = useState<Preflight | null>(null), [result, setResult] = useState<Preflight | null>(null);
  const [operation, setOperation] = useState<Operation>('unknown'), [readyAt, setReadyAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [recoveryHash, setRecoveryHash] = useState('');
  const [unwrittenHash, setUnwrittenHash] = useState('');
  const [closedOldRequest, setClosedOldRequest] = useState(false);
  const busyRef = useRef(false), epoch = useRef(0), abort = useRef<AbortController | null>(null);
  const walletRef = useRef<WalletOption | null>(null), mounted = useRef(true);
  const returnedHash = useRef<{ key: string; raw: string; step: FirstoBatchStep; hash: string } | null>(null);
  const context = useMemo(() => common ? { factory: common.genesisRecord.addresses.factory,
    genesisRecordDigest: release.pins.trustedGenesisRecordDigest, genesisManifestDigest: release.pins.trustedGenesisManifestDigest,
    candidateArtifactDigest: release.pins.trustedUpgradeArtifactDigest, catalogDigest: release.pins.trustedReviewCatalogDigest,
    priorCoreCatalogDigest: release.pins.trustedPriorCoreCatalogDigest, protocolReviewDigest: release.pins.trustedProtocolReviewDigest } : null, [common]);
  const key = context ? firstoBatchJournalKey(context) : null;
  const account = walletState?.address;
  const reviewedCatalog = common?.reviewCatalog;
  const deployer = reviewedCatalog?.deployer as string | undefined, proposer = reviewedCatalog?.bindings?.proposer as string | undefined;
  const pending = journal ? firstoBatchPending(journal) : null;
  const pendingTransaction = pending === 'schedule' || pending === 'execute' ? journal?.[pending] : pending ? journal?.deployments[pending] : null;
  const needsOriginalHash = !!pending && !pendingTransaction?.txHash && !pendingTransaction?.intent;
  const canResumeLegacyDeployment = needsOriginalHash && FIRSTO_BATCH_DEPLOYMENTS.includes(pending as FirstoBatchName);
  const completed = journal ? Object.keys(confirmedFirstoBatchDeployments(journal)).length : 0;
  const plan = useMemo(() => {
    if (!common || !journal || completed !== 2) return null;
    try { return buildFirstoBatchUpgradePlan({ ...common, replacements: Object.fromEntries(Object.entries(confirmedFirstoBatchDeployments(journal))
      .map(([name, item]) => [name, item.address])), salt: journal.salt, delaySeconds: journal.delaySeconds }); }
    catch (problem) { return { invalid: messageOf(problem) }; }
  }, [common, journal, completed]);
  function stop() { epoch.current++; abort.current?.abort(); setProof(null); setClosedOldRequest(false);
    if (busyRef.current) setMessage('钱包或本机记录已变化，流程已停止。请核对原交易后继续。'); }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; abort.current?.abort(); }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    const names = ['genesisRecord', 'genesisBundle', 'trustedGenesisManifest', 'priorCoreCatalog', 'priorCoreBundle',
      'protocolReview', 'upgradeBundle', 'reviewCatalog', 'gasEvidence', 'liveReview'];
    void Promise.all(names.map(name => pinnedJson(name, controller.signal)))
      .then(values => {
        const input = Object.fromEntries(names.slice(0, 8).map((name, index) => [name, values[index]]));
        const reviewed: Json = { ...input, ...release.pins };
        validateFirstoBatchUpgradeReview(reviewed);
        if (reviewed.reviewCatalog.profile !== 'formal') throw new Error('此页面只接受正式部署图。');
        const gas = firstoBatchReviewedGas(values[8], release.pins, release.gasEvidenceDigest);
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
    const restore = () => { try { const raw = localStorage.getItem(key); setJournal(raw ? parseFirstoBatchJournal(JSON.parse(raw), context) : null);
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
          try { await lockedAction(expectedRaw ? parseFirstoBatchJournal(JSON.parse(expectedRaw), context) : null); }
          finally { locked = false; }
        });
      },
      persist: item => {
        // A returned hash remains durable even when a wallet event stopped the run.
        if (!locked || localStorage.getItem(key) !== expectedRaw) throw new Error('升级记录已变化，不能覆盖原交易。');
        const checked = parseFirstoBatchJournal(item, context), raw = JSON.stringify(checked);
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
  function planFor(source: FirstoBatchJournal) {
    const deployments = confirmedFirstoBatchDeployments(source);
    return Object.keys(deployments).length === 2 ? buildFirstoBatchUpgradePlan({ ...common,
      replacements: Object.fromEntries(Object.entries(deployments).map(([name, item]) => [name, item.address])),
      salt: source.salt, delaySeconds: source.delaySeconds }) : null;
  }
  async function preflight(provider: JsonRpcProvider, source: FirstoBatchJournal | null, assertCurrent: () => void, force?: 'prepared' | 'unscheduled' | 'scheduled' | 'done') {
    if (!common) throw new Error('已审查发布文件尚未加载。');
    assertCurrent(); const currentPlan = source ? planFor(source) : null;
    // Abandonment is a user decision, never a failed-receipt or non-broadcast proof.
    // Recheck its original payload against the reviewed candidate before allowing progress.
    for (const abandoned of source?.abandonedUnknownDeployments ?? []) {
      const prefix = Object.fromEntries(FIRSTO_BATCH_DEPLOYMENTS.slice(0, FIRSTO_BATCH_DEPLOYMENTS.indexOf(abandoned.step))
        .map(name => [name, source!.deployments[name]!.address!]));
      const data = prepareFirstoBatchUpgradeDeployment(abandoned.step, common, { deploymentsPrefix: prefix }).data;
      if (!same(abandoned.transaction.from, deployer) || !same(keccak256(data), abandoned.transaction.dataHash))
        throw new Error('保留的旧未知部署与固定候选步骤不同。');
    }
    // Imported failure rows are claims too. Re-prove status0 before they can clear a retry gate.
    for (const failed of source?.failedTransactions ?? []) {
      const governance = failed.step === 'schedule' || failed.step === 'execute';
      const prior = source ? Object.fromEntries(FIRSTO_BATCH_DEPLOYMENTS.slice(0, FIRSTO_BATCH_DEPLOYMENTS.indexOf(failed.step as FirstoBatchName))
        .filter(name => source.deployments[name]?.status === 'confirmed').map(name => [name, source.deployments[name]!.address!])) : {};
      const data = governance ? currentPlan?.[`${failed.step}Data`]
        : prepareFirstoBatchUpgradeDeployment(failed.step, common, { deploymentsPrefix: prior }).data;
      if (!data || !same(keccak256(data), failed.transaction.dataHash)
        || !same(failed.transaction.from, governance ? proposer : deployer)) throw new Error('归档失败交易与本次固定步骤不符。');
      try {
        await verifyFirstoBatchRecoveryReceipt(provider, failed.evidence.txHash, { from: failed.transaction.from,
          dataHash: failed.transaction.dataHash, intent: failed.transaction.intent,
          ...(governance ? { to: currentPlan.timelock, data, operation: failed.step as 'schedule' | 'execute' } : {}) });
        throw new Error('归档交易没有已验证的最终失败回执。');
      } catch (problem) {
        if (!(problem instanceof VerifiedFirstoBatchTransactionFailure)) throw problem;
        if (!same(problem.evidence.blockHash, failed.evidence.blockHash) || problem.evidence.blockNumber !== failed.evidence.blockNumber)
          throw new Error('失败归档的规范区块已变化。');
      }
    }
    const currentState = currentPlan && force !== 'prepared' ? await operationState(provider, currentPlan)
      : { operation: 'unknown' as Operation, readyAt: null, snapshot: undefined };
    const phase = force || (currentState.operation === 'done' ? 'done'
      : ['waiting', 'ready'].includes(currentState.operation) ? 'scheduled' : currentPlan ? 'unscheduled' : 'prepared');
    assertCurrent(); setBusy(phase === 'done' ? '确认升级结果' : '自动检查升级条件');
    const checked = await validateFirstoBatchUpgradePreflight(provider, common, { phase,
      ...(currentState.snapshot ? { snapshot: currentState.snapshot } : {}),
      deployments: source ? confirmedFirstoBatchDeployments(source) : {}, ...(currentPlan ? { plan: currentPlan } : {}),
      ...(source?.schedule?.txHash ? { scheduleTxHash: source.schedule.txHash } : {}),
      ...(source?.execute?.txHash ? { executeTxHash: source.execute.txHash } : {}) });
    assertCurrent(); const state = { operation: (checked.operation || currentState.operation) as Operation,
      readyAt: checked.readyAt ?? currentState.readyAt };
    setProof(checked); setOperation(state.operation); setReadyAt(state.readyAt);
    if (phase === 'done') setResult(checked);
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
      let source = restored ?? session.persist(newFirstoBatchJournal(context, newSalt()));
      let proven: { raw: string; state: { operation: FirstoBatchOperation; readyAt: number | null } } | null = null;
      const inspect = async (item: FirstoBatchJournal, force?: 'prepared' | 'unscheduled' | 'scheduled' | 'done') => {
        const raw = JSON.stringify(item);
        if (!force && proven?.raw === raw) { session.assertCurrent(); return proven.state; }
        const checked = await session.read(() => preflight(provider, item, session.assertCurrent, force));
        proven = { raw, state: { operation: checked.operation, readyAt: checked.readyAt } }; return proven.state;
      };
      const recover = async (item: FirstoBatchJournal, step: FirstoBatchStep, suppliedHash?: string) => {
        let transaction = step === 'schedule' || step === 'execute' ? item[step]! : item.deployments[step]!;
        const governance = step === 'schedule' || step === 'execute', currentPlan = planFor(item);
        const trusted = returnedHash.current;
        const originalRaw = JSON.stringify(item);
        const returned = trusted?.key === key && trusted.raw === originalRaw && trusted.step === step ? trusted.hash : undefined;
        const data = governance ? currentPlan?.[`${step}Data`]
          : prepareFirstoBatchUpgradeDeployment(step, common, { deploymentsPrefix: confirmedFirstoBatchDeployments(item) }).data;
        if (!data || !same(keccak256(data), transaction.dataHash)) throw new Error('本机原交易与固定升级步骤不同。');
        const expected = { from: transaction.from, dataHash: transaction.dataHash, intent: transaction.intent,
          ...(governance ? { to: currentPlan.timelock, data, operation: step as 'schedule' | 'execute' } : {}) };
        let hash = transaction.txHash || returned || suppliedHash?.trim(), discovered = false;
        if (!hash && transaction.intent) {
          setBusy('自动找回当前交易');
          hash = await session.read(() => discoverFirstoBatchTransaction(provider, expected), 60000) ?? undefined;
          if (!hash) { setMessage('当前交易尚未最终确认，记录已保留。稍后点击“核对当前交易”；不会重新发送。');
            return { journal: item, outcome: 'waiting' as const }; }
          discovered = true;
        }
        if (!hash || !/^0x[\da-f]{64}$/i.test(hash)) throw new Error('请从钱包交易记录复制完整的原交易哈希。');
        if (!same(transaction.from, governance ? proposer : deployer)) throw new Error('原交易发送者与指定钱包不同。');
        if (!transaction.txHash && (returned || discovered)) {
          transaction = { ...transaction, txHash: hash, status: 'submitted' };
          item = session.persist(governance ? { ...item, [step]: transaction }
            : { ...item, deployments: { ...item.deployments, [step]: transaction } });
          returnedHash.current = null; setUnwrittenHash('');
        }
        setBusy('等待当前交易确认');
        const finalized = await session.read(() => waitForFirstoBatchFinality(provider, hash!,
          { assertCurrent: session.assertCurrent, wait: session.wait }), 75000);
        if (!finalized) return { journal: item, outcome: 'waiting' as const };
        let receipt;
        try { receipt = await session.read(() => verifyFirstoBatchRecoveryReceipt(provider, hash!, expected), 30000); }
        catch (problem) {
          if (!(problem instanceof VerifiedFirstoBatchTransactionFailure)) throw problem;
          if (!transaction.txHash && !transaction.intent && !returned) throw new Error('输入的交易已失败，但不能证明它是本次未知发送。请回到原钱包请求或原标签取得带原哈希的记录；当前步骤不会重发。');
          if (!transaction.txHash) {
            transaction = { ...transaction, txHash: hash, status: 'submitted' };
            item = session.persist(governance ? { ...item, [step]: transaction }
              : { ...item, deployments: { ...item.deployments, [step]: transaction } });
          }
          session.assertCurrent(); const archived = session.persist(archiveFirstoBatchFailure(item, step, problem.evidence, context));
          setOperation('unknown'); setRecoveryHash('');
          setMessage('当前交易执行失败，原回执已保存。准备好后点击继续重试这一步。');
          return { journal: archived, outcome: 'failed' as const };
        }
        if (!receipt) return { journal: item, outcome: 'waiting' as const };
        if (!transaction.txHash && !transaction.intent && !returned) throw new Error('输入的交易已确认，但不能证明它是本次未知发送。请回到原钱包请求或原标签取得带原哈希的记录；当前步骤不会继续发送。');
        const confirmed: UpgradeTransaction = { ...transaction, txHash: hash, status: 'confirmed',
          ...(governance ? {} : { address: getAddress(receipt.contractAddress!) }) };
        const candidate = governance ? { ...item, [step]: confirmed } : { ...item, deployments: { ...item.deployments, [step]: confirmed } };
        const checked = await inspect(candidate, firstoBatchRecoveryPhase(step));
        session.assertCurrent(); const saved = session.persist(candidate); setRecoveryHash(''); setUnwrittenHash(''); returnedHash.current = null;
        return { journal: saved, outcome: 'confirmed' as const, readyAt: checked.readyAt };
      };
      const submit = async (item: FirstoBatchJournal, step: FirstoBatchStep) => {
        session.assertCurrent(); const governance = step === 'schedule' || step === 'execute';
        const currentPlan = governance ? planFor(item) : null;
        const prepared = governance ? { data: currentPlan[`${step}Data`] }
          : prepareFirstoBatchUpgradeDeployment(step, common, { deploymentsPrefix: confirmedFirstoBatchDeployments(item) });
        setBusy('准备当前交易');
        const intent = await session.read(() => prepareFirstoBatchIntent(provider, state.address));
        const transaction: UpgradeTransaction = { status: 'uncertain', from: getAddress(state.address), dataHash: keccak256(prepared.data), intent };
        let saved = item;
        const put = (value: UpgradeTransaction) => governance ? { ...item, [step]: value }
          : { ...item, deployments: { ...item.deployments, [step]: value } };
        setBusy(governance ? step === 'schedule' ? '请在钱包中确认等待期排程' : '请在钱包中确认执行升级'
          : `请在钱包中确认第 ${FIRSTO_BATCH_DEPLOYMENTS.indexOf(step as FirstoBatchName) + 1} 笔部署`);
        const guardedWallet = { request: async (request: Parameters<typeof selected.provider.request>[0]) => {
          try { session.assertCurrent(); } catch (problem) { throw Object.assign(problem as Error, { code: 'ACTION_REJECTED' }); }
          if (request.method === 'eth_sendTransaction') {
            try { await session.read(() => assertFirstoBatchIntentCurrent(provider, transaction.from, intent)); }
            catch (problem) { throw Object.assign(problem as Error, { code: 'ACTION_REJECTED' }); }
          }
          return selected.provider.request(request);
        } };
        await submitFirstoBatchUpgrade(guardedWallet, { from: transaction.from, data: prepared.data, intent,
          ...(governance ? { to: currentPlan.timelock } : { gasLimit: gasLimits[step as FirstoBatchName] }) }, {
          beforeRequest: () => { session.assertCurrent(); saved = session.persist(put(transaction)); },
          definitelyRejected: () => { saved = session.persist(item); },
          submitted: hash => { returnedHash.current = { key: key!, raw: JSON.stringify(saved), step, hash };
            try { saved = session.persist(put({ ...transaction, status: 'submitted', txHash: hash })); returnedHash.current = null; if (mounted.current) setUnwrittenHash(''); }
            catch (problem) { if (mounted.current) setUnwrittenHash(hash); throw new Error(`原交易已发送，记录未能保存。请保存此哈希 ${hash}。${messageOf(problem)}`); } },
        });
        proven = null; session.assertCurrent(); return saved;
      };
      const original = firstoBatchPending(source);
      const originalTransaction = original && (original === 'schedule' || original === 'execute' ? source[original] : source.deployments[original]);
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
      const advanced = await runFirstoBatchUpgradeSequence({ journal: source, assertCurrent: session.assertCurrent, inspect, submit, recover });
      if (advanced.outcome === 'unknown') setMessage('钱包没有返回原交易哈希。请回到原钱包请求或原标签等待哈希保存，或取回带原哈希的原记录；页面不会重发。');
      else if (advanced.outcome === 'waiting') setMessage(advanced.journal.schedule?.status === 'confirmed'
        ? '排程已确认。等待 48 小时后，再点击同一按钮执行升级。'
        : '当前交易仍在确认。记录已保存，稍后点击继续即可。');
      else if (advanced.outcome === 'done') setMessage('升级已完成，原矿池升级结果已确认。');
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
      const step = firstoBatchPending(source);
      if (!step || !FIRSTO_BATCH_DEPLOYMENTS.includes(step as FirstoBatchName)) throw new Error('只能恢复旧的合约部署步骤。');
      const original = source.deployments[step as FirstoBatchName]!;
      const prepared = prepareFirstoBatchUpgradeDeployment(step, common, { deploymentsPrefix: confirmedFirstoBatchDeployments(source) });
      if (!same(original.from, deployer) || !same(original.dataHash, keccak256(prepared.data)))
        throw new Error('旧未知记录的发送者或部署字节码与固定候选不同，原记录已保留。');
      await session.read(() => preflight(provider, source, session.assertCurrent, 'prepared'));
      const observedIntent = await session.read(() => prepareFirstoBatchIntent(provider, state.address));
      const candidate = archiveLegacyFirstoBatchDeployment(source, context, {
        step: step as FirstoBatchName, acknowledged: true, checkedAt: new Date().toISOString(), currentIntent: observedIntent,
      });
      session.assertCurrent(); session.persist(candidate); setClosedOldRequest(false); setRecoveryHash('');
      setOperation('unknown'); setMessage('旧未知记录已完整保留，部署流程已恢复。本次没有发送交易；点击“继续升级”发起新的部署请求。');
    });
  }); }
  async function importJournal(file: File) { await run('恢复升级记录', async session => {
    if (!context) throw new Error('升级文件尚未就绪。');
    const imported = await parseFirstoBatchImportFile(file, context); session.assertCurrent();
    await session.lock(async existing => {
      if (existing) {
        const step = firstoBatchPending(existing), governance = step === 'schedule' || step === 'execute';
        if (!step) throw new Error('本机已有完整记录，不能覆盖。');
        const original = governance ? existing[step]! : existing.deployments[step]!;
        const replacement = governance ? imported[step]! : imported.deployments[step]!;
        const restored = governance ? { ...imported, [step]: original }
          : { ...imported, deployments: { ...imported.deployments, [step]: original } };
        if (!original.intent || original.txHash || !replacement?.txHash
          || canonical(restored) !== canonical(existing)
          || canonical({ ...replacement, status: original.status, txHash: undefined, address: undefined }) !== canonical(original))
          throw new Error('恢复文件不能证明是本次发送，或包含不同进度；原记录已保留。');
        const selected = walletRef.current ?? wallets[0]; if (!selected) throw new Error('请先连接原部署钱包。');
        walletRef.current = selected; setWallet(selected); session.bindWallet(selected);
        const state = await session.read(() => readWallet(selected.provider));
        if (!state || state.chainId !== 56 || !same(state.address, original.from)) throw new Error('请连接原部署钱包并切换 BSC 主网。');
        const provider = recoveryProvider(session, selected), currentPlan = planFor(existing);
        const data = governance ? currentPlan?.[`${step}Data`] : undefined;
        const expected = { from: original.from, dataHash: original.dataHash, intent: original.intent,
          ...(governance ? { to: currentPlan.timelock, data, operation: step as 'schedule' | 'execute' } : {}) };
        try {
          const receipt = await session.read(() => verifyFirstoBatchRecoveryReceipt(provider, replacement.txHash!, expected));
          if (!receipt) throw new Error('原交易尚未最终确认，记录未合并。');
        } catch (problem) { if (!(problem instanceof VerifiedFirstoBatchTransactionFailure)) throw problem; }
        const submitted = { ...original, status: 'submitted' as const, txHash: replacement.txHash };
        session.persist(governance ? { ...existing, [step]: submitted }
          : { ...existing, deployments: { ...existing.deployments, [step]: submitted } });
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
      await session.read(() => preflight(provider, imported, session.assertCurrent));
      session.assertCurrent(); session.persist(imported); setMessage('记录已恢复，点击继续即可。');
    });
  }); }
  function exportRecord() { if (!journal) return; download('bemine-firsto-batch-upgrade-record.json', {
    schemaVersion: 1, kind: 'fixed-firsto-batch-upgrade-wallet-record-v1', exportedAt: new Date().toISOString(),
    release, journal, plan: plan?.invalid ? null : plan, preflight: proof, postUpgradeProof: result,
    deploymentComplete: completed === 2, activated: !!result && operation === 'done', firstoBatchPurchaseActivated: !!result && operation === 'done' }); }
  function selectWallet(id: string) {
    const option = wallets.find(item => item.id === id); if (!option || option.provider === walletRef.current?.provider) return;
    stop(); setClosedOldRequest(false); walletRef.current = option; setWallet(option); setWalletState(null);
  }
  const done = !!result && operation === 'done', scheduled = journal?.schedule?.status === 'confirmed';
  const stateLabel = done ? '升级已完成' : operation === 'waiting' ? '等待 48 小时'
    : operation === 'ready' ? '等待期已结束，可以执行升级' : canResumeLegacyDeployment ? '旧部署记录需要恢复' : pending ? '当前交易待确认'
      : scheduled ? '排程已确认，继续时自动检查等待期' : completed ? `部署进度 ${completed} / 2` : '准备就绪后，点击下方按钮开始';
  return <main className="to-shell">
    <div className="to-top"><span className="to-mark">BEMINE / 合约升级</span><span className="to-status">BSC 主网</span></div>
    <h1>Firsto 批量采购合约升级</h1>
    <p className="to-lead">连接部署钱包后，按提示确认两笔部署和一笔排程；等待 48 小时，再回来确认正式升级。</p>
    <section className="to-card to-main">
      <ol className="to-steps" aria-label="升级进度">
        <li className={completed === 2 ? 'to-complete' : 'to-current'}><span>1</span><div>部署升级组件<small>{completed} / 2 已确认</small></div></li>
        <li className={done ? 'to-complete' : scheduled ? 'to-current' : ''}><span>2</span><div>等待 48 小时<small>{scheduled ? '排程已确认' : '部署后自动排程'}</small></div></li>
        <li className={done ? 'to-complete' : operation === 'ready' ? 'to-current' : ''}><span>3</span><div>完成升级<small>{done ? '结果已确认' : '等待期后钱包确认'}</small></div></li>
      </ol>
      <h2 className="to-state" data-testid="activation-state">{stateLabel}</h2>
      {readyAt && <p>最早执行时间：{new Date(readyAt * 1000).toLocaleString('zh-CN')}</p>}
      {(loadError || error) && <p role="alert" className="to-note to-error">{loadError || error}</p>}
      {message && <p role="status" className="to-note">{message}</p>}
      {wallets.length > 1 && <label className="to-wallet">选择钱包<select aria-label="选择钱包" value={wallet?.id ?? wallets[0]?.id ?? ''} disabled={!!busy}
        onChange={event => selectWallet(event.target.value)}>{wallets.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>}
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
    <details className="to-card to-details"><summary>技术信息与记录恢复</summary>
      <p className="to-small">每次钱包提交前自动检查正式部署与当前角色。已提交交易只读取原回执；确认后核对准确代码和依赖。</p>
      {common && <dl className="to-meta"><dt>原 Factory</dt><dd><code>{context?.factory}</code></dd><dt>原 Beacon</dt><dd><code>{reviewedCatalog?.bindings?.beacon}</code></dd>
        <dt>原 Timelock</dt><dd><code>{reviewedCatalog?.bindings?.timelock}</code></dd><dt>部署 / 执行钱包</dt><dd><code>{deployer}</code></dd>
        <dt>候选摘要</dt><dd><code>{release.pins.trustedUpgradeArtifactDigest}</code></dd>

        {plan && !plan.invalid && <><dt>操作 ID</dt><dd><code>{plan.operationId}</code></dd></>}
        {proof && <><dt>核验区块</dt><dd>#{proof.blockNumber} <code>{proof.blockHash}</code></dd></>}
      </dl>}
      {FIRSTO_BATCH_DEPLOYMENTS.map(name => { const transaction = journal?.deployments[name]; return <div className="to-technical-row" key={name}>
        <strong>{name}</strong><span>{transaction?.status === 'confirmed' ? '已确认' : transaction ? '待确认' : '尚未部署'}</span>
        {transaction?.address && <code>{transaction.address}</code>}
        {transaction?.txHash && <a href={`${explorer}/tx/${transaction.txHash}`} target="_blank" rel="noreferrer">查看原交易</a>}
      </div>; })}
      {journal?.schedule?.txHash && <p><a href={`${explorer}/tx/${journal.schedule.txHash}`} target="_blank" rel="noreferrer">查看排程原交易</a></p>}
      {journal?.execute?.txHash && <p><a href={`${explorer}/tx/${journal.execute.txHash}`} target="_blank" rel="noreferrer">查看执行原交易</a></p>}
      {!!journal?.failedTransactions?.length && <p className="to-small">已保留 {journal.failedTransactions.length} 笔最终失败回执。</p>}
      {!!journal?.abandonedUnknownDeployments?.length && <p className="to-small">已保留 {journal.abandonedUnknownDeployments.length} 条用户放弃关联的旧部署记录，原发送结果仍未知。</p>}
      <div className="to-actions"><button disabled={!journal || !!busy} onClick={exportRecord}>导出记录</button>
        <label className="to-import">导入恢复记录<input type="file" accept="application/json,.json" disabled={!!busy || !common}
          onChange={event => { const file = event.target.files?.[0]; if (file) void importJournal(file); event.target.value = ''; }}/></label></div>
      <p className="to-small">本页仅升级 Firsto 批量卖单中指定矿机叶子的采购能力。既有核心升级与预算矿池排程保留；预算项目批量采购不在本次范围内。</p>
      <a className="to-small" href={release.files.liveReview.path} target="_blank" rel="noreferrer">发布前只读证据</a>
      <p className="to-footer">页面源码 {short(release.sourceCommit)} · 候选源码 {short(release.candidateSourceCommit)}</p>
    </details>
  </main>;
}
createRoot(document.getElementById('root')!).render(<FirstoBatchUpgradeStandalone/>);
