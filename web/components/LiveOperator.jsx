'use client';
import { displayAmount, displayGasFee } from '../lib/amount-display.mjs';
import { useEffect, useRef, useState } from 'react';
import { formatEther } from 'ethers';
import { Plus, ShieldCheck, ArrowRight, RefreshCw } from 'lucide-react';
import { prepareAdminAction } from '../lib/live-admin.mjs';
import { createUiContext } from '../lib/ui-context.mjs';
import { boundedReadPreview } from '../lib/bounded-read-preview.mjs';
import { fundingAmount } from '../lib/funding-amount.mjs';
import { operatorCreateInput } from '../lib/operator-create-input.mjs';
import OperatorQuotePicker from './OperatorQuotePicker';
import OperatorDialog from './OperatorDialog';
import { loadOperatorQuote, operatorQuoteDraft, operatorQuoteError } from '../lib/operator-quotes.mjs';
import { DESIGNATED_PURCHASE_MODE, DESIGNATED_PURCHASE_TERMS, designatedPurchaseEnabled } from '../lib/designated-purchase.mjs';
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
  return <div><dt>募集总额</dt><dd>{fundingDisplay(exact)} BNB{amount.approximate && <details><summary>查看精确金额</summary>{exact} BNB</details>}</dd></div>;
}

