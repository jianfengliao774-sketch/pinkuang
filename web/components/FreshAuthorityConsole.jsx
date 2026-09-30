'use client';
import { useEffect, useRef, useState } from 'react';
import { getAddress, keccak256, parseEther, toUtf8Bytes } from 'ethers';
import { authorityActionStatus } from '../lib/authority-client.mjs';
import SaleReviewRequests from './SaleReviewRequests';
import FeeCollection from './FeeCollection';

const errorText = value => value instanceof Error ? value.message : String(value);

/** Administrator approvals are exact EIP-712 messages; the service Gas wallet sends them. */
export default function FreshAuthorityConsole({ config, account, wallet, provider, disabled, onAction, mode = 'review' }) {
  const [pool, setPool] = useState('');
  const [referencePrice, setReferencePrice] = useState('');
  const [referenceSource, setReferenceSource] = useState('');
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reviewRefresh, setReviewRefresh] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let current = true;
    if (config?.stage !== 'fresh-active' || !account) return;
    authorityActionStatus(config, account).then(value => { if (current) setStatus(value); })
      .catch(() => { if (current) setStatus(null); });
    return () => { current = false; };
  }, [config?.stage, config?.authority, account]);

  async function submit(kind, args) {
    if (disabled || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const latest = await authorityActionStatus(config, account);
      if (!mounted.current) return null;
      setStatus(latest);
      if (latest?.status && !['idle','confirmed','failed'].includes(latest.status))
        throw new Error('上笔管理员代付交易尚未确认；先核对状态，不能重复发送。');
      const result = await onAction(kind, args);
      setStatus(result);
      setNotice(result?.hash ? `Gas 钱包已提交交易：${result.hash}` : '签名已提交；请刷新状态核对结果。');
      setReviewRefresh(value => value + 1);
      return result;
    } catch (problem) {
      setError(errorText(problem));
      try { setStatus(await authorityActionStatus(config, account)); } catch { /* Keep the signed action unresolved. */ }
      return null;
    } finally { setBusy(false); }
  }

  if (config?.stage !== 'fresh-active') return null;
  const frozen = disabled || busy || !wallet || !account ||
    status && !['idle','confirmed','failed'].includes(status.status);
  return <section className="panel live-operator" aria-label={mode === 'fees' ? '领取手续费' : '用户申请审核'}>
    <div className="section-head"><div><h2>{mode === 'fees' ? '领取手续费' : '用户申请审核'}</h2>
      <p>任意一位链上登记的管理员签名，独立 Gas 钱包代付。</p></div>
      <button className="btn secondary" disabled={busy} onClick={() => void authorityActionStatus(config, account).then(value => { setStatus(value); setReviewRefresh(key => key + 1); }).catch(problem => setError(errorText(problem)))}>刷新交易状态</button></div>
    {mode === 'fees'
      ? <details className="operator-fee-connections"><summary>合约信息</summary>
        <p>Authority：{config.authority}　Gas 钱包：{config.gasWallet}</p></details>
      : <p className="subtle-note">Authority：{config.authority}　Gas 钱包：{config.gasWallet}</p>}
    {status?.hash && <p className="subtle-note">代付交易：<a href={`https://bscscan.com/tx/${status.hash}`} target="_blank" rel="noreferrer">{status.hash}</a> · {status.status}</p>}
    {notice && <p className="live-notice" role="status">{notice}</p>}
    {error && <p className="live-notice error" role="alert">{error}</p>}
    {mode === 'review' && <>
    <SaleReviewRequests config={config} provider={provider} account={account} disabled={frozen}
      refreshKey={reviewRefresh} onSelect={item => setPool(item.pool)} onReview={submit}/>
    <details className="operator-reference-tools"><summary>更新 Firsto 市场参考价</summary>
    <div className="operator-grid"><label>矿池或子矿机地址<input value={pool} onChange={event => setPool(event.target.value)} placeholder="选择申请自动填入，也可填写 0x…"/></label></div>
    <h3>Firsto 市场参考价</h3>
    <p className="subtle-note">填写该矿机整机参考价和报价来源；链上记录来源摘要及当前区块时间。请先核对报价。</p>
    <div className="operator-grid">
      <label>整机参考价（BNB）<input inputMode="decimal" value={referencePrice} onChange={event => setReferencePrice(event.target.value)}/></label>
      <label>报价来源 URL 或编号<input value={referenceSource} onChange={event => setReferenceSource(event.target.value)}/></label>
    </div>
    <button className="btn secondary" disabled={frozen} onClick={() => void (async () => { try {
      if (!referenceSource.trim()) throw new Error('必须填写可核对的 Firsto 报价来源。');
      const block = await wallet.request({ method: 'eth_getBlockByNumber', params: ['latest', false] });
      if (!block?.timestamp) throw new Error('链上区块暂不可用。');
      await submit('setSaleReference', { market: getAddress(config.shareMarket), pool: getAddress(pool),
        priceWei: parseEther(referencePrice).toString(), observedAt: BigInt(block.timestamp).toString(),
        digest: keccak256(toUtf8Bytes(`${referenceSource.trim()}|${referencePrice.trim()}`)) });
    } catch (problem) { setError(errorText(problem)); } })()}>签名更新参考价</button>
    </details>
    </>}
    {mode === 'fees' && <FeeCollection config={config} provider={provider} account={account} wallet={wallet}
      disabled={disabled} status={status} refreshKey={reviewRefresh} onAction={onAction} onStatus={setStatus}/>}
  </section>;
}
