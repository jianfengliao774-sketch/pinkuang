import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getAddress } from 'ethers';
import trustedGenesisManifest from '../../web/public/data/frontend-manifest.json';
import { artifactDigest, validateArtifacts, type ArtifactBundle, type DeploymentSnapshot } from './deployment';
import FreshActiveUpgradeConsole from './FreshActiveUpgradeConsole';
import { assertTrustedGenesis } from './upgrade-ui';
import { discoverWallets, messageOf, readWallet, switchToBsc, type WalletOption, type WalletState } from './wallet';
import './styles.css';

declare const __DEPLOYMENT_ARTIFACT_DIGEST__: string;

const MAX_JSON_BYTES = 8_000_000;
const GENESIS_RECORD_SHA256 = 'c586195408f65730ff8409126a7aea95dc48b9af62daba36f2201065c1c53ae0';
const GENESIS_ARTIFACT_SHA256 = 'b24082514df9d7a37f57af0e8c0cf644d42446c95b88eb1961837ea76a08bebc';
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

async function pinnedJson<T>(name: string, expectedSha256: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`${import.meta.env.BASE_URL}upgrade-genesis/${name}`, {
    signal, cache: 'no-store', redirect: 'error', credentials: 'same-origin',
  });
  if (!response.ok || !/\bapplication\/json\b/i.test(response.headers.get('content-type') || '')) {
    throw new Error(`已固定的旧版文件 ${name} 不可用。`);
  }
  const body = await response.arrayBuffer();
  if (!body.byteLength || body.byteLength > MAX_JSON_BYTES || !crypto.subtle) {
    throw new Error(`已固定的旧版文件 ${name} 无法安全核验。`);
  }
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', body)), byte =>
    byte.toString(16).padStart(2, '0')).join('');
  if (hash !== expectedSha256) throw new Error(`已固定的旧版文件 ${name} 摘要不符。`);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as T;
}

async function readCandidate(signal: AbortSignal): Promise<ArtifactBundle> {
  const response = await fetch(`${import.meta.env.BASE_URL}deployment-artifacts.json`, {
    signal, cache: 'no-store', redirect: 'error', credentials: 'same-origin',
  });
  if (!response.ok || !/\bapplication\/json\b/i.test(response.headers.get('content-type') || '')) {
    throw new Error('候选编译产物未从本站静态发布包加载。');
  }
  const body = await response.arrayBuffer();
  if (!body.byteLength || body.byteLength > MAX_JSON_BYTES) throw new Error('候选编译产物大小异常。');
  const bundle = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as ArtifactBundle;
  validateArtifacts(bundle);
  if (!same(artifactDigest(bundle), __DEPLOYMENT_ARTIFACT_DIGEST__)) {
    throw new Error('候选产物与本页独立编译摘要不一致。');
  }
  if (same(artifactDigest(bundle), trustedGenesisManifest.artifactDigest)) {
    throw new Error('候选产物仍是旧版，不能作为升级实现。');
  }
  return bundle;
}

async function readGenesisRecord(file: File): Promise<DeploymentSnapshot> {
  if (!file.size || file.size > MAX_JSON_BYTES) throw new Error('旧部署记录为空或超过 8 MB。');
  const record = JSON.parse(await file.text()) as DeploymentSnapshot;
  if (!record || typeof record !== 'object' || record.kind !== 'integrated-v2'
    || typeof record.id !== 'string' || typeof record.addresses?.factory !== 'string'
    || typeof record.artifactDigest !== 'string') {
    throw new Error('请选择完整的旧版 integrated-v2 部署记录。');
  }
  return record;
}

