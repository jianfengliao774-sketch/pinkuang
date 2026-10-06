import { useCallback, useEffect, useState } from 'react';
import { BrowserProvider, JsonRpcProvider } from 'ethers';
import { ArrowUpRight, Check, RefreshCw, ShieldCheck } from 'lucide-react';
import { assertLegacyCutoverReady, LEGACY_FACTORY, legacyPauseData, readLegacyCutover, type LegacyCutoverStatus } from './legacy-cutover';
import { messageOf, type WalletProvider } from './wallet';

type Props = { wallet: WalletProvider | null; account: string | null; chainId: number | null };
const explorer = 'https://bscscan.com';

export default function LegacyCutover({ wallet, account, chainId }: Props) {
  const [status, setStatus] = useState<LegacyCutoverStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [hash, setHash] = useState('');
  const [error, setError] = useState('');
  const [unknown, setUnknown] = useState(false);
  const refresh = useCallback(async () => {
    const rpc = new URL('api/rpc', window.location.href).href;
    const provider = new JsonRpcProvider(rpc, 56, { batchMaxCount: 1, cacheTimeout: -1 });
    const current = await readLegacyCutover(provider);
    setStatus(current);
    if (current.creationPaused || current.poolCount !== 0n) setConfirm(false);
    return current;
  }, []);
  useEffect(() => { let active = true; void refresh().catch(problem => { if (active) setError(messageOf(problem)); });
    return () => { active = false; }; }, [refresh]);

  async function pauseOldCreation() {
    if (!wallet || !account || chainId !== 56 || busy || unknown || hash) return;
    setBusy(true); setError('');
    try {
      const current = await refresh();
      assertLegacyCutoverReady(current, account);
      const provider = new BrowserProvider(wallet);
      const data = legacyPauseData();
      await provider.call({ from: account, to: LEGACY_FACTORY, data });
      const [walletChain, walletAccounts] = await Promise.all([
        wallet.request({ method: 'eth_chainId' }), wallet.request({ method: 'eth_accounts' }),
      ]);
      if (Number(walletChain) !== 56 || !Array.isArray(walletAccounts) ||
        typeof walletAccounts[0] !== 'string' || walletAccounts[0].toLowerCase() !== account.toLowerCase()) {
        throw new Error('钱包账户或网络已变化，请重新连接后再确认。');
      }
      let transactionHash: unknown;
      try {
        transactionHash = await wallet.request({ method: 'eth_sendTransaction',
          params: [{ from: account, to: LEGACY_FACTORY, data, value: '0x0' }] });
      } catch (problem) {
        if ((problem as { code?: number | string }).code !== 4001 && (problem as { code?: number | string }).code !== 'ACTION_REJECTED') {
          setUnknown(true);
          throw new Error(`钱包发送结果未确定：${messageOf(problem)} 请先核对钱包记录，不要重复发送。`);
        }
        throw problem;
      }
      if (typeof transactionHash !== 'string' || !/^0x[\da-f]{64}$/i.test(transactionHash)) {
        setUnknown(true);
        throw new Error('钱包未返回可核对的交易哈希。请先在钱包交易记录中核实，不要再次发送。');
      }
      setHash(transactionHash); setConfirm(false);
      const receipt = await provider.waitForTransaction(transactionHash, 1, 90_000);
      if (!receipt) throw new Error('交易仍未确认。请通过下方交易哈希核对，暂不要再次发送。');
      if (receipt.status !== 1) throw new Error('停建交易上链失败。请核对交易回执后再决定是否重试。');
      const updated = await refresh();
      if (!updated.creationPaused || updated.poolCount !== 0n) throw new Error('交易已确认，但旧 Factory 未满足零池且停建的切换条件。');
    } catch (problem) { setError(messageOf(problem)); }
    finally { setBusy(false); }
  }

  return <section className="card legacy-cutover" aria-label="新旧版本切换">
    <div className="card-heading"><div><ShieldCheck size={20}/><h2>新旧版本切换</h2></div><button className="small-button" disabled={busy} onClick={() => void refresh().then(() => setError('')).catch(problem => setError(messageOf(problem)))}><RefreshCw size={14}/>刷新链上状态</button></div>
    {!status ? <p>{error || '读取旧 Factory 链上状态中…'}</p> : status.poolCount !== 0n ?
      <p className="alert alert-error">旧版已有 {status.poolCount.toString()} 个矿池，不能按零历史方案启用新版建池。请先核对迁移方案。</p> : status.creationPaused ?
      <p className="success-inline"><Check size={18}/>旧版建池已暂停。<a href="https://tapeout.cc.cd/bemine-v2/#operator">前往新版运营工作台 <ArrowUpRight size={14}/></a></p> : <>
      <p>新版合约已完成部署。旧 Factory 仍允许建池，须由其 owner 钱包暂停后才能在新版创建项目。</p>
      <div className="preflight-facts"><div><span>旧 Factory</span><b><a href={`${explorer}/address/${LEGACY_FACTORY}`} target="_blank" rel="noreferrer">{LEGACY_FACTORY}</a></b></div><div><span>旧版矿池</span><b>0 个</b></div><div><span>旧 owner</span><b>{status.owner}</b></div></div>
      {!account ? <p>连接旧 owner 钱包后可继续。</p> : chainId !== 56 ? <p>请先把钱包切换到 BSC 主网。</p> : status.owner.toLowerCase() !== account.toLowerCase() ? <p>当前钱包不是旧 Factory 的 owner；请切换到上方地址。</p> : !confirm ?
        <button className="small-button" disabled={busy || unknown || !!hash} onClick={() => setConfirm(true)}>准备暂停旧版建池</button> :
        <div className="budget-recovery"><p>将向上述旧 Factory 发送 <code>pauseCreation(true)</code>。交易仅暂停旧版新建矿池，不转移资产；确认后新版建池门禁才会放行。</p><button className="small-button" disabled={busy} onClick={() => void pauseOldCreation()}>{busy ? '等待钱包或链上确认…' : '发送到钱包确认'}</button><button className="text-button" disabled={busy} onClick={() => setConfirm(false)}>返回</button></div>}
    </>}
    {hash && <p>停建交易：<a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">{hash}<ArrowUpRight size={14}/></a></p>}
    {error && status && <p className="alert alert-error" role="alert">{error}</p>}
    {unknown && <p>发送结果未确定。请先在钱包交易记录中核对，不要重复发送。</p>}
  </section>;
}
