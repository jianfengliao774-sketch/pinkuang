'use client';
import { useEffect, useRef, useState } from 'react';
import { formatEther, parseEther } from 'ethers';
import { Plus, ShieldCheck, ArrowRight, RefreshCw } from 'lucide-react';
import { prepareAdminAction } from '../lib/live-admin.mjs';
import { createUiContext } from '../lib/ui-context.mjs';
import { fundingAmount } from '../lib/funding-amount.mjs';
import OperatorQuotePicker from './OperatorQuotePicker';
import { loadOperatorQuote, operatorQuoteDraft, operatorQuoteError, parseOperatorImport } from '../lib/operator-quotes.mjs';
import '../app/live-operator.css';

const collections = [
  ['TapeOut', '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C'],
  ['Behemoth', '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C'],
];
const initial = { circuits: collections[0][1], circuitId: '', targetRaise: '', priceCap: '', fundingHours: '24', purchaseHours: '48' };
const errorText = operatorQuoteError;
const when = value => value == null ? '—' : new Date(Number(value) * 1000).toLocaleString('zh-CN');
const fundingDisplay = value => { try { return fundingAmount(value).display; } catch { return value; } };
function FundingPreview({ value }) {
  const exact = formatEther(value), amount = fundingAmount(exact);
  return <div><dt>募集总额</dt><dd>{amount.display} BNB{amount.approximate && <details><summary>查看精确金额</summary>{exact} BNB</details>}</dd></div>;
}

