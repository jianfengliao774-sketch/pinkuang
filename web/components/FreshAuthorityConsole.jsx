'use client';
import { useEffect, useState } from 'react';
import { getAddress, keccak256, parseEther, toUtf8Bytes } from 'ethers';
import { authorityActionStatus } from '../lib/authority-client.mjs';

const errorText = value => value instanceof Error ? value.message : String(value);
const addresses = value => value.split(/[\s,，]+/).map(item => item.trim()).filter(Boolean).map(getAddress);

/** Administrator approvals are exact EIP-712 messages; the service Gas wallet sends them. */
export default function FreshAuthorityConsole({ config, account, wallet, disabled, onAction }) {
  const [pool, setPool] = useState('');
  const [proposalId, setProposalId] = useState('');
  const [price, setPrice] = useState('');
  const [referencePrice, setReferencePrice] = useState('');
  const [referenceSource, setReferenceSource] = useState('');
  const [portfolio, setPortfolio] = useState('');
  const [childProposalId, setChildProposalId] = useState('');
  const [feePools, setFeePools] = useState('');
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

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
      setStatus(latest);
      if (latest?.status && !['idle','confirmed','failed'].includes(latest.status))
        throw new Error('上笔管理员代付交易尚未确认；先核对状态，不能重复发送。');
      const result = await onAction(kind, args);
      setStatus(result);
      setNotice(result?.hash ? `Gas 钱包已提交交易：${result.hash}` : '签名已提交；请刷新状态核对结果。');
    } catch (problem) {
      setError(errorText(problem));
      try { setStatus(await authorityActionStatus(config, account)); } catch { /* Keep the signed action unresolved. */ }
    } finally { setBusy(false); }
  }

  if (config?.stage !== 'fresh-active') return null;
  const frozen = disabled || busy || !wallet || !account ||
    status && !['idle','confirmed','failed'].includes(status.status);
  return <section className="panel live-operator" aria-label="管理员审核与手续费">
    <div className="section-head"><div><h2>管理员审核与手续费</h2>
      <p>任意一位链上登记的管理员签名；独立 Gas 钱包代付。审核会绑定具体项目、提案编号和价格。</p></div>
      <button className="btn secondary" disabled={busy} onClick={() => void authorityActionStatus(config, account).then(setStatus).catch(problem => setError(errorText(problem)))}>刷新交易状态</button></div>
    <p className="subtle-note">Authority：{config.authority}　Gas 钱包：{config.gasWallet}</p>
    {status?.hash && <p className="subtle-note">代付交易：<a href={`https://bscscan.com/tx/${status.hash}`} target="_blank" rel="noreferrer">{status.hash}</a> · {status.status}</p>}
    {notice && <p className="live-notice" role="status">{notice}</p>}
    {error && <p className="live-notice error" role="alert">{error}</p>}
    <h3>单机出售审核</h3>
    <div className="operator-grid">
      <label>矿池地址<input value={pool} onChange={event => setPool(event.target.value)} placeholder="0x…"/></label>
      <label>出售提案编号<input inputMode="numeric" value={proposalId} onChange={event => setProposalId(event.target.value)}/></label>
      <label>提案出售总价（BNB）<input inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)}/></label>
    </div>
    <div className="operator-tabs">
      <button className="btn" disabled={frozen} onClick={() => { try { void submit('reviewSale', { market: getAddress(config.shareMarket), pool: getAddress(pool), proposalId: BigInt(proposalId).toString(), priceWei: parseEther(price).toString(), approved: true }); } catch (problem) { setError(errorText(problem)); } }}>签名批准</button>
      <button className="btn secondary" disabled={frozen} onClick={() => { try { void submit('reviewSale', { market: getAddress(config.shareMarket), pool: getAddress(pool), proposalId: BigInt(proposalId).toString(), priceWei: parseEther(price).toString(), approved: false }); } catch (problem) { setError(errorText(problem)); } }}>签名驳回</button>
    </div>
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
    <h3>预算项目子矿机出售审核</h3>
    <div className="operator-grid">
      <label>预算项目地址<input value={portfolio} onChange={event => setPortfolio(event.target.value)} placeholder="0x…"/></label>
      <label>提案编号<input inputMode="numeric" value={childProposalId} onChange={event => setChildProposalId(event.target.value)}/></label>
    </div>
    <div className="operator-tabs">
      <button className="btn" disabled={frozen} onClick={() => { try { void submit('reviewChildSale', { portfolio: getAddress(portfolio), proposalId: BigInt(childProposalId).toString(), approved: true }); } catch (problem) { setError(errorText(problem)); } }}>签名批准</button>
      <button className="btn secondary" disabled={frozen} onClick={() => { try { void submit('reviewChildSale', { portfolio: getAddress(portfolio), proposalId: BigInt(childProposalId).toString(), approved: false }); } catch (problem) { setError(errorText(problem)); } }}>签名驳回</button>
    </div>
    <h3>领取平台手续费</h3>
    <p className="subtle-note">任意管理员可把所选市场和矿池当前可领的平台费全部领到自己的管理员地址。请核对来源；同一笔不能由两人重复领取。</p>
    <label>矿池或预算项目地址（可选，用逗号分隔）<textarea value={feePools} onChange={event => setFeePools(event.target.value)} placeholder="0x…，0x…"/></label>
    <button className="btn secondary" disabled={frozen} onClick={() => { try { void submit('claimFees', {
      markets: [getAddress(config.shareMarket), getAddress(config.portfolioMarket)],
      pools: addresses(feePools), recipient: getAddress(account),
    }); } catch (problem) { setError(errorText(problem)); } }}>签名领取到当前管理员钱包</button>
  </section>;
}
