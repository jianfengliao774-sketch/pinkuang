'use client';

import {useEffect, useMemo, useRef, useState} from 'react';
import {ArrowUpRight, Check, CheckCheck, ChevronDown, Download, List, Monitor, Search, Smartphone} from 'lucide-react';
import {reviewScenarios, reviewGaps} from '../../lib/review-scenarios';
import './book.css';

const STORAGE_KEY = 'bemine-review-v5';
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
const groups = [...new Set(reviewScenarios.map(item => item.group))];
const numberOf = id => String(reviewScenarios.findIndex(item => item.id === id) + 1).padStart(2, '0');
const frameUrl = (id, locale, appearance) => `${basePath}/review/frame.html?id=${encodeURIComponent(id)}&locale=${locale}&appearance=${appearance}`;

function PagePreview({scenario, device, locale, appearance}) {
  const container = useRef(null);
  const frame = useRef(null);
  const [near, setNear] = useState(false);
  const [width, setWidth] = useState(900);
  const [height, setHeight] = useState(device === 'mobile' ? 844 : 960);
  const [ready, setReady] = useState(false);
  const viewportWidth = device === 'mobile' ? 390 : 1440;
  const scale = Math.min(1, width / viewportWidth);

  useEffect(() => {
    const element = container.current;
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {rootMargin: '1200px 0px'});
    observer.observe(element);
    const resize = new ResizeObserver(([entry]) => setWidth(Math.max(1, entry.contentRect.width)));
    resize.observe(element);
    return () => {observer.disconnect(); resize.disconnect();};
  }, []);

  useEffect(() => {
    setHeight(device === 'mobile' ? 844 : 960);
    setReady(false);
  }, [device, locale, appearance]);

  useEffect(() => {
    function receive(event) {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      const data = event.data;
      if (data?.type !== 'bemine-review-size' || data.id !== scenario.id) return;
      const nextHeight = Number(data.height);
      if (Number.isFinite(nextHeight) && nextHeight >= 120 && nextHeight <= 30000) {
        setHeight(nextHeight);
        setReady(true);
      }
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [scenario.id]);

  return <div className={`audit-preview audit-preview-${device}`} ref={container} style={{height: Math.ceil(height * scale)}}>
    {near ? <iframe
      key={`${device}-${locale}-${appearance}`}
      ref={frame}
      className="audit-frame"
      title={`${scenario.title} · ${device === 'mobile' ? '手机' : '桌面'}预览`}
      src={frameUrl(scenario.id, locale, appearance)}
      tabIndex={-1}
      aria-hidden="true"
      scrolling="no"
      style={{width: viewportWidth, height, transform: `scale(${scale})`, left: `calc(50% - ${viewportWidth * scale / 2}px)`}}
    /> : <div className="audit-preview-status"><Monitor size={25}/><span>滚动至此处加载页面预览</span></div>}
    {near && !ready && <div className="audit-preview-loading" role="status">正在准备完整页面…</div>}
  </div>;
}

export default function ReviewBook() {
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('all');
  const [pendingOnly, setPendingOnly] = useState(false);
  const [device, setDevice] = useState('desktop');
  const [locale, setLocale] = useState('zh');
  const [appearance, setAppearance] = useState('light');
  const [reviews, setReviews] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) setReviews(saved);
    } catch {setStorageError(true);}
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {localStorage.setItem(STORAGE_KEY, JSON.stringify(reviews)); setStorageError(false);}
    catch {setStorageError(true);}
  }, [reviews, loaded]);

  const reviewedCount = reviewScenarios.filter(item => reviews[item.id]?.done).length;
  const visible = useMemo(() => reviewScenarios.filter(item => {
    const matchesSearch = `${numberOf(item.id)} ${item.id} ${item.title} ${item.group} ${item.entry || ''} ${item.note || ''}`.toLowerCase().includes(search.trim().toLowerCase());
    return matchesSearch && (group === 'all' || item.group === group) && (!pendingOnly || !reviews[item.id]?.done);
  }), [search, group, pendingOnly, reviews]);
  const visibleGroups = groups.filter(name => visible.some(item => item.group === name));
  function updateReview(id, change) {
    setReviews(previous => ({...previous, [id]: {...previous[id], ...change, updatedAt: new Date().toISOString()}}));
  }
  function exportReview(format) {
    const generatedAt = new Date().toISOString();
    const pages = reviewScenarios.map(item => ({number: numberOf(item.id), ...item, reviewed: Boolean(reviews[item.id]?.done), feedback: reviews[item.id]?.note || '', updatedAt: reviews[item.id]?.updatedAt || null}));
    const payload = {project: '贝矿 BEMine', generatedAt, total: pages.length, reviewed: reviewedCount, display: {device, locale, appearance}, pages, coverageGaps: reviewGaps};
    const markdown = ['# 贝矿 BEMine · 页面审查意见', '', `导出时间：${generatedAt}`, `审查进度：${reviewedCount} / ${pages.length}`, `预览设置：${device === 'mobile' ? '手机' : '桌面'} · ${locale === 'zh' ? '中文' : 'English'} · ${appearance === 'light' ? '日常' : '深色'}`, '', ...pages.flatMap(item => [`## ${item.number} · ${item.id} · ${item.title}`, '', `- 分组：${item.group}`, `- 入口：${item.entry || '见页面说明'}`, `- 状态：${item.reviewed ? '已审查' : '待审查'}`, `- 页面说明：${item.note || '—'}`, '', '修改意见：', '', item.feedback || '（未填写）', '']), '## 尚未实现或不能完整展示的部分', '', ...reviewGaps.flatMap(item => [`### ${item.title}`, '', item.detail, ''])].join('\n');
    const blob = new Blob([format === 'json' ? JSON.stringify(payload, null, 2) : markdown], {type: format === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `BEMine-页面审查-${generatedAt.slice(0, 10)}.${format === 'json' ? 'json' : 'md'}`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(`已导出 ${format === 'json' ? 'JSON' : 'Markdown'} 修改意见，包含全部页面。`);
  }
  function navigateTo(id) {
    document.getElementById(`audit-${id}`)?.scrollIntoView({behavior: 'smooth', block: 'start'});
  }

  return <div className="audit-book">
    <header className="audit-header">
      <div className="audit-header-inner">
        <div className="audit-brandline"><span className="audit-brand">BEMine</span><span>贝矿 · 页面审查册 · v5</span><a href={`${basePath}/#home`} target="_blank" rel="noreferrer">打开网站 <ArrowUpRight size={16}/></a></div>
        <div className="audit-introduction"><div><p className="audit-eyebrow">一份清单，完整审查</p><h1>所有页面与关键状态，一次看全。</h1><p>按编号逐页查看，在下方写下修改意见并勾选「已审查」。切换设备、语言与外观，检查同一页面的不同呈现。</p></div><div className="audit-progress"><span><CheckCheck size={19}/> 审查进度</span><strong>{reviewedCount}<small> / {reviewScenarios.length}</small></strong><progress max={reviewScenarios.length} value={reviewedCount}/><span>还剩 {reviewScenarios.length - reviewedCount} 项</span></div></div>
        <div className="audit-instructions"><span><b>01</b> 浏览完整页面</span><span><b>02</b> 写意见、标记已审查</span><span><b>03</b> 导出意见发回修改</span><a className="audit-checklist" href={`${basePath}/review-files/bemine-review-checklist.md`} download><Download size={14}/>下载完整清单</a></div>
      </div>
    </header>

    <div className="audit-toolbar">
      <div className="audit-toolbar-inner">
        <div className="audit-toolbar-line"><label className="audit-search"><Search size={18}/><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索编号、页面或入口" aria-label="搜索页面"/></label><label className="audit-select"><span>分组</span><select aria-label="页面分组" value={group} onChange={event => setGroup(event.target.value)}><option value="all">全部页面</option>{groups.map(name => <option key={name} value={name}>{name}</option>)}</select></label><label className="audit-checkbox"><input type="checkbox" checked={pendingOnly} onChange={event => setPendingOnly(event.target.checked)}/>只看待审查</label><div className="audit-exports"><button onClick={() => exportReview('md')}><Download size={16}/>导出修改意见</button><button className="audit-json" onClick={() => exportReview('json')}>JSON</button></div></div>
        <div className="audit-toolbar-line audit-options"><div className="audit-device" role="group" aria-label="预览设备"><button aria-pressed={device === 'desktop'} onClick={() => setDevice('desktop')}><Monitor size={16}/>桌面 1440</button><button aria-pressed={device === 'mobile'} onClick={() => setDevice('mobile')}><Smartphone size={16}/>手机 390</button></div><label className="audit-select"><span>页面语言</span><select aria-label="预览语言" value={locale} onChange={event => setLocale(event.target.value)}><option value="zh">中文</option><option value="en">English</option></select></label><label className="audit-select"><span>页面外观</span><select aria-label="预览外观" value={appearance} onChange={event => setAppearance(event.target.value)}><option value="light">日常</option><option value="dark">深色</option></select></label><span className="audit-save-state">{storageError ? '本机保存不可用，请及时导出意见' : '意见自动保存在当前浏览器'} · 显示 {visible.length} / {reviewScenarios.length} 项</span></div>
      </div>
    </div>

    <main className="audit-main">
      <aside className="audit-directory">
        <details open><summary><List size={18}/>审查目录<ChevronDown size={15}/></summary><nav aria-label="页面审查目录">{visibleGroups.map(name => <div className="audit-directory-group" key={name}><h2>{name}</h2>{visible.filter(item => item.group === name).map(item => <button onClick={() => navigateTo(item.id)} key={item.id}><span className="audit-directory-number">{item.id}</span><span>{item.title}</span>{reviews[item.id]?.done && <Check size={14} className="audit-done-icon"/>}</button>)}</div>)}</nav></details>
      </aside>
      <div className="audit-content">
        <p className="audit-context">审查基准：2026-09-26 · v5。以下使用网站实际组件呈现预置页面与关键状态，动效已暂停；需要查看操作时，点击「打开单页」。预览缩放不改变所选设备的排版宽度。</p>
        {notice && <div className="audit-notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="关闭导出提示">×</button></div>}
        {visible.length === 0 && <div className="audit-empty"><CheckCheck size={32}/><h2>{pendingOnly && !search && group === 'all' ? '所有页面均已审查' : '没有符合条件的页面'}</h2><p>可以调整搜索或分组，查看其余页面。</p><button onClick={() => {setSearch(''); setGroup('all'); setPendingOnly(false);}}>显示全部页面</button></div>}
        {visible.map(scenario => <article id={`audit-${scenario.id}`} key={scenario.id} className={`audit-card${reviews[scenario.id]?.done ? ' audit-card-reviewed' : ''}`}>
          <div className="audit-card-heading"><div className="audit-number">{numberOf(scenario.id)}</div><div className="audit-card-title"><span>{scenario.id} · {scenario.group}</span><h2>{scenario.title}</h2></div><a className="audit-open" href={frameUrl(scenario.id, locale, appearance)} target="_blank" rel="noreferrer">打开单页<ArrowUpRight size={16}/></a></div>
          <div className="audit-card-description">{scenario.entry && <p><strong>入口</strong>{scenario.entry}</p>}{scenario.note && <p><strong>审查内容</strong>{scenario.note}</p>}</div>
          <PagePreview scenario={scenario} device={device} locale={locale} appearance={appearance}/>
          <div className="audit-feedback"><div className="audit-feedback-heading"><label htmlFor={`feedback-${scenario.id}`}>修改意见 <span>{scenario.id} · #{numberOf(scenario.id)}</span></label><label className="audit-checkbox"><input type="checkbox" checked={Boolean(reviews[scenario.id]?.done)} onChange={event => updateReview(scenario.id, {done: event.target.checked})}/>已审查</label></div><textarea id={`feedback-${scenario.id}`} value={reviews[scenario.id]?.note || ''} onChange={event => updateReview(scenario.id, {note: event.target.value})} placeholder="例如：标题改为…；手机端按钮靠下；希望增加…" rows={3}/></div>
        </article>)}
        <section className="audit-coverage"><div className="audit-coverage-title"><h2>覆盖范围与待补充部分</h2><span>{reviewGaps.length} 项说明</span></div><p>以下部分单独列出，避免将尚未实现的功能当作已完成页面。品牌备选见 <a className="audit-appendix" href={`${basePath}/design.html`} target="_blank" rel="noreferrer">历史设计附录 ↗</a>。</p>{reviewGaps.map((item, index) => <div key={`${item.title}-${index}`}><h3>{item.title}</h3><p>{item.detail}</p></div>)}</section>
        <footer className="audit-footer"><span>贝矿 BEMine · 页面审查册</span><button onClick={() => exportReview('md')}><Download size={16}/>导出全部修改意见</button><a href="#" onClick={event => {event.preventDefault(); window.scrollTo({top: 0, behavior: 'smooth'});}}>回到顶部 ↑</a></footer>
      </div>
    </main>
  </div>;
}