export default function LiveOperator({ config, account, wallet, operator, disabled, onSend, onRefresh }) {
  const [form, setForm] = useState(initial), [mode, setMode] = useState('createPool');
  const [imported, setImported] = useState(''), [pool, setPool] = useState(''), [listingId, setListingId] = useState('');
  const [preview, setPreview] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [autoSelection, setAutoSelection] = useState(null);
  const [fundingFocused, setFundingFocused] = useState(false), fundingEdited = useRef(false);
  const context = useRef(createUiContext()), identity = useRef(null);
  const key = `${config?.factory}:${account}`;
  if (identity.current?.key !== key || identity.current?.wallet !== wallet) {
    context.current.invalidate(); identity.current = { key, wallet };
  }
  useEffect(() => { setPreview(null); setError(''); setBusy(false); setAutoSelection(null); setImported(''); }, [key, wallet]);
  useEffect(() => () => context.current.invalidate(), []);
  const frozen = busy || disabled || !operator?.isOperator;
  const creationBlocked = frozen || !!preview || operator?.creationPaused || !operator?.machineRegistry?.supported || !operator.machineRegistry.ready;
  const change = (name, value) => { context.current.invalidate(); setPreview(null); setError('');
    if (!['fundingHours', 'purchaseHours'].includes(name)) setAutoSelection(null);
    setForm(current => ({ ...current, [name]: value })); };
  const finishFundingEdit = () => {
    setFundingFocused(false);
    if (!fundingEdited.current) return; // Focusing a quoted amount is not permission to round its actual value.
    fundingEdited.current = false;
    setForm(current => { try { return { ...current, targetRaise: fundingAmount(current.targetRaise).rounded }; } catch { return current; } });
  };
  const switchMode = next => { context.current.invalidate(); setMode(next); setPreview(null); setError(''); setAutoSelection(null); setImported(''); };
  function applyQuote(selection) {
    context.current.invalidate(); setPreview(null); setError('');
    const { params } = selection.draft;
    setForm(current => ({ ...current, circuits: params.circuits, circuitId: params.circuitId,
      targetRaise: formatEther(params.targetRaiseWei), priceCap: formatEther(params.priceCapWei) }));
    setAutoSelection(selection); setImported(JSON.stringify(selection.draft, null, 2));
  }
  async function recheckSelection(selection = autoSelection) {
    if (!selection) return null;
    const options = { mode, extraBps: selection.extraBps, fundingHours: form.fundingHours, purchaseHours: form.purchaseHours };
    const original = operatorQuoteDraft(selection.checked, options);
    const checked = await loadOperatorQuote({ collection: selection.checked.quote.collection, tokenId: selection.checked.quote.tokenId, config });
    const current = operatorQuoteDraft(checked, options);
    if (current.params.targetRaiseWei !== original.params.targetRaiseWei || current.params.priceCapWei !== original.params.priceCapWei
      || current.expectedTaskId !== original.expectedTaskId || current.expectedReferenceWeight !== original.expectedReferenceWeight) {
      throw new Error('最新报价或矿机条件已变化，请重新选择矿机并核对募集方案。');
    }
    // Keep the exact reviewed reference evidence; never silently replace its digest/timestamp.
    return original;
  }

  async function prepare(kind = mode, miningAction) {
    const ticket = context.current.begin(); setBusy(true); setError(''); setPreview(null);
    try {
      let input;
      if (autoSelection && ['createPool', 'createFlexiblePoolChecked'].includes(kind)) input = await recheckSelection();
      else if (kind === 'createPool') input = { kind, params: { circuits: form.circuits, circuitId: form.circuitId,
        targetRaiseWei: parseEther(form.targetRaise).toString(), priceCapWei: parseEther(form.priceCap).toString(),
        fundingHours: form.fundingHours, purchaseHours: form.purchaseHours } };
      else if (kind === 'createFlexiblePoolChecked') {
        const data = parseOperatorImport(imported);
        input = { kind, params: data.params, flexible: data.flexible,
          expectedTaskId: data.expectedTaskId, expectedReferenceWeight: data.expectedReferenceWeight };
      } else input = { kind, pool, listingId, miningAction };
      if (!context.current.current(ticket)) return;
      const prepared = await prepareAdminAction({ provider: wallet, config, account, ...input });
      if (!context.current.current(ticket)) return;
      setPreview({ ...prepared, input: prepared.request || { ...input, ...(prepared.params ? { params: prepared.params } : {}) }, ticket, identity: key });
    } catch (problem) { if (context.current.current(ticket)) setError(errorText(problem)); }
    finally { if (context.current.current(ticket)) setBusy(false); }
  }
  async function send() {
    if (!preview || preview.identity !== key || !context.current.current(preview.ticket)) return;
    const ticket = preview.ticket; setBusy(true); setError('');
    try { if (autoSelection && preview.input.params) await recheckSelection();
      if (!context.current.current(ticket)) return;
      await onSend(preview); if (context.current.current(ticket)) setPreview(null); }
    catch (problem) { if (context.current.current(ticket)) { setError(errorText(problem)); setPreview(null); } }
    finally { if (context.current.current(ticket)) setBusy(false); }
  }

  return <section className="panel live-operator" aria-label="运营建池与矿机管理">
    <div className="section-head"><div><h2><ShieldCheck size={21}/>运营工作台</h2><p>读取链上运营权限；每笔操作先预览，再由你的钱包确认。</p></div><button className="btn secondary" disabled={frozen} onClick={onRefresh}><RefreshCw size={16}/>刷新权限</button></div>
    {error && <div className="live-notice error" role="alert">{error}</div>}
    {!operator?.isOperator ? <p className="subtle-note">当前钱包不是 Factory 登记的运营地址。</p> : <>
      <div className="operator-identity"><span>当前运营钱包</span><strong>{account}</strong><span>Factory</span><strong>{config.factory}</strong></div>
      {!operator.machineRegistry?.supported && <p className="live-notice">当前工厂尚未支持矿机唯一性登记。请等待合约升级后创建新项目；已有项目的读取、退款与提现不受影响。</p>}
      {operator.machineRegistry?.supported && !operator.machineRegistry.ready && <p className="live-notice error">矿机唯一性登记尚未完成，暂不能创建新项目或从 Firsto 采购。</p>}
      <div className="operator-tabs"><button className={`btn${mode === 'createPool' ? '' : ' secondary'}`} disabled={frozen} onClick={() => switchMode('createPool')}>指定矿机建池</button><button className={`btn${mode === 'createFlexiblePoolChecked' ? '' : ' secondary'}`} disabled={frozen} onClick={() => switchMode('createFlexiblePoolChecked')}>灵活购机报价建池</button></div>
      {operator.creationPaused && <p className="live-notice error">链上建池已暂停，需要治理权限恢复后才能新建。</p>}
      <OperatorQuotePicker config={config} mode={mode} disabled={frozen || !!preview} onApply={applyQuote}/>
      {autoSelection && <p className="live-notice">已自动填入矿机与募集方案。请核对金额和期限；预览前会重新读取最新报价。</p>}
      {(mode === 'createPool' || autoSelection) && <div className="operator-grid">
        <label>矿机系列<select value={form.circuits} disabled={frozen || !!preview || mode !== 'createPool'} onChange={event => change('circuits', event.target.value)}>{collections.map(([name, address]) => <option key={address} value={address}>{name}</option>)}</select></label>
        <label>矿机编号<input inputMode="numeric" placeholder="可在上方选择后自动填入" value={form.circuitId} disabled={frozen || !!preview || mode !== 'createPool'} onChange={event => change('circuitId', event.target.value)}/></label>
        <label>募集总额（BNB）<input inputMode="decimal" placeholder="例如 0.005" value={fundingFocused ? form.targetRaise : fundingDisplay(form.targetRaise)} disabled={frozen || !!preview || mode !== 'createPool'} onFocus={() => { fundingEdited.current = false; setFundingFocused(true); }} onBlur={finishFundingEdit} onChange={event => { fundingEdited.current = true; change('targetRaise', event.target.value); }}/></label>
        <label>购机价格上限（BNB）<input inputMode="decimal" value={form.priceCap} disabled={frozen || !!preview || mode !== 'createPool'} onChange={event => change('priceCap', event.target.value)}/></label>
        <label>募集截止（距当前小时）<input inputMode="numeric" value={form.fundingHours} disabled={frozen || !!preview} onChange={event => change('fundingHours', event.target.value)}/></label>
        <label>购机期限（募集结束后小时）<input inputMode="numeric" value={form.purchaseHours} disabled={frozen || !!preview} onChange={event => change('purchaseHours', event.target.value)}/></label>
      </div>}
      {mode === 'createFlexiblePoolChecked' && <details className="operator-import"><summary>高级：手动导入完整报价</summary><label>已核验矿机报价 JSON<textarea value={imported} disabled={frozen || !!preview} onChange={event => { context.current.invalidate(); setPreview(null); setAutoSelection(null); setError(''); setImported(event.target.value); }} placeholder={'{"params": {...}, "flexible": {...}, "expectedTaskId": "...", "expectedReferenceWeight": "..."}'}/></label><small>通常在上方选择矿机即可自动生成，无需填写 JSON。</small></details>}
      <p className="subtle-note">每池固定 100 份。创建矿池只支付 Gas；募集款在成员认购时进入矿池。</p>
      <button className="btn" disabled={creationBlocked} onClick={() => void prepare()}><Plus size={17}/>预览创建矿池</button>
      <hr/>
      <h3>已募集矿池管理</h3><p className="subtle-note">填写矿池地址后，可自动读取原目标的最新 Firsto 单笔签名订单。购机总价由矿池支付，矿机直接进入矿池；当前不支持 Firsto 批量挂单和替代矿机采购。</p>
      <div className="operator-grid"><label>矿池合约<input placeholder="0x…" value={pool} disabled={frozen || !!preview} onChange={event => { context.current.invalidate(); setPool(event.target.value); setPreview(null); }}/></label><label>矿机市场订单编号<input inputMode="numeric" value={listingId} disabled={frozen || !!preview} onChange={event => { context.current.invalidate(); setListingId(event.target.value); setPreview(null); }}/></label></div>
      <button className="btn" disabled={frozen || !!preview || !pool || !operator.machineRegistry?.ready} onClick={() => void prepare('buyFromFirsto')}><RefreshCw size={16}/>获取 Firsto 订单并预览采购</button>
      <div className="operator-tabs"><button className="btn secondary" disabled={frozen || !!preview || !pool || !listingId} onClick={() => void prepare('buyFromMarket')}>预览购入指定矿机</button><button className="btn secondary" disabled={frozen || !!preview || !pool} onClick={() => void prepare('mine', 'arm')}>预览挖矿准备</button><button className="btn secondary" disabled={frozen || !!preview || !pool} onClick={() => void prepare('mine', 'reclaim')}>预览协议回收</button></div>
      <p className="subtle-note">协议回收须满足链上状态和冷却条件；重新启动需要有效计算证明。</p>
      {preview && preview.identity === key && <div className="operator-confirm" role="dialog" aria-label="确认运营操作"><h3>核对后前往钱包</h3><dl><div><dt>操作</dt><dd>{preview.kind === 'buyFromFirsto' ? '从 Firsto 购入原目标矿机' : preview.requestKind || preview.kind}</dd></div><div><dt>接收合约</dt><dd>{preview.transaction.to}</dd></div>{preview.firsto ? <><div><dt>目标矿机</dt><dd>{collections.find(([, address]) => address.toLowerCase() === preview.firsto.ask.collection.toLowerCase())?.[0]} #{preview.firsto.ask.tokenId}</dd></div><div><dt>矿机合约</dt><dd>{preview.firsto.ask.collection}</dd></div><div><dt>卖家报价</dt><dd>{formatEther(preview.firsto.priceWei)} BNB</dd></div><div><dt>Firsto 来源手续费</dt><dd>{formatEther(preview.firsto.feeWei)} BNB</dd></div><div><dt>矿池总支出</dt><dd>{formatEther(preview.firsto.grossWei)} BNB（由矿池余额支付）</dd></div><div><dt>订单有效期</dt><dd>{when(preview.firsto.ask.expiry)}</dd></div><div><dt>钱包支付</dt><dd>仅 Gas，不从运营钱包转入购机款</dd></div></> : <div><dt>业务支付</dt><dd>{formatEther(preview.transaction.value || 0)} BNB + Gas</dd></div>}{preview.input.params && <><FundingPreview value={preview.input.params.targetRaise}/><div><dt>募集截止</dt><dd>{when(preview.input.params.fundingDeadline)}</dd></div><div><dt>购机截止</dt><dd>{when(preview.input.params.purchaseDeadline)}</dd></div></>}</dl>{preview.firsto && <p className="subtle-note">此预览已锁定订单。发送前会再次核验原订单；价格、签名或出售条件变化时需要重新获取，不会自动替换成交订单。</p>}<div className="operator-tabs"><button className="btn secondary" disabled={busy} onClick={() => { context.current.invalidate(); setPreview(null); }}>返回修改</button><button className="btn" disabled={frozen} onClick={() => void send()}>发送到钱包确认<ArrowRight size={16}/></button></div></div>}
    </>}
  </section>;
}