function UpgradeStandalone() {
  const [candidate, setCandidate] = useState<ArtifactBundle | null>(null);
  const [candidateError, setCandidateError] = useState('');
  const [record, setRecord] = useState<DeploymentSnapshot | null>(null);
  const [recordError, setRecordError] = useState('');
  const [genesisBundle, setGenesisBundle] = useState<ArtifactBundle | null>(null);
  const [genesisError, setGenesisError] = useState('');
  const manualRecordChosen = useRef(false);
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [selected, setSelected] = useState<WalletOption | null>(null);
  const [walletState, setWalletState] = useState<WalletState | null>(null);
  const [walletError, setWalletError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void readCandidate(controller.signal).then(setCandidate).catch(error => {
      if (!controller.signal.aborted) setCandidateError(messageOf(error));
    });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      pinnedJson<DeploymentSnapshot>('genesis-record.json', GENESIS_RECORD_SHA256, controller.signal),
      pinnedJson<ArtifactBundle>('genesis-artifacts.json', GENESIS_ARTIFACT_SHA256, controller.signal),
    ]).then(([trustedRecord, trustedBundle]) => {
      assertTrustedGenesis(trustedRecord, trustedBundle, trustedGenesisManifest as never);
      if (!controller.signal.aborted) {
        setGenesisBundle(trustedBundle);
        if (!manualRecordChosen.current) setRecord(trustedRecord);
      }
    }).catch(error => {
      if (!controller.signal.aborted) setGenesisError(messageOf(error));
    });
    return () => controller.abort();
  }, []);
  useEffect(() => discoverWallets(setWallets), []);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    const refresh = () => {
      void readWallet(selected.provider).then(state => {
        if (active) setWalletState(state ? { ...state, address: getAddress(state.address) } : null);
      }).catch(error => {
        if (active) { setWalletState(null); setWalletError(messageOf(error)); }
      });
    };
    const disconnect = () => { if (active) setWalletState(null); };
    selected.provider.on?.('accountsChanged', refresh);
    selected.provider.on?.('chainChanged', refresh);
    selected.provider.on?.('disconnect', disconnect);
    return () => {
      active = false;
      selected.provider.removeListener?.('accountsChanged', refresh);
      selected.provider.removeListener?.('chainChanged', refresh);
      selected.provider.removeListener?.('disconnect', disconnect);
    };
  }, [selected]);

  async function connect(option: WalletOption) {
    setWalletError(''); setWalletState(null);
    try {
      const accounts = await option.provider.request({ method: 'eth_requestAccounts' }) as string[];
      if (!Array.isArray(accounts) || !accounts[0]) throw new Error('钱包未返回账户。');
      const state = await readWallet(option.provider);
      if (!state || getAddress(state.address) !== getAddress(accounts[0])) {
        throw new Error('钱包选择的账户已变化，请重新连接。');
      }
      setSelected(option);
      setWalletState({ ...state, address: getAddress(state.address) });
    } catch (error) { setSelected(null); setWalletError(messageOf(error)); }
  }

  async function changeChain() {
    if (!selected) return;
    setWalletError('');
    try {
      await switchToBsc(selected.provider);
      const state = await readWallet(selected.provider);
      setWalletState(state ? { ...state, address: getAddress(state.address) } : null);
    } catch (error) { setWalletError(messageOf(error)); }
  }

  return <main className="upgrade-standalone">
    <header><div><h1>拼矿正式合约升级</h1><p>正式 v5 · BSC 主网 · 每笔交易由连接的钱包确认</p></div>
      <a href="https://bemine.cc.cd/">返回拼矿主页</a></header>
    <section className="card upgrade-entry">
      <h2>当前正式部署与钱包</h2>
      <p>本页内嵌已发布的旧版合约清单，并对本站提供的旧记录与旧产物逐字节核验。所有文件只在浏览器本机读取；链上状态仍须在下方第一步重新核验。</p>
      <div className="upgrade-entry-status">已发布旧图摘要：<span className="mono">{trustedGenesisManifest.artifactDigest}</span></div>
      <div className="upgrade-entry-status">候选编译产物：<span className="mono">{candidate ? artifactDigest(candidate) : candidateError || '读取中…'}</span></div>
      <div className="upgrade-entry-status">旧版记录与产物：{genesisBundle ? '固定 SHA-256 与已发布清单通过；链上核验待执行。'
        : genesisError || '正在核验固定文件…'}</div>
      <div className="upgrade-entry-grid">
        <div><label htmlFor="genesis-record">旧版完整部署记录 JSON（可自行改选）</label>
          <input id="genesis-record" type="file" accept=".json,application/json" onChange={event => {
            const file = event.target.files?.[0];
            if (!file) return;
            manualRecordChosen.current = true;
            setRecord(null); setRecordError('');
            void readGenesisRecord(file).then(setRecord).catch(error => setRecordError(messageOf(error)));
          }}/>
          <p className="upgrade-entry-status">{record ? `已读取记录 ${record.id}；仍须核验链上状态。` : '固定记录不可用时，可选择从原部署台导出的完整记录。'}</p>
          {recordError && <p role="alert" className="upgrade-entry-error">{recordError}</p>}
        </div>
        <div id="upgrade-wallets"><label>连接当前步骤的钱包</label>
          <p>部署新实现时连接部署钱包；提交升级提案时连接拥有当前 Timelock 提案权限的钱包。现有管理员与 Gas 钱包沿用。本站不接收私钥。</p>
          {wallets.length ? wallets.map(option => <button key={option.id} onClick={() => void connect(option)}>
            连接 {option.name}</button>) : <p className="upgrade-entry-status">未发现浏览器钱包；请先打开支持硬件钱包的扩展。</p>}
          {walletState && <p className="upgrade-entry-status">当前账户 <span className="mono">{walletState.address}</span> · {walletState.chainId === 56 ? 'BSC 主网' : `当前链 ${walletState.chainId}`}</p>}
          {walletState && walletState.chainId !== 56 && <button onClick={() => void changeChain()}>切换到 BSC 主网</button>}
          {walletError && <p role="alert" className="upgrade-entry-error">{walletError}</p>}
        </div>
      </div>
    </section>
    {candidate ? <FreshActiveUpgradeConsole wallet={selected?.provider || null} account={walletState?.address || null}
      chainId={walletState?.chainId || null} currentBundle={candidate} currentRecord={record}
      initialGenesisBundle={genesisBundle}
      onConnect={() => document.getElementById('upgrade-wallets')?.scrollIntoView({ behavior: 'smooth' })}/>
      : <section className="card upgrade-entry" role={candidateError ? 'alert' : 'status'}>{candidateError || '正在验证候选产物…'}</section>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<UpgradeStandalone />);
