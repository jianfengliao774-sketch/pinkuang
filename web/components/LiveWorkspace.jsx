'use client';
import { displayAmount } from '../lib/amount-display.mjs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatEther, formatUnits, getAddress, ZeroAddress } from 'ethers';
import { ArrowLeft, ArrowUpRight, CheckCircle2, CircleAlert, RefreshCw, Wallet } from 'lucide-react';
import BrandMark from './BrandMark';
import LiveGovernance from './LiveGovernance';
import LiveMarket from './LiveMarket';
import { hasPosition, readPoolSnapshot } from '../lib/chain-client.mjs';
import { abandonPreparedIntent, cancelLiveIntent, connectLiveWallet, indexPage, liveConfig, liveIntent, liveSession, recoverLiveHash, sendLiveGovernanceAction, sendLiveMarketAction, sendLivePoolAction } from '../lib/live-client.mjs';

const base = process.env.NEXT_PUBLIC_BASE_PATH || '';
const short = value => value ? `${value.slice(0, 8)}…${value.slice(-6)}` : '—';
const display = (value, decimals = 18) => value === null || value === undefined ? '未知' : displayAmount(value, decimals);
const stateName = state => ({ 0: '募集中', 1: '待购机', 2: '运行中', 3: '整机出售中', 4: '已关闭', 5: '退款中' })[String(state)] ?? '未知';
const message = error => error?.shortMessage || error?.message || '请求未完成。';