export default function LiveOperator({ config, account, wallet, readProvider, operator, disabled, disabledReason, creationPending = false, creationPendingReason,
  creationResetKey = 0, refreshKey = 0, onSend, onRefresh, gasFeeWei }) {
  const [form, setForm] = useState(initial), [mode, setMode] = useState('createPool');
  const [imported, setImported] = useState(''), [pool, setPool] = useState(''), [listingId, setListingId] = useState('');
  const [preview, setPreview] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [progress,setProgress]=useState(''),[capFocused,setCapFocused]=useState(false);
  const [autoSelection, setAutoSelection] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [submissionHidden, setSubmissionHidden] = useState(false);
  const [fundingFocused, setFundingFocused] = useState(false);
  const context = useRef(createUiContext()), identity = useRef(null);
  const previewRead = useRef(null), submission = useRef(null);
  const key = `${config?.factory}:${account}`;
  // The parent derives a new config object on render; progress updates must not cancel a valid preview.
  const deploymentKey = JSON.stringify([config?.stage, config?.artifactDigest, config?.authority, config?.portfolioFactory,
    config?.operationId, config?.stageActivationBlock, config?.stageActivationHash, config?.manifest]);
  if (identity.current?.key !== key || identity.current?.wallet !== wallet || identity.current?.deploymentKey !== deploymentKey || identity.current?.readProvider !== readProvider) {
    context.current.invalidate(); identity.current = { key, wallet, deploymentKey, readProvider };
  }
  useEffect(() => { previewRead.current?.abort(); setPreview(null); setFeedback(null); setSubmissionHidden(false); setError(''); setBusy(false); setProgress(''); setAutoSelection(null); setImported(''); }, [key, wallet, deploymentKey, readProvider]);
  useEffect(() => () => { context.current.invalidate(); previewRead.current?.abort(); }, []);
  useEffect(() => {
    if (!creationResetKey) return;
    context.current.invalidate(); previewRead.current?.abort(); setPreview(null); setForm(initial);
    setAutoSelection(null); setImported(''); setFeedback(null); setError('');
    setBusy(false); setProgress(''); setSubmissionHidden(false);
  }, [creationResetKey]);
  const direct = config?.displayOnly === true;
  const frozen = busy || disabled || !operator?.isOperator;
  const creationInput = operatorCreateInput({ form, mode, imported, autoSelection });
  const creationBlocked = frozen || creationPending || !!preview || !creationInput.valid || !direct && (operator?.creationPaused || !operator?.machineRegistry?.supported || !operator.machineRegistry.ready);
  const creationReason = busy ? progress || '正在核对，请稍候…'
    : creationPending ? creationPendingReason || '上一笔项目发布正在确认，请勿重复创建。'
    : disabled ? disabledReason || '请先核对当前交易状态，再创建项目。'
      : !operator?.isOperator ? direct ? '请连接本次部署配置的管理员钱包。' : '请先完成运营权限核验。'
        : preview ? '请在确认窗口完成操作，或返回修改。'
          : !direct && operator.creationPaused ? '链上已暂停建池。'
            : !direct && (!operator.machineRegistry?.supported || !operator.machineRegistry.ready) ? '矿机登记尚未就绪，暂不能创建。' : creationInput.reason;
  const change = (name, value) => { context.current.invalidate(); setPreview(null); setFeedback(null); setError('');
    if (!['fundingHours', 'purchaseHours'].includes(name)) setAutoSelection(null);
    setForm(current => ({ ...current, [name]: value })); };
  const finishFundingEdit = () => {
    setFundingFocused(false);
    // Rounding is presentation only, including amounts entered manually.
  };
  const switchMode = next => { context.current.invalidate(); setMode(next); setPreview(null); setFeedback(null); setError(''); setAutoSelection(null); setImported(''); };
  function applyQuote(selection) {
    context.current.invalidate(); setPreview(null); setError('');
    const { params } = selection.draft;
    setForm(current => ({ ...current, circuits: params.circuits, circuitId: params.circuitId,
      targetRaise: formatEther(params.targetRaiseWei), priceCap: formatEther(params.priceCapWei) }));
    setAutoSelection(selection); setImported(JSON.stringify(selection.draft, null, 2));
    setFeedback({ kind: 'filled', title: '募集方案已填入', message: '项目尚未发布。请核对募集金额和期限，预览后再前往钱包确认创建。' });
  }
  async function recheckSelection(selection = autoSelection, optionsForRead = {}) {
    if (!selection) return null;
    const local = operatorCreateInput({ form, mode, autoSelection: selection });
    if (!local.valid) throw new Error(local.reason);
    const options = { mode, extraBps: selection.extraBps, fundingHours: local.input.params.fundingHours,
      purchaseHours: local.input.params.purchaseHours };
    const original = operatorQuoteDraft(selection.checked, options);
    if (direct && mode !== DESIGNATED_PURCHASE_MODE) return original;
    const checked = await loadOperatorQuote({ collection: selection.checked.chain.collection,
      tokenId: selection.checked.chain.tokenId, config, mode, forCreation: true, ...optionsForRead });
    const current = operatorQuoteDraft(checked, options);
    if (current.params.targetRaiseWei !== original.params.targetRaiseWei || current.params.priceCapWei !== original.params.priceCapWei
      || current.expectedTaskId !== original.expectedTaskId || current.expectedReferenceWeight !== original.expectedReferenceWeight
      || mode === DESIGNATED_PURCHASE_MODE && (current.designated.referenceDailyOutputAtomic !== original.designated.referenceDailyOutputAtomic
        || current.designated.referenceSeller !== original.designated.referenceSeller
        || current.designated.referencePriceWei !== original.designated.referencePriceWei
        || current.designated.referenceCostWei !== original.designated.referenceCostWei)) {
      throw new Error('最新报价或矿机条件已变化，请重新选择矿机并核对募集方案。');
    }
    // Keep the exact reviewed reference evidence; never silently replace its digest/timestamp.
    return original;
  }

  async function prepare(kind = mode, miningAction) {
    const creation = ['createPool', 'createFlexiblePoolChecked', DESIGNATED_PURCHASE_MODE].includes(kind)
      ? operatorCreateInput({ form, mode: kind, imported, autoSelection }) : null;
    if (creation && (!creation.valid || creationBlocked)) return;
    const ticket = context.current.begin(); setBusy(true); setError(''); setPreview(null);
    setFeedback({ kind: 'preparing', title: '正在生成操作预览', message: '正在核对本次操作，请稍候。此步骤不会发送交易。' });
    const controller = new AbortController(); previewRead.current = controller;
    setProgress(direct ? '正在生成操作预览…' : autoSelection?'正在核对最新报价…':'正在核对建池条件…');
    try {
      const prepared = await boundedReadPreview(async ({ provider, check, signal }) => {
      let input;
      if (autoSelection && ['createPool', 'createFlexiblePoolChecked', DESIGNATED_PURCHASE_MODE].includes(kind)) input = await recheckSelection(autoSelection, { provider, signal });
      else if (creation) input = creation.input;
      else input = { kind, pool, listingId, miningAction };
      check();
      setProgress(direct ? '正在生成操作预览…' : '正在核对链上条件，完成后显示确认窗口…');
      return prepareAdminAction({ provider, config, account, ...input,
        ...(direct && autoSelection && creation ? { machineReservation: autoSelection.checked.chain.registry } : {}) });
      }, { provider: config?.productFamily === 'fresh-v4' ? readProvider : wallet,
        isCurrent: () => context.current.current(ticket), signal: controller.signal });
      if (!context.current.current(ticket)) return;
      setFeedback(null);
      setPreview({ ...prepared, input: prepared.request, ticket, identity: key });
    } catch (problem) { if (context.current.current(ticket)) { context.current.invalidate(); setError(errorText(problem));
      setFeedback({ kind: 'preview-error', title: '无法生成操作预览', message: errorText(problem) }); setBusy(false); setProgress(''); } }
    finally { if (previewRead.current === controller) previewRead.current = null; if (context.current.current(ticket)) {setBusy(false);setProgress('');} }
  }
  function cancelPreviewRead() { context.current.invalidate(); previewRead.current?.abort(); previewRead.current = null; setFeedback(null); setBusy(false); setProgress(''); setError(''); }
  function submissionFeedback(value) {
    const status = typeof value === 'string' ? value : value?.status;
    const phases = {
      'preparing-authority': { title: '正在准备管理员操作', message: '正在准备本次签名请求。' },
      'awaiting-admin-signature': { title: '等待管理员签名', message: '请在钱包中确认本次管理员签名。' },
      authenticating: { title: '正在恢复登录', message: '正在复用本站钱包会话。' },
      'awaiting-login-signature': { title: '等待钱包登录签名', message: '请在钱包中确认本站登录签名。' },
      'submitting-authority': { title: '正在发送已签名请求', message: '管理员签名已完成，正在提交给 Gas 服务。' },
      pending: { title: '交易已提交', message: '正在等待链上确认。' },
      confirmed: { title: '链上已确认', message: '正在更新项目数据。' },
    };
    return Object.hasOwn(phases, status) ? { kind: 'submitting', ...phases[status] } : null;
  }
  async function send() {
    if (submission.current || (creationPending && preview?.input.params) || !preview || preview.identity !== key || !context.current.current(preview.ticket)) return;
    const ticket = preview.ticket, attempt = { ticket }; submission.current = attempt;
    setBusy(true); setError(''); setSubmissionHidden(false);
    setPreview(null);
    setFeedback({ kind: 'submitting', title: '正在提交请求', message: '正在准备本次操作。' });
    setProgress('正在提交请求…');
    try { if (!direct && autoSelection && preview.input.params) await boundedReadPreview(({ provider, signal }) => recheckSelection(autoSelection, { provider, signal }),
      { provider: config?.productFamily === 'fresh-v4' ? readProvider : wallet, isCurrent: () => context.current.current(ticket) });
      if (!context.current.current(ticket)) return;
      await onSend(preview, { onState: value => {
        if (submission.current !== attempt || !context.current.current(ticket)) return;
        const next = submissionFeedback(value);
        if (next) { setFeedback(next); setProgress(next.message); }
      } }); if (context.current.current(ticket)) { setPreview(null); setFeedback(null); } }
    catch (problem) { if (context.current.current(ticket)) { setError(errorText(problem)); setPreview(null);
      setFeedback(problem.resultPresented ? null : { kind: 'submission-error', title: '本次操作未完成', message: errorText(problem) }); } }
    finally { if (submission.current === attempt) submission.current = null;
      if (context.current.current(ticket)) {setBusy(false);setProgress('');setSubmissionHidden(false);} }
  }

  return <section className="panel live-operator" aria-label="运营建池与矿机管理">
    <div className="section-head"><div><h2><ShieldCheck size={21}/>运营工作台</h2><p>{direct ? '每笔操作先预览，再由你的钱包确认；合约执行时检查权限和条件。' : '读取链上运营权限；每笔操作先预览，再由你的钱包确认。'}</p></div><button className="btn secondary" disabled={frozen} onClick={onRefresh}><RefreshCw size={16}/>刷新权限</button></div>
    {error && <div className="live-notice error" role="alert">{error}</div>}
    {!operator?.isOperator ? <p className="subtle-note">{direct ? '当前钱包不在本次部署的管理员配置中。' : '当前钱包不是 Factory 登记的运营地址。'}</p> : <>
      <div className="operator-identity"><span>当前运营钱包</span><strong>{account}</strong><span>单矿机工厂合约</span><strong>{config.factory}</strong></div>
      {!direct && !operator.machineRegistry?.supported && <p className="live-notice">当前工厂尚未支持矿机唯一性登记。请等待合约升级后创建新项目；已有项目的读取、退款与提现不受影响。</p>}
      {!direct && operator.machineRegistry?.supported && !operator.machineRegistry.ready && <p className="live-notice error">矿机唯一性登记尚未完成，暂不能创建新项目或从 Firsto 采购。</p>}
      <div className="operator-tabs"><button className={`btn${mode === 'createPool' ? '' : ' secondary'}`} disabled={frozen} onClick={() => switchMode('createPool')}>指定单台矿机</button><button className={`btn${mode === 'createFlexiblePoolChecked' ? '' : ' secondary'}`} disabled={frozen} onClick={() => switchMode('createFlexiblePoolChecked')}>单台矿机灵活替代</button>{designatedPurchaseEnabled(config) && <button className={`btn${mode === DESIGNATED_PURCHASE_MODE ? '' : ' secondary'}`} disabled={frozen} onClick={() => switchMode(DESIGNATED_PURCHASE_MODE)}>指定矿机 · ±10% 替代</button>}<button className="btn secondary" disabled={frozen} onClick={() => document.getElementById('multi-miner-projects')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>多矿机同一项目（100 份）↓</button></div>
      <p className="subtle-note">当前表单只建单台矿机池。若要用固定 BNB 预算购买多台矿机，请进入下方“多矿机预算项目”；募满后可设置本批最多采购台数。</p>
      {operator.creationPaused && <p className="live-notice error">链上建池已暂停，需要治理权限恢复后才能新建。</p>}
      {mode === DESIGNATED_PURCHASE_MODE && <p className="subtle-note">{DESIGNATED_PURCHASE_TERMS}</p>}
      <OperatorQuotePicker config={config} mode={mode} disabled={frozen || creationPending || !!preview} refreshKey={refreshKey} onApply={applyQuote}/>
      {autoSelection && <p className="live-notice">{direct ? '已自动填入矿机与募集方案。请核对金额和期限。' : '已自动填入矿机与募集方案。请核对金额和期限；预览前会重新读取最新报价。'}</p>}
      {(mode === 'createPool' || autoSelection) && <div className="operator-grid">
        <label>矿机系列<select value={form.circuits} disabled={frozen || !!preview || mode !== 'createPool'} onChange={event => change('circuits', event.target.value)}>{collections.map(([name, address]) => <option key={address} value={address}>{name}</option>)}</select></label>
        <label>矿机编号<input inputMode="numeric" placeholder="可在上方选择后自动填入" value={form.circuitId} aria-invalid={!!creationInput.errors.circuitId} aria-describedby={creationInput.errors.circuitId ? 'operator-circuit-id-error' : undefined} disabled={frozen || !!preview || mode !== 'createPool'} onChange={event => change('circuitId', event.target.value)}/>{creationInput.errors.circuitId && <small id="operator-circuit-id-error" className="operator-input-error">{creationInput.errors.circuitId}</small>}</label>
        <label>募集总额（BNB）<input inputMode="decimal" placeholder="例如 0.005" title={form.targetRaise?`精确金额 ${form.targetRaise} BNB`:undefined} value={fundingFocused ? form.targetRaise : fundingDisplay(form.targetRaise)} aria-invalid={!!creationInput.errors.targetRaise} aria-describedby={creationInput.errors.targetRaise ? 'operator-target-raise-error' : undefined} disabled={frozen || !!preview || mode !== 'createPool'} onFocus={() => setFundingFocused(true)} onBlur={finishFundingEdit} onChange={event => change('targetRaise', event.target.value)}/>{creationInput.errors.targetRaise && <small id="operator-target-raise-error" className="operator-input-error">{creationInput.errors.targetRaise}</small>}</label>
        <label>购机价格上限（BNB）<input inputMode="decimal" title={form.priceCap?`精确金额 ${form.priceCap} BNB`:undefined} value={capFocused?form.priceCap:fundingDisplay(form.priceCap)} aria-invalid={!!creationInput.errors.priceCap} aria-describedby={creationInput.errors.priceCap ? 'operator-price-cap-error' : undefined} disabled={frozen || !!preview || mode !== 'createPool'} onFocus={()=>setCapFocused(true)} onBlur={()=>setCapFocused(false)} onChange={event => change('priceCap', event.target.value)}/>{creationInput.errors.priceCap && <small id="operator-price-cap-error" className="operator-input-error">{creationInput.errors.priceCap}</small>}</label>
        <label>募集截止（距当前小时）<input inputMode="numeric" value={form.fundingHours} aria-invalid={!!creationInput.errors.fundingHours} aria-describedby={creationInput.errors.fundingHours ? 'operator-funding-hours-error' : undefined} disabled={frozen || !!preview} onChange={event => change('fundingHours', event.target.value)}/>{creationInput.errors.fundingHours && <small id="operator-funding-hours-error" className="operator-input-error">{creationInput.errors.fundingHours}</small>}</label>
        <label>购机期限（募集结束后小时）<input inputMode="numeric" value={form.purchaseHours} aria-invalid={!!creationInput.errors.purchaseHours} aria-describedby={creationInput.errors.purchaseHours ? 'operator-purchase-hours-error' : undefined} disabled={frozen || !!preview} onChange={event => change('purchaseHours', event.target.value)}/>{creationInput.errors.purchaseHours && <small id="operator-purchase-hours-error" className="operator-input-error">{creationInput.errors.purchaseHours}</small>}</label>
      </div>}
      {mode === 'createFlexiblePoolChecked' && <details className="operator-import"><summary>高级：手动导入完整报价</summary><label>已核验矿机报价 JSON<textarea value={imported} disabled={frozen || !!preview} onChange={event => { context.current.invalidate(); setPreview(null); setAutoSelection(null); setError(''); setImported(event.target.value); }} placeholder={'{"params": {...}, "flexible": {...}, "expectedTaskId": "...", "expectedReferenceWeight": "..."}'}/></label><small>通常在上方选择矿机即可自动生成，无需填写 JSON。</small></details>}
      <p className="subtle-note">每池固定 100 份。创建矿池只支付 Gas；募集款在成员认购时进入矿池。</p>
      <button className="btn" disabled={creationBlocked} onClick={() => void prepare()}><Plus size={17}/>预览创建矿池</button>
      {creationReason&&<p className="subtle-note" role="status" data-creation-block-reason>{creationReason}</p>}
      {busy && previewRead.current && <button className="btn secondary" onClick={cancelPreviewRead}>取消核对</button>}
      <hr/>
      {config.stage === 'fresh-active' ? <><p className="live-notice">单机采购与挖矿准备、启动由已核验的独立服务执行。多机预算采购在下方逐台签名：先建子池，再核对订单与最高支出。管理员钱包不直接支付 Gas。</p><h3>协议回收</h3><p className="subtle-note">回收需要管理员对指定矿池、精确矿机标识单独签名；不会授权挖矿服务任意回收。</p><label>已核验矿池合约<input placeholder="0x…" value={pool} disabled={frozen || !!preview} onChange={event => { context.current.invalidate(); setPool(event.target.value); setPreview(null); }}/></label><button className="btn secondary" disabled={frozen || !!preview || !pool} onClick={() => void prepare('mine', 'reclaim')}>预览协议回收签名</button><p className="subtle-note">首发不提供暂停认购代付入口。</p></> : <><h3>已募集矿池管理</h3><p className="subtle-note">填写矿池地址后，先检查原目标的官网挂单。灵活矿池还会扫描同任务的官网替代矿机；确认没有可执行的官网购机路径后，才核验 Firsto 原目标单笔签名订单。</p>
      <div className="operator-grid"><label>矿池合约<input placeholder="0x…" value={pool} disabled={frozen || !!preview} onChange={event => { context.current.invalidate(); setPool(event.target.value); setPreview(null); }}/></label><label>矿机市场订单编号<input inputMode="numeric" value={listingId} disabled={frozen || !!preview} onChange={event => { context.current.invalidate(); setListingId(event.target.value); setPreview(null); }}/></label></div>
      <button className="btn" disabled={frozen || !!preview || !pool} onClick={() => void prepare('autoPurchase')}><RefreshCw size={16}/>先查官网并预览购机</button>
      <div className="operator-tabs"><button className="btn secondary" disabled={frozen || !!preview || !pool || !listingId} onClick={() => void prepare('buyFromMarket')}>预览购入指定矿机</button><button className="btn secondary" disabled={frozen || !!preview || !pool} onClick={() => void prepare('mine', 'arm')}>预览挖矿准备</button><button className="btn secondary" disabled={frozen || !!preview || !pool} onClick={() => void prepare('mine', 'reclaim')}>预览协议回收</button></div>
      <p className="subtle-note">协议回收须满足链上状态和冷却条件；重新启动需要有效计算证明。</p></>}
      {busy && submissionHidden && feedback?.kind === 'submitting' && <div className="live-notice" role="status">
        <span>{feedback.title}。{progress || feedback.message}</span>
        <button className="btn secondary" onClick={() => setSubmissionHidden(false)}>查看提交进度</button>
      </div>}
      {feedback && (feedback.kind !== 'submitting' || !submissionHidden) && <OperatorDialog title={feedback.title} onClose={feedback.kind === 'preparing' ? cancelPreviewRead : feedback.kind === 'submitting' ? () => setSubmissionHidden(true) : () => setFeedback(null)}>
        <p className="operator-dialog-message" role="status">{feedback.kind === 'preparing' ? progress || feedback.message : feedback.message}</p>
        {feedback.kind === 'filled' && <div className="operator-tabs">
          <button className="btn secondary" onClick={() => setFeedback(null)}>继续编辑</button>
          <button className="btn" disabled={creationBlocked} onClick={() => void prepare()}>预览创建矿池<ArrowRight size={16}/></button>
        </div>}
        {feedback.kind === 'filled' && creationReason && <p className="operator-dialog-message" role="status">{creationReason}</p>}
        {feedback.kind === 'preparing' && <button className="btn secondary" onClick={cancelPreviewRead}>取消核对</button>}
        {feedback.kind === 'submitting' && <button className="btn secondary" onClick={() => setSubmissionHidden(true)}>收起</button>}
        {feedback.kind.endsWith('-error') && <button className="btn" onClick={() => setFeedback(null)}>返回修改</button>}
      </OperatorDialog>}
      {preview && preview.identity === key && <OperatorDialog title="核对后前往钱包" onClose={!busy ? () => { context.current.invalidate(); setPreview(null); } : undefined}><>{preview.kind === DESIGNATED_PURCHASE_MODE && <p className="subtle-note">{DESIGNATED_PURCHASE_TERMS}</p>}</><dl><div><dt>操作</dt><dd>{preview.kind === 'buyFromFirsto' ? '从 Firsto 购入原目标矿机' : preview.kind === 'buyAlternativeFromMarket' ? '从官网市场购入同任务替代矿机' : preview.official ? '从官网市场购入原目标矿机' : preview.requestKind || preview.kind}</dd></div><div><dt>接收合约</dt><dd>{preview.transaction.to}</dd></div>{preview.official && <><div><dt>购入矿机</dt><dd>{collections.find(([, address]) => address.toLowerCase() === preview.official.collection?.toLowerCase())?.[0]} #{preview.official.tokenId}</dd></div>{preview.official.verifiedWeight && <div><dt>验证产能权重</dt><dd>{preview.official.verifiedWeight}</dd></div>}<div><dt>官网挂单编号</dt><dd>#{preview.official.id}</dd></div><div><dt>官网成交价</dt><dd>{displayAmount(preview.official.priceWei)} BNB（由矿池余额支付）</dd></div><div><dt>钱包支付</dt><dd>仅 Gas</dd></div></>}{preview.firsto ? <><div><dt>目标矿机</dt><dd>{collections.find(([, address]) => address.toLowerCase() === preview.firsto.ask.collection.toLowerCase())?.[0]} #{preview.firsto.ask.tokenId}</dd></div><div><dt>矿机合约</dt><dd>{preview.firsto.ask.collection}</dd></div><div><dt>卖家报价</dt><dd>{displayAmount(preview.firsto.priceWei)} BNB</dd></div><div><dt>Firsto 来源手续费</dt><dd>{displayAmount(preview.firsto.feeWei)} BNB</dd></div><div><dt>矿池总支出</dt><dd>{displayAmount(preview.firsto.grossWei)} BNB（由矿池余额支付）</dd></div><div><dt>订单有效期</dt><dd>{when(preview.firsto.ask.expiry)}</dd></div><div><dt>钱包支付</dt><dd>仅 Gas，不从运营钱包转入购机款</dd></div></> : !preview.official && <div><dt>业务支付</dt><dd>{config.stage === 'fresh-active' ? '本钱包仅签名，Gas 钱包代付手续费' : <>{displayAmount(preview.transaction.value || 0)} BNB + Gas</>}</dd></div>}{preview.input.params && <><div><dt>目标矿机</dt><dd>{collections.find(([, address]) => address.toLowerCase() === preview.input.params.circuits.toLowerCase())?.[0] || preview.input.params.circuits} #{preview.input.params.circuitId.toString()}</dd></div><div><dt>购机上限</dt><dd>{displayAmount(preview.input.params.priceCap)} BNB</dd></div><FundingPreview value={preview.input.params.targetRaise}/><div><dt>募集截止</dt><dd>{when(preview.input.params.fundingDeadline)}</dd></div><div><dt>购机截止</dt><dd>{when(preview.input.params.purchaseDeadline)}</dd></div></>}{busy && gasFeeWei != null && <div><dt>Gas 费用上限</dt><dd>{displayGasFee(gasFeeWei)} BNB</dd></div>}</dl>{preview.official && <p className="subtle-note">官网预览价未锁定；交易只包含挂单编号。卖家可能在成交前调价，合约仍会检查矿池购机上限{preview.kind === 'buyAlternativeFromMarket' ? '及单位验证产能价格上限' : ''}。</p>}{preview.firsto && <p className="subtle-note">{direct ? '此预览已锁定订单，确认后按预览内容发送。' : '此预览已锁定订单。发送前会再次扫描官网市场并核验原 Firsto 订单；条件变化时需要重新预览，不会自动替换成交订单。'}</p>}<div className="operator-tabs"><button className="btn secondary" disabled={busy} onClick={() => { context.current.invalidate(); setPreview(null); }}>返回修改</button><button className="btn" disabled={frozen} onClick={() => void send()}>发送到钱包确认<ArrowRight size={16}/></button></div></OperatorDialog>}
    </>}
  </section>;
}