export default function LiveWorkspace() {
  const [config, setConfig] = useState(null);
  const [account, setAccount] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [rows, setRows] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [source, setSource] = useState(null);
  const [block, setBlock] = useState(null);
  const [pending, setPending] = useState(null);
  const [history, setHistory] = useState([]);
  const [quantity, setQuantity] = useState({});
  const [recoveryHash, setRecoveryHash] = useState('');
  const [phase, setPhase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const refreshGeneration = useRef(0);

  const refresh = useCallback(async (currentConfig = config, currentAccount = account, nextCursor = null) => {
    if (!currentConfig) return;
    const generation = ++refreshGeneration.current;
    const wallet = typeof window !== 'undefined' ? window.ethereum : null;
    const index = await indexPage(currentConfig, `/v1/pools?limit=20${nextCursor === null ? '' : `&cursor=${nextCursor}`}`);
    const entries = index.data?.items;
    if (!Array.isArray(entries)) throw new Error('Server pool index returned no verifiable entries.');
    let accountPools = [];
    if (currentAccount && nextCursor === null) {
      let historyCursor = 0;
      for (let page = 0; page < 20; page++) {
        const oldPositions = await indexPage(currentConfig, `/v1/accounts/${currentAccount}/pools?limit=50&cursor=${historyCursor}`);
        accountPools.push(...(oldPositions.data?.items ?? []));
        if (oldPositions.data?.nextCursor === null) { historyCursor = null; break; }
        historyCursor = oldPositions.data?.nextCursor;
        if (!Number.isSafeInteger(historyCursor) || historyCursor < 0) throw new Error('服务器历史资产游标无效。');
      }
      if (historyCursor !== null) throw new Error('历史权益超过单次读取上限，已停止显示不完整持仓。');
    }
    const visibleEntries = nextCursor === null ? entries : [...catalog, ...entries];
    const historicalAddresses = nextCursor === null ? [] : rows
      .filter(row => !visibleEntries.some(item => item.address.toLowerCase() === row.pool.toLowerCase())).map(row => row.pool);
    const addresses = [...new Set([...visibleEntries.map(item => getAddress(item.address)),
      ...accountPools.map(getAddress), ...historicalAddresses.map(getAddress)])];
    let snapshotRows = [], readBlock = null;
    if (wallet && addresses.length) {
      const chain = BigInt(await wallet.request({ method: 'eth_chainId' }));
      if (chain !== 56n) throw new Error('钱包不在 BSC 主网，请切换到 Chain ID 56 后刷新。');
      for (let offset = 0; offset < addresses.length; offset += 20) {
        const snapshot = await readPoolSnapshot(wallet, { factory: currentConfig.factory, account: currentAccount ?? ZeroAddress,
          pools: addresses.slice(offset, offset + 20), blockNumber: readBlock?.number });
        if (getAddress(snapshot.lens) !== getAddress(currentConfig.lens) || readBlock && snapshot.blockHash !== readBlock.hash) {
          throw new Error('合约身份或分页区块发生变化，请重新读取。');
        }
        readBlock = { number: snapshot.blockNumber, hash: snapshot.blockHash, timestamp: snapshot.timestamp };
        snapshotRows.push(...snapshot.pools);
      }
    }
    const saved = currentAccount ? await liveIntent(currentAccount) : null;
    if (currentAccount && wallet) {
      const selected = await wallet.request({ method: 'eth_accounts' });
      if (!Array.isArray(selected) || !selected[0] || getAddress(selected[0]) !== getAddress(currentAccount) ||
          BigInt(await wallet.request({ method: 'eth_chainId' })) !== 56n) {
        throw new Error('钱包账户或网络已变化，请重新连接。');
      }
    }
    if (generation !== refreshGeneration.current) return;
    setPending(saved?.intent ?? null);
    setHistory(saved?.history ?? []);
    setSource(index.source);
    setBlock(readBlock);
    setCatalog(visibleEntries);
    setRows(snapshotRows);
    setCursor(index.data.nextCursor);
    setNotice('已从服务器索引和链上刷新。');
  }, [config, account, catalog, rows]);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      try {
        const next = await liveConfig();
        if (cancelled) return;
        setConfig(next);
        await refresh(next, null); // Read public data first; session authentication is explicit.
      } catch (problem) { if (!cancelled) setError(message(problem)); }
    }
    void start();
    return () => { cancelled = true; };
  }, []); // Initial configuration only; wallet changes are handled by listeners below.

  useEffect(() => {
    const wallet = typeof window !== 'undefined' ? window.ethereum : null;
    if (!wallet?.on) return;
    const reset = () => { refreshGeneration.current++; setAccount(null); setPending(null); setHistory([]);
      setRows([]); setBlock(null); setNotice(''); setError('钱包账户或网络已变化，请重新连接。'); };
    wallet.on('accountsChanged', reset); wallet.on('chainChanged', reset);
    return () => { wallet.removeListener?.('accountsChanged', reset); wallet.removeListener?.('chainChanged', reset); };
  }, []);

  useEffect(() => {
    if (!pending?.active || !account || !config) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void liveIntent(account).then(saved => {
        if (cancelled) return;
        setPending(saved.intent); setHistory(saved.history ?? []);
        if (saved.intent && !saved.intent.active) void refresh(config, account).catch(problem => setError(message(problem)));
      }).catch(problem => { if (!cancelled) setError(message(problem)); });
    }, 10000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [pending?.active, account, config, refresh]);

  async function connect() {
    setBusy(true); setError(''); setNotice('');
    try {
      const wallet = window.ethereum;
      const selected = await connectLiveWallet(wallet);
      await liveSession(wallet, selected);
      setAccount(selected);
      await refresh(config, selected);
    } catch (problem) { setError(message(problem)); }
    finally { setBusy(false); }
  }

  async function reload(nextCursor = null) {
    setBusy(true); setError(''); setNotice('');
    try { await refresh(config, account, nextCursor); }
    catch (problem) { setError(message(problem)); }
    finally { setBusy(false); }
  }

  async function send(pool, action) {
    setBusy(true); setError(''); setNotice('');
    try {
      if (!account) throw new Error('请先连接钱包并登录服务器交易记录。');
      await liveSession(window.ethereum, account);
      const saved = await sendLivePoolAction({ wallet: window.ethereum, config, account, pool, action,
        quantity: action === 'deposit' ? quantity[pool] || '1' : undefined, onState: setPhase });
      setPending(saved);
      await refresh(config, account);
      setNotice(`交易哈希已保存到服务器：${saved.hashes.at(-1)}。等待最终确认后再操作。`);
    } catch (problem) { setError(message(problem)); try { setPending((await liveIntent(account)).intent); } catch {} }
    finally { setBusy(false); setPhase(''); }
  }

  async function sendMarket(action) {
    setBusy(true); setError(''); setNotice('');
    try {
      if (!account) throw new Error('请先连接钱包并登录服务器交易记录。');
      await liveSession(window.ethereum, account);
      const saved = await sendLiveMarketAction({ wallet: window.ethereum, config, account, action, onState: setPhase });
      setPending(saved);
      await refresh(config, account);
      setNotice(`市场交易哈希已保存到服务器：${saved.hashes.at(-1)}。等待最终确认后再操作。`);
      return saved;
    } catch (problem) { setError(message(problem)); try { setPending((await liveIntent(account)).intent); } catch {} throw problem; }
    finally { setBusy(false); setPhase(''); }
  }

  async function sendGovernance(pool, action) {
    setBusy(true); setError(''); setNotice('');
    try {
      if (!account) throw new Error('请先连接钱包并登录服务器交易记录。');
      await liveSession(window.ethereum, account);
      const saved = await sendLiveGovernanceAction({ wallet: window.ethereum, config, account, pool, action, onState: setPhase });
      setPending(saved);
      await refresh(config, account);
      setNotice(`治理交易哈希已保存到服务器：${saved.hashes.at(-1)}。等待最终确认后再操作。`);
      return saved;
    } catch (problem) { setError(message(problem)); try { setPending((await liveIntent(account)).intent); } catch {} throw problem; }
    finally { setBusy(false); setPhase(''); }
  }

  async function recover() {
    setBusy(true); setError(''); setNotice('');
    try {
      if (!pending?.id || !account) throw new Error('没有待核对的服务器交易意图。');
      const result = await recoverLiveHash(account, pending.id, recoveryHash.trim());
      setPending(result.intent); setRecoveryHash('');
      await reload();
    } catch (problem) { setError(message(problem)); }
    finally { setBusy(false); }
  }

  async function cancelPending() {
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = await cancelLiveIntent({ wallet: window.ethereum, account, intent: pending });
      setPending(saved); await reload();
    } catch (problem) { setError(message(problem)); }
    finally { setBusy(false); }
  }

  async function abandonPending() {
    setBusy(true); setError(''); setNotice('');
    try {
      if (!account) throw new Error('请先连接原钱包。');
      const result = await abandonPreparedIntent(account, pending);
      setPending(result.intent); await reload();
    } catch (problem) { setError(message(problem)); }
    finally { setBusy(false); }
  }

  const byPool = new Map(rows.map(row => [row.pool.toLowerCase(), row]));
  const entries = catalog.map(item => ({ ...item, row: byPool.get(item.address.toLowerCase()) }));
  const historical = rows.filter(row => !catalog.some(item => item.address.toLowerCase() === row.pool.toLowerCase()) && hasPosition(row));
  const all = [...entries, ...historical.map(row => ({ address: row.pool, collection: row.params?.circuits, circuitId: row.params?.circuitId, row }))];

  return <div className="live-shell">
    <header className="live-header"><a className="live-brand" href={`${base}/`}><BrandMark/><span>拼矿 <small>BEMine</small></span></a><div><a href={`${base}/`}><ArrowLeft size={16}/>返回设计预览</a><span className="live-real-badge">BSC 链上工作台</span></div></header>
    <main className="live-main"><div className="live-title"><div><p className="eyebrow">BEMINE / ON-CHAIN</p><h1>真实矿池与个人权益</h1><p>服务器保存交易意图与已确认历史；金额和可操作状态每次从合约重新读取。演示项目不会出现在这里。</p></div><button className="live-primary" disabled={!config || busy} onClick={account ? () => reload() : connect}>{busy ? phase || '处理中…' : account ? <><RefreshCw size={16}/>刷新链上数据</> : <><Wallet size={16}/>连接钱包</>}</button></div>
      {error && <div className="live-alert" role="alert"><CircleAlert size={18}/>{error}</div>}
      {notice && <div className="live-note" role="status"><CheckCircle2 size={17}/>{notice}</div>}
      {!config && <section className="live-empty"><h2>真实服务尚未就绪</h2><p>需要先验收 BSC Factory 部署地址，启动服务器交易记录和事件索引。当前页面不会使用演示地址发送交易。</p></section>}
      {config && <><section className="live-identities"><div><span>网络</span><strong>BSC 主网 · 56</strong></div><div><span>已验收 Factory</span><strong title={config.factory}>{short(config.factory)}</strong></div><div><span>服务器索引</span><strong>{source?.complete ? `已核至 #${source.indexedThrough}` : '等待完整同步'}</strong></div><div><span>链上读取</span><strong>{block ? `#${block.number}` : '等待钱包提供 RPC'}</strong></div><div><span>当前钱包</span><strong title={account || ''}>{short(account)}</strong></div></section>
        {pending?.active && <section className="live-pending"><div><h2>待确认交易 · nonce {pending.nonce}</h2><p>{pending.action} · {short(pending.pool)} · {pending.status}。{pending.status === 'prepared' ? '服务器已保存准备记录，但尚未允许钱包签名，可直接放弃。' : '结果未知时不会重发；可从钱包复制原交易、加速或取消交易哈希进行核对。'}</p>{pending.hashes.map(hash => <a key={hash} href={`https://bscscan.com/tx/${hash}`} target="_blank" rel="noreferrer">{short(hash)}<ArrowUpRight size={13}/></a>)}<div>{pending.status === 'prepared' ? <><button className="live-cancel" disabled={busy} onClick={abandonPending}>放弃未签名意图</button><small>此状态尚未请求钱包发交易，无需支付 Gas。</small></> : <><button className="live-cancel" disabled={busy} onClick={cancelPending}>用同 nonce 发送 0 BNB 自转取消</button><small>需钱包确认并支付 Gas；只有取消交易最终确认，旧意图才会解除。</small></>}</div></div>{pending.status !== 'prepared' && <div className="live-recovery"><input value={recoveryHash} onChange={event => setRecoveryHash(event.target.value)} placeholder="0x…交易哈希" aria-label="待确认交易哈希"/><button disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash.trim())} onClick={recover}>补录并核对</button></div>}</section>}
        <section className="live-section"><div className="live-section-head"><div><h2>服务器登记的矿池</h2><p>同一 NFT 可能有多个历史池；以 Factory + 池地址识别。未知字段不会显示为零。</p></div><span>{all.length} 个已读取池</span></div>
          {!all.length && <div className="live-empty"><p>{source?.complete ? '当前索引没有矿池。' : '正在等待服务器索引和钱包读取。'}</p></div>}
          <div className="live-grid">{all.map(item => {
            const row = item.row, pool = item.address, remaining = row?.totalSupply === null || row?.totalSupply === undefined ? null : 100n - row.totalSupply;
            const canFund = !!row?.trusted && row.state === 0n && row.depositPaused === false && row.params && row.unitPriceWei !== null && remaining > 0n && block && block.timestamp < row.params.fundingDeadline;
            const disabled = busy || !account || !!pending?.active || !row?.trusted;
            return <article className="live-pool" key={pool}><div className="live-pool-top"><span>{stateName(row?.state)}</span><a href={`https://bscscan.com/address/${pool}`} target="_blank" rel="noreferrer">{short(pool)}<ArrowUpRight size={13}/></a></div><h3>矿机 #{String(row?.params?.circuitId ?? item.circuitId ?? '未知')}</h3><p className="live-subline">NFT {short(row?.params?.circuits ?? item.collection)} · 池地址 {short(pool)}</p>
              <div className="live-values"><div><span>已募集</span><strong>{row?.totalSupply === null || row?.totalSupply === undefined ? '未知' : `${row.totalSupply}/100 份`}</strong></div><div><span>每份金额</span><strong>{display(row?.unitPriceWei)} BNB</strong></div><div><span>我的份额</span><strong>{display(row?.shares, 0)}</strong></div><div><span>已入账可领</span><strong>{display(row?.claimableBEM, 8)} BEM</strong></div><div><span>池内待领</span><strong>{display(row?.bnbOwed)} BNB</strong></div><div><span>锁定份额</span><strong>{display(row?.lockedShares, 0)}</strong></div></div>
              {!row?.trusted && <p className="live-warning">池身份或 Lens 字段未通过链上核验，操作已停用。</p>}
              <div className="live-actions"><label>认购份额<input type="number" min="1" max={remaining === null ? 100 : Number(remaining)} step="1" value={quantity[pool] ?? '1'} onChange={event => setQuantity(current => ({ ...current, [pool]: event.target.value }))}/></label><button disabled={disabled || !canFund || !/^(?:[1-9]|[1-9]\d|100)$/.test(quantity[pool] ?? '1') || BigInt(quantity[pool] ?? '1') > remaining} onClick={() => send(pool, 'deposit')}>认购</button><button disabled={disabled || row?.state !== 0n || !(row?.shares > 0n)} onClick={() => send(pool, 'withdrawDeposit')}>撤回认购</button><button disabled={disabled || ![2n, 3n].includes(row?.state)} onClick={() => send(pool, 'harvest')}>归集收益</button><button disabled={disabled || !(row?.claimableBEM > 0n)} onClick={() => send(pool, 'claim')}>领取 BEM</button><button disabled={disabled || !(row?.bnbOwed > 0n)} onClick={() => send(pool, 'withdrawBnb')}>领取池内 BNB</button></div>
            </article>;
          })}</div>
          {cursor !== null && <button className="live-more" disabled={busy} onClick={() => reload(cursor)}>读取下一页</button>}
        </section>
        <LiveMarket config={config} account={account} wallet={typeof window !== 'undefined' ? window.ethereum : null}
          disabled={busy || !!pending?.active} onAction={sendMarket} onConnect={connect} onError={problem => setError(message(problem))}/>
        <LiveGovernance config={config} account={account} wallet={typeof window !== 'undefined' ? window.ethereum : null}
          pools={all.map(item => item.address)} disabled={busy || !!pending?.active} onAction={sendGovernance}
          onConnect={connect} onError={problem => setError(message(problem))}/>
        {!!history.length && <section className="live-section"><h2>本钱包近期交易意图</h2><div className="live-history">{history.map(item => <div key={item.id}><span>{item.action} · {short(item.pool)}</span><strong>{item.status}</strong>{item.completedHash && <a href={`https://bscscan.com/tx/${item.completedHash}`} target="_blank" rel="noreferrer">查看交易<ArrowUpRight size={13}/></a>}</div>)}</div></section>}
      </>}
    </main>
  </div>;
}
