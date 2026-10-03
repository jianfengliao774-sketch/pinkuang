/** Synthetic local visual/logic checks; each phase has a hard 28-second lifetime. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMobileLayoutPreviewServer } from './mobile-layout-preview-server.mjs';
import { createMobileLayoutPreviewFixture } from './mobile-layout-preview-fixture.mjs';

const phase = process.env.BEMINE_CHECK_PHASE || process.argv.find(arg => arg.startsWith('--phase='))?.slice(8) || 'mobile-390';
assert(/^(?:mobile-(?:finance-)?(?:320|390|430)|desktop(?:-finance)?(?:-baseline)?|wrapper)$/.test(phase), 'Unknown local check phase.');
const width = phase.startsWith('mobile-') ? Number(phase.match(/\d+$/)[0]) : 1440;
const output = process.env.BEMINE_BROWSER_OUTPUT || '/tmp/pinkuang-mobile-layout-20261003/round2/evidence';
const startedMs = Date.now();
const fixtureClockMs = Date.UTC(2026, 9, 3, 10, 5, 0);
await mkdir(output, { recursive: true });
const checks = [], errors = [], browserWrites = [], blockedExternal = [], captures = [];
let preview, browser, page;
const hardStop = setTimeout(() => process.exit(124), 28_000);
const gracefulStop = setTimeout(() => { void browser?.close(); void preview?.close(); }, 27_000);
const resultFile = join(output, phase + '.json');
const plainJson = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2);
await writeFile(resultFile, plainJson({ passed: null, status: 'running', synthetic: true, phase,
  startedAt: new Date().toISOString(), limitSeconds: 28 }));

async function settle(route = 'pools') {
  await page.waitForFunction(route => {
    const main = document.querySelector('main'), ready = main?.dataset.readyRoute;
    return (ready === route || ready?.startsWith(route + '/') && ready === location.hash.slice(1))
      && main?.getAttribute('aria-busy') === 'false';
  }, route);
  if (route === 'pools') await page.waitForFunction(() => document.querySelector('[data-project-directory="unified"]')?.getAttribute('aria-busy') === 'false');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function open(route) { await page.evaluate(hash => { location.hash = hash; }, route); await settle(route.split('/')[0]); }
async function connectSynthetic() {
  if (await page.locator('header button[aria-label^="打开钱包信息："]').count()) return;
  await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: '连接 效果预览钱包', exact: true }).click();
  await page.locator('header button[aria-label^="打开钱包信息："]').waitFor();
}
async function snapshot(name) {
  const path = join(output, phase + '-' + name + '.png');
  const prior = await page.evaluate(() => scrollY);
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path, fullPage: true, animations: 'disabled' }); captures.push(path);
  await page.evaluate(top => scrollTo({ top, behavior: 'instant' }), prior);
}
async function assertNoOverflow(label) {
  const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
    offenders: [...document.querySelectorAll('main *')].filter(el => {
      const r = el.getBoundingClientRect(), css = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && css.visibility !== 'hidden' && (r.right > innerWidth + 2 || r.left < -2);
    }).slice(0, 12).map(el => el.className || el.tagName) }));
  assert(geometry.scroll <= geometry.width + 1, `${label}: 横向溢出 ${plainJson(geometry)}`);
  checks.push(`${label}：页面无横向溢出`);
}
async function assertToolbar() {
  const controls = await page.locator('.topbar .top-actions').evaluate(element => [...element.children].map(child => {
    const r = child.getBoundingClientRect(); return { tag: child.tagName, class: child.className, x: r.x, y: r.y, w: r.width, h: r.height };
  }));
  assert.equal(controls.length, 5, '社区/通知/外观/语言/钱包应为五个操作');
  const centers = controls.map(r => r.y + r.h / 2);
  assert(Math.max(...centers) - Math.min(...centers) <= 3, `钱包与其他图标不在同一行：${plainJson(controls)}`);
  assert(controls.every(r => r.w >= 32 && r.h >= 32), '窄屏图标仍须有可操作尺寸');
  assert.equal(await page.getByRole('button', { name: '暂停动效', exact: true }).count(), 0);
  checks.push(`${width}px：顶部五个操作与钱包同一行，暂停动效已删除`);
}
async function assertMobileNavigation() {
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.sidebar.open')?.getBoundingClientRect().left >= -1);
  const geometry = await page.locator('.sidebar.open').evaluate(sidebar => {
    const bounds = sidebar.getBoundingClientRect();
    return { width: bounds.width, viewport: innerWidth, items: [...sidebar.querySelectorAll('.nav-item,.rules-link')]
      .filter(item => item.getBoundingClientRect().height > 0).map(item => {
        const range = document.createRange(); range.selectNodeContents(item); const r = range.getBoundingClientRect();
        return { text: item.textContent.trim(), size: getComputedStyle(item).fontSize,
          fullyVisible: r.left >= bounds.left && r.right <= bounds.right + 1 && r.top >= 0 && r.bottom <= innerHeight,
          clipped: item.scrollWidth > item.clientWidth + 1 };
      }) };
  });
  assert(Math.abs(geometry.width / geometry.viewport - .36) <= .005, `手机导航宽度应约 36%：${plainJson(geometry)}`);
  assert(geometry.items.length >= 8, '应验收实际完整导航');
  assert(geometry.items.every(item => item.size === '13px' && item.fullyVisible && !item.clipped),
    `手机菜单须 13px 且完整可见：${plainJson(geometry.items)}`);
  await snapshot('navigation');
  await page.locator('.mobile-scrim').click({ position: { x: width - 10, y: 90 } });
  await page.locator('.sidebar.open').waitFor({ state: 'detached' });
  checks.push('390px 实际侧栏占屏宽36%，菜单13px且无裁切');
}
async function assertAssetHeading() {
  const geometry = await page.locator('main[data-ready-route="overview"] .page-heading').evaluate(heading => {
    const title = heading.querySelector('h1').getBoundingClientRect();
    const action = heading.querySelector('.live-actions .btn').getBoundingClientRect();
    const copy = heading.querySelector('.live-mobile-copy'), range = document.createRange(); range.selectNodeContents(copy);
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
    return { titleCenter: title.y + title.height / 2, actionCenter: action.y + action.height / 2,
      text: copy.textContent, fontSize: getComputedStyle(copy).fontSize,
      lines: new Set(rects.map(rect => Math.round(rect.top))).size,
      fullyVisible: rects.every(rect => rect.left >= 0 && rect.right <= innerWidth + 1) };
  });
  assert(Math.abs(geometry.titleCenter - geometry.actionCenter) <= 3, `资产标题/刷新须同一行：${plainJson(geometry)}`);
  assert.equal(geometry.text, '查看项目持仓、已入账收益和待领取款项。');
  assert.equal(geometry.fontSize, '13px'); assert.equal(geometry.lines, 1); assert.equal(geometry.fullyVisible, true);
  checks.push('390px 资产标题和刷新居中同一行，完整新文案一行13px');
}
async function assertPageHeading(label, copyText) {
  const geometry = await page.locator('main .page-heading').evaluate(heading => {
    const h = heading.querySelector('h1').getBoundingClientRect();
    const buttons = [...heading.querySelectorAll('button')];
    const button = buttons.find(item => /^(刷新|Refresh)$/.test(item.textContent.trim())) || buttons.find(item => item.classList.contains('btn'));
    const b = button?.getBoundingClientRect(), bounds = heading.getBoundingClientRect();
    const copy = heading.querySelector('.live-mobile-copy') || heading.querySelector('p');
    const range = document.createRange(); range.selectNodeContents(copy);
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
    return { titleCenter: h.y + h.height / 2, buttonCenter: b ? b.y + b.height / 2 : null,
      buttonRight: b?.right, headingRight: bounds.right, text: copy.innerText,
      fontSize: getComputedStyle(copy).fontSize, lines: new Set(rects.map(rect => Math.round(rect.top))).size,
      clipped: rects.some(rect => rect.left < 0 || rect.right > innerWidth + 1) };
  });
  assert.notEqual(geometry.buttonCenter, null, `${label}必须使用实际刷新按钮验收`);
  assert(Math.abs(geometry.titleCenter - geometry.buttonCenter) <= 3, `${label}标题/刷新须同排：${plainJson(geometry)}`);
  assert(Math.abs(geometry.buttonRight - geometry.headingRight) <= 2, `${label}刷新须靠右：${plainJson(geometry)}`);
  if (copyText) {
    assert.equal(geometry.text, copyText); assert.equal(geometry.fontSize, '13px');
    assert.equal(geometry.lines, 1); assert.equal(geometry.clipped, false);
  }
  checks.push(`${width}px ${label}标题与刷新居中同排、刷新靠右${copyText ? '，指定文案完整一行13px' : ''}`);
}
async function assertSectionRefresh(selector, titleLabel, buttonLabel, website = false) {
  const heading = page.locator(selector);
  assert.equal(await heading.count(), 1, `${titleLabel}须验收实际区块标题`);
  const geometry = await heading.evaluate((head, args) => {
    const title = head.querySelector('h2'), button = [...head.querySelectorAll('button')]
      .find(item => item.textContent.trim() === args.buttonLabel);
    const h = title.getBoundingClientRect(), b = button?.getBoundingClientRect(), bounds = head.getBoundingClientRect(), css = getComputedStyle(head);
    const range = document.createRange(); range.selectNodeContents(title);
    const titleText = range.getBoundingClientRect(), link = head.querySelector('a'), a = link?.getBoundingClientRect();
    return { title: title.textContent.trim(), titleCenter: h.y + h.height / 2,
      buttonCenter: b ? b.y + b.height / 2 : null, buttonRight: b?.right,
      headingRight: bounds.right - parseFloat(css.paddingRight) - parseFloat(css.borderRightWidth),
      clipped: head.scrollWidth > head.clientWidth + 1 || title.scrollWidth > title.clientWidth + 1
        || titleText.left < -1 || titleText.right > innerWidth + 1 || (b && (b.left < 0 || b.right > innerWidth + 1)),
      website: a ? { text: link.textContent.trim(), width: a.width, height: a.height,
        left: a.left, right: a.right } : null };
  }, { buttonLabel });
  assert.equal(geometry.title, titleLabel);
  assert.notEqual(geometry.buttonCenter, null, `${titleLabel}缺少实际${buttonLabel}按钮`);
  assert(Math.abs(geometry.titleCenter - geometry.buttonCenter) <= 3,
    `${titleLabel}与${buttonLabel}须居中同排：${plainJson(geometry)}`);
  assert(Math.abs(geometry.buttonRight - geometry.headingRight) <= 2,
    `${titleLabel}的${buttonLabel}须靠右：${plainJson(geometry)}`);
  assert.equal(geometry.clipped, false, `${titleLabel}标题与刷新区块不能横向溢出：${plainJson(geometry)}`);
  if (website) {
    assert(geometry.website?.text.includes('Firsto 网站'), 'Firsto须保留实际网站链接');
    assert(geometry.website.width >= 44 && geometry.website.height >= 44
      && geometry.website.left >= 0 && geometry.website.right <= width + 1,
    `Firsto网站链接须有44px触控尺寸且完整可见：${plainJson(geometry.website)}`);
  }
  checks.push(`${width}px ${titleLabel}与${buttonLabel}居中同排、动作靠右且无溢出${website ? '，网站链接保持44px触控' : ''}`);
}
async function assertCompactProjectEntrances(root) {
  const entries = await root.locator('.live-mobile-project-actions').evaluateAll(rows => rows.map(row => {
    const css = getComputedStyle(row), buttons = [...row.querySelectorAll('button')].filter(button => button.getBoundingClientRect().height > 0);
    return { height: row.getBoundingClientRect().height, margin: parseFloat(css.marginTop), padding: parseFloat(css.paddingTop),
      buttons: buttons.map(button => ({ text: button.innerText, height: button.getBoundingClientRect().height })) };
  }));
  assert(entries.length > 0);
  assert(entries.every(row => row.padding <= 2 && row.margin <= 6 && row.height <= 50 && row.buttons.every(button => button.height >= 44)),
    `手机项目入口保留44px触控且压缩上下留白：${plainJson(entries)}`);
  checks.push(`${width}px 项目详情入口整行≤50px，上留白≤6px，按钮保持44px触控`);
}

async function assertFinancialCards(variant, expectedCount) {
  const root = page.locator(`.live-mobile-financial-cards[data-mobile-financial-view="${variant}"]:visible`);
  await root.waitFor();
  const cards = root.locator('article[data-financial-key]');
  assert.equal(await cards.count(), expectedCount);
  const expected = variant === 'claims' ? ['bem', 'bnb'] : ['remaining', 'unit', 'capacity', 'seller', 'expires'];
  const desktop = page.locator(variant === 'claims' ? '.live-claim-table-desktop' : '.live-order-table-desktop');
  assert.equal(await desktop.count(), 1); assert.equal(await desktop.isVisible(), false);
  const beforeActions = await desktop.locator('tbody tr td:last-child').evaluateAll(cells => cells.map(cell =>
    [...cell.querySelectorAll('button')].map(button => ({ text: button.textContent.trim(), disabled: button.disabled }))));
  const afterActions = [];
  for (const card of await cards.all()) {
    const fields = await card.locator('dl div[data-financial-field]').evaluateAll(items => items.map(item => item.dataset.financialField));
    assert.deepEqual(fields, expected);
    const detail = await card.evaluate(article => ({ height: article.getBoundingClientRect().height,
      clipped: [...article.querySelectorAll('dl,dd,button')].filter(item => item.scrollWidth > item.clientWidth + 1)
        .map(item => item.textContent.trim()) }));
    assert.deepEqual(detail.clipped, [], `${variant}字段和动作不能裁切`);
    assert(detail.height <= (variant === 'claims' ? 250 : 400), `${variant}卡片应紧凑：${detail.height}px`);
    const actions = await card.locator('.live-mobile-financial-actions button').evaluateAll(buttons => buttons.map(button =>
      ({ text: button.textContent.trim(), disabled: button.disabled })));
    assert(actions.length >= (variant === 'claims' ? 3 : 1));
    if (variant === 'orders') assert(actions.every(action => action.disabled), '只读订单快照不得解锁交易执行');
    else assert(actions.filter(action => /暂无可领取|No claimable/.test(action.text)).every(action => action.disabled),
      '零权益的领取按钮必须保持未就绪');
    afterActions.push(actions);
    if (variant === 'orders') assert.match(await card.locator('[data-financial-field="expires"]').innerText(), /20\d{2}\/\d{1,2}\/\d{1,2}/);
  }
  assert.deepEqual(afterActions, beforeActions, `${variant}必须复用原表对应按钮文本与readiness`);
  checks.push(`${width}px ${variant}卡片：完整对应字段、紧凑几何、原按钮文本/权限保持${variant === 'orders' ? '且订单交易未就绪' : '且零权益不可领取'}`);
  return root;
}

async function assertAssetActionRow(holdings) {
  const geometry = await holdings.locator('.live-pool-row-actions').evaluateAll(rows => rows.map(row => {
    const items = [...row.children].filter(item => item.getBoundingClientRect().height > 0);
    const boxes = items.map(item => { const r = item.getBoundingClientRect(); return { text: item.innerText,
      size: parseFloat(getComputedStyle(item).fontSize), center: r.top + r.height / 2,
      clipped: item.scrollWidth > item.clientWidth + 1, button: item.tagName === 'BUTTON' }; });
    return { items: boxes, singleLine: Math.max(...boxes.map(box => box.center)) - Math.min(...boxes.map(box => box.center)) <= 3 };
  }));
  assert(geometry.length >= 6);
  assert(geometry.every(row => row.singleLine && row.items.every(item => !item.clipped && item.size >= (item.button ? 12 : 11))),
    `资产挂单、原因、查看须同排且字体可读：${plainJson(geometry)}`);
  assert(await holdings.locator('.live-order-state:visible').count() > 0, '不可挂牌原因不能删除');
  checks.push(`${width}px 资产挂单/不可挂牌原因/查看同排，按钮≥12px、原因≥11px且无裁切`);
}

async function financePageFingerprint() {
  return page.locator('main').evaluate(main => {
    const normalize = text => text.replace(/\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/g, '{date}')
      .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, '{clock}');
    const selectors = ['.page-heading h1', '.page-heading p', '.page-heading .btn', '.metric-label', '.metric-value',
      '.metric-note', '.table-wrap th', '.table-wrap td', '.table-wrap button', '.firsto-board-table-wrap th',
      '.firsto-board-table-wrap td', '.firsto-board-table-wrap button', '.bemine-hero h1', '.bemine-hero-copy>p',
      '.bemine-hero .btn', '.bemine-scene'];
    return selectors.flatMap(selector => [...main.querySelectorAll(selector)].filter(el => {
      const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    }).map(el => {
      const css = getComputedStyle(el), r = el.getBoundingClientRect();
      return { selector, tag: el.tagName, text: normalize(el.innerText), disabled: el.tagName === 'BUTTON' ? el.disabled : null,
        style: { fontSize: css.fontSize, fontFamily: css.fontFamily, fontWeight: css.fontWeight,
          lineHeight: css.lineHeight, color: css.color, padding: css.padding, gap: css.gap, borderRadius: css.borderRadius },
        geometry: { width: r.width, height: r.height } };
    }));
  });
}

async function checkDesktopFinance() {
  const views = {}; await connectSynthetic();
  for (const [key, route, tab] of [['shares', 'market', '份额交易'], ['mine', 'market', '我的挂单'],
    ['rewards', 'rewards'], ['overview', 'overview'], ['home', 'home']]) {
    await open(route);
    if (tab) {
      await page.locator('main > .tabs').getByRole('button', { name: tab, exact: true }).click();
      await page.getByRole('button', { name: key === 'mine' ? '解锁份额' : '买入份额', exact: true }).first().waitFor();
      await page.locator('main .firsto-board-table-wrap tbody tr').first().waitFor();
    }
    if (route === 'overview') await page.waitForFunction(() => document.querySelector('[data-asset-directory="unified"]')?.getAttribute('aria-busy') === 'false');
    await page.evaluate(() => document.fonts.ready);
    views[key] = await financePageFingerprint(); assert(views[key].length > 0);
    await snapshot(key);
  }
  assert.equal(await page.locator('.bemine-scene:visible').count(), 1, 'PC首页须保留hero图');
  if (phase === 'desktop-finance') {
    const prior = JSON.parse(await readFile(process.env.BEMINE_BASELINE_FINANCE_RESULTS || join(output, 'desktop-finance-baseline.json'), 'utf8'));
    assert.equal(prior.passed, true);
    for (const [key, nodes] of Object.entries(views)) {
      const before = prior.views[key]; assert.equal(nodes.length, before.length, `${key} PC可见内容数变化`);
      nodes.forEach((node, i) => {
        const { geometry, ...actual } = node, { geometry: old, ...expected } = before[i];
        assert.deepEqual(actual, expected, `${key} PC文本/字体/权限变化 ${i}`);
        for (const dimension of ['width', 'height']) assert(Math.abs(geometry[dimension] - old[dimension]) <= 2,
          `${key} PC几何变化 ${i}/${dimension}：${geometry[dimension]} vs ${old[dimension]}`);
      });
    }
    checks.push('1440px份额交易/我的挂单/逐池领取/资产/首页与旧版的文本、字体、按钮disabled及几何一致，PC保留hero');
  } else checks.push('1440px财务、资产、首页PC基线含权限与实际计算样式已保存');
  await writeFile(resultFile, plainJson({ passed: true, synthetic: true, phase, width, views, checks, errors,
    browserWrites, blockedExternal, captures, broadcastCount: 0, elapsedMs: Date.now() - startedMs }));
}

async function checkMobileFinance() {
  await assertToolbar(); await assertPageHeading('参与拼矿'); await connectSynthetic();
  await open('overview');
  await page.waitForFunction(() => document.querySelector('[data-asset-directory="unified"]')?.getAttribute('aria-busy') === 'false');
  await assertPageHeading('资产总览', '查看项目持仓、已入账收益和待领取款项。');
  const holdings = page.locator('[data-asset-directory="unified"] .live-mobile-projects:visible');
  await assertAssetActionRow(holdings); await assertCompactProjectEntrances(holdings);
  const peerFonts = await holdings.locator('.live-mobile-project-card[data-project-kind="portfolio"]').first().evaluate(card => {
    const font = selector => { const css = getComputedStyle(card.querySelector(selector)); return { size: css.fontSize, family: css.fontFamily, weight: css.fontWeight }; };
    return { title: font('.live-mobile-project-identity strong'), label: font('dl dt'), value: font('dl dd') };
  });
  await snapshot('asset-actions'); await assertNoOverflow('紧凑持仓');
  let mode = 'pass', release, pendingGate;
  await page.route(/\/api\/chain-index\/v1\/display\/portfolios(?:\?|$)/, async route => {
    if (mode === 'hold') await pendingGate;
    if (mode === 'fail') return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"synthetic_partial_unavailable"}' });
    return route.continue();
  });
  mode = 'hold'; pendingGate = new Promise(resolve => { release = resolve; });
  await page.getByRole('button', { name: '刷新', exact: true }).first().click();
  const updating = page.locator('[data-asset-directory="unified"] .subtle-note[role="status"]'); await updating.waitFor();
  const padding = await updating.evaluate(note => {
    const panel = note.closest('[data-asset-directory="unified"]').getBoundingClientRect(), range = document.createRange();
    range.selectNodeContents(note); const text = range.getBoundingClientRect();
    return { left: text.left - panel.left, right: panel.right - text.right };
  });
  assert(padding.left >= 12 && padding.right >= 12, `刷新提示须有合适内边距：${plainJson(padding)}`);
  mode = 'pass'; release();
  await page.waitForFunction(() => document.querySelector('[data-asset-directory="unified"]')?.getAttribute('aria-busy') === 'false');
  mode = 'fail'; await page.getByRole('button', { name: '刷新', exact: true }).first().click();
  await page.locator('[data-asset-directory="unified"] [role="alert"]').waitFor();
  await page.getByText('当前汇总仅包含已加载持仓。', { exact: true }).waitFor();
  assert((await holdings.locator('.live-mobile-project-card').count()) >= 4, '部分读取失败不能清空可用持仓');
  assert((await page.locator('[data-asset-summary="unified"]').innerText()).includes('已加载'), 'partial状态须明确保留');
  mode = 'pass'; await page.locator('[data-asset-directory="unified"] [role="alert"]').getByRole('button', { name: '重新读取', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-asset-directory="unified"] [role="alert"]'));
  checks.push(`${width}px刷新提示内边距≥12px；持仓partial/错误状态保留并可明确重试恢复`);

  await open('market'); await assertPageHeading('矿机转让');
  await page.locator('.firsto-board-mobile-card').first().waitFor();
  await assertSectionRefresh('.firsto-board-head', '真实矿机市场 · 日产能价', '刷新', true);
  await assertSectionRefresh('.portfolio-panel > .portfolio-heading', '多矿机预算项目', '刷新项目');
  await assertNoOverflow('Firsto与多矿机预算项目标题/刷新区块');
  const firstoFonts = await page.locator('.firsto-board-mobile-card').first().evaluate(card => {
    const font = selector => { const css = getComputedStyle(card.querySelector(selector)); return { size: css.fontSize, family: css.fontFamily, weight: css.fontWeight }; };
    return { title: font('header strong'), label: font('.firsto-board-mobile-metrics dt'), value: font('.firsto-board-mobile-metrics dd') };
  });
  assert.deepEqual(firstoFonts, peerFonts, `Firsto与多矿机卡片同层字体须统一：${plainJson({firstoFonts,peerFonts})}`);
  checks.push(`${width}px Firsto与多矿机卡片的标题、标签、数字实际字体同层统一`);
  await page.locator('main > .tabs').getByRole('button', { name: '份额交易', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.live-mobile-financial-cards[data-mobile-financial-view="orders"] article').length === 3);
  const shares = await assertFinancialCards('orders', 3);
  assert((await shares.getByRole('button', { name: '买入份额', exact: true }).count()) >= 1);
  assert((await shares.getByRole('button', { name: '撤单', exact: true }).count()) >= 1);
  await page.waitForFunction(() => {
    const fields = [...document.querySelectorAll('.live-mobile-financial-cards[data-mobile-financial-view="orders"] [data-financial-field="capacity"] dd')];
    return fields.length === 3 && fields.every(field => !/计算中|Loading/.test(field.textContent));
  });
  const capacityRead = shares.locator('[data-financial-field="capacity"] dd button');
  if (await capacityRead.count()) await capacityRead.first().click();
  await page.waitForFunction(() => [...document.querySelectorAll('.live-mobile-financial-cards[data-mobile-financial-view="orders"] [data-financial-field="capacity"] dd strong')]
    .filter(node => /\d/.test(node.textContent)).length === 3);
  assert((await shares.locator('[data-financial-field="capacity"] dd strong').allTextContents()).every(value => Number(value.replace(/,/g, '')) > 0));
  await assertFinancialCards('orders', 3);
  checks.push(`${width}px日产能价只读查询得到三项有效数字，按钮权限保持未就绪`);
  await snapshot('share-orders');
  await page.locator('main > .tabs').getByRole('button', { name: '我的挂单', exact: true }).click();
  await page.waitForFunction(() => {
    const fields = [...document.querySelectorAll('.live-mobile-financial-cards[data-mobile-financial-view="orders"] [data-financial-field="seller"] dd')];
    return fields.length === 3 && fields.every(field => /0x0000.*0b0b/i.test(field.textContent));
  });
  const mine = await assertFinancialCards('orders', 3);
  const sellers = await mine.locator('[data-financial-field="seller"] dd').allTextContents();
  assert(sellers.every(text => /0x0000.*0b0b/i.test(text)), `我的挂单只能是普通示例账户：${plainJson(sellers)}`);
  assert.equal(await mine.getByRole('button', { name: '买入份额', exact: true }).count(), 0);
  assert.equal(await mine.getByRole('button', { name: '解锁份额', exact: true }).count(), 1);
  assert.equal(await mine.getByRole('button', { name: '撤单', exact: true }).count(), 2);
  assert.match(await mine.innerText(), /已到期.*待解锁/); assert.match(await mine.innerText(), /这是你的挂单/);
  await assertNoOverflow('份额交易与本人挂单'); await snapshot('own-orders');

  await open('rewards');
  await assertPageHeading('收益中心', '收益归集后由本人领取；权益永久保留。');
  await page.waitForFunction(() => document.querySelector('.live-price-metric .metric-value')?.textContent.includes('45.43002'));
  const metrics = await page.locator('main > .metrics .metric').evaluateAll(items => items.map(metric => {
    const label = metric.querySelector('.metric-label'), value = metric.querySelector('.metric-value');
    const range = document.createRange(); range.selectNodeContents(value);
    const bounds = value.getBoundingClientRect(), text = range.getBoundingClientRect();
    return { title: label.innerText, weight: getComputedStyle(label).fontWeight, value: value.innerText,
      clipped: value.scrollWidth > value.clientWidth + 1 || text.left < bounds.left - 1 || text.right > bounds.right + 1 };
  }));
  assert.equal(metrics.length, 4); assert(metrics.every(metric => metric.weight === '700' && !metric.clipped),
    `四项收益指标标题700、完整数值：${plainJson(metrics)}`);
  checks.push(`${width}px 四项收益指标标题700，数字和单位完整无裁切`);
  await assertFinancialCards('claims', 4); await assertNoOverflow('逐池领取'); await snapshot('pool-claims');
  await open('governance'); await assertPageHeading('共同决策'); await assertNoOverflow('共同决策');
  await open('records'); await assertPageHeading('公开记录');
  await open('home'); assert.equal(await page.locator('.bemine-scene:visible').count(), 0, '手机首页须隐藏hero图');
  await assertNoOverflow('手机无图首页'); await snapshot('compact-home');
  checks.push(`${width}px手机首页无hero图；原按钮/数据/风险状态保持只读`);
  await writeFile(resultFile, plainJson({ passed: true, synthetic: true, phase, width, checks, errors,
    browserWrites, blockedExternal, captures, broadcastCount: 0, elapsedMs: Date.now() - startedMs, physicalDevice: false }));
}
const expectedFields = { Funding: ['shares', 'unit', 'hash', 'daily', 'capacity'],
  Active: ['shares', 'unit', 'members', 'daily', 'capacity'], Listed: ['shares', 'unit', 'hash', 'daily', 'capacity'] };
async function assertFields(container, category, summary = false) {
  const cards = container.locator(summary ? '.live-mobile-project-summary-row' : '.live-mobile-project-card');
  assert((await cards.count()) > 0, `${category} 无手机项目行`);
  for (const card of await cards.all()) {
    if (summary) {
      await card.locator('summary').click(); assert.equal(await card.locator('details').getAttribute('open'), '');
      const quick = await card.locator('.live-mobile-project-quick-fields > div').evaluateAll(rows => rows.map(row => row.dataset.projectField));
      assert.deepEqual(quick, category === 'Funding' ? ['shares', 'unit'] : category === 'Active' ? ['daily', 'capacity'] : ['unit', 'capacity']);
    }
    const fields = await card.locator('dl > div[data-project-field]').evaluateAll(rows => rows.map(row => row.dataset.projectField));
    assert.deepEqual([...fields].sort(), [...expectedFields[category]].sort(), `${category} 字段不匹配：${fields.join(',')}`);
    assert.equal(new Set(fields).size, fields.length, '手机指标不能重复');
    const clipped = await card.evaluate(element => [...element.querySelectorAll('dl,dd')].filter(field =>
      field.getBoundingClientRect().width > 0 && field.scrollWidth > field.clientWidth + 1).map(field => field.textContent));
    assert.deepEqual(clipped, [], `${category} 指标不能被裁切或要求横向滑动`);
    const identity = await card.locator('.live-mobile-project-identity').innerText();
    if (await card.getAttribute('data-project-kind') === 'single') {
      assert.match(identity, /Task \d+/); assert(!/0x[\da-f]{3}/i.test(identity), '手机目录身份不能显示地址');
    }
  }
  checks.push(`${width}px ${category}${summary ? '总览展开' : '卡片'}：对应字段和 Task 正确`);
}
async function desktopFingerprint(directory) {
  return directory.evaluate(element => [...element.querySelectorAll('.table-wrap')].filter(wrapper => {
    const r = wrapper.getBoundingClientRect(); return r.width > 0 && r.height > 0;
  }).map(wrapper => {
    const table = wrapper.querySelector('table'); if (!table) return null;
    const style = getComputedStyle(table), r = wrapper.getBoundingClientRect();
    return { headers: [...table.querySelectorAll('thead th')].map(el => el.textContent.trim()),
      rows: [...table.querySelectorAll('tbody tr')].map(row => [...row.cells].map(cell => cell.textContent.trim())),
      style: { fontSize: style.fontSize, fontFamily: style.fontFamily, lineHeight: style.lineHeight,
        color: style.color, borderCollapse: style.borderCollapse },
      contentStyles: [...table.querySelectorAll('th,td,.asset-cell strong,.asset-cell small,.badge,.btn,.text-button')].map(el => {
        const css = getComputedStyle(el);
        return { fontSize: css.fontSize, fontFamily: css.fontFamily, fontWeight: css.fontWeight, lineHeight: css.lineHeight,
          color: css.color, textAlign: css.textAlign, padding: css.padding, borderRadius: css.borderRadius };
      }),
      widths: [...table.querySelectorAll('thead th')].map(el => Math.round(el.getBoundingClientRect().width * 10) / 10),
      wrapperWidth: Math.round(r.width * 10) / 10 };
  }).filter(Boolean));
}
async function checkPreviewWrapper(origin) {
  await page.goto(origin + '/preview.html');
  const frame = page.frames().find(frame => frame.url().startsWith(origin + '/bemine-v5/'));
  assert(frame, '预览壳必须嵌入实际产品页');
  await frame.waitForFunction(() => document.querySelector('[data-project-directory="unified"]')?.getAttribute('aria-busy') === 'false');
  for (const size of [320, 430, 390]) {
    await page.getByRole('button', { name: String(size), exact: true }).click();
    await frame.waitForFunction(size => innerWidth === size, size);
  }
  checks.push('预览壳320/430/390切换得到实际iframe对应宽度');
  assert.equal(await frame.locator('header button[aria-label^="打开钱包信息："]').count(), 0);
  await page.getByRole('button', { name: '我的资产', exact: true }).click();
  await frame.waitForFunction(() => document.querySelector('[data-asset-directory="unified"]')?.getAttribute('aria-busy') === 'false');
  assert((await frame.locator('[data-asset-directory="unified"] .live-mobile-project-card:visible').count()) >= 6);
  const wallet = await frame.evaluate(() => window.__BEMINE_EFFECT_PREVIEW__);
  assert.equal(wallet.synthetic, true); assert.equal(wallet.readOnly, true);
  assert.equal(wallet.account.toLowerCase(), '0x0000000000000000000000000000000000000b0b');
  assert.match(await frame.locator('header button[aria-label^="打开钱包信息："]').getAttribute('aria-label'), /0x0000000000000000000000000000000000000b0b/i);
  assert.equal(await page.locator('.preview-label').innerText(), '效果预览 · 合成账户与金额 · 无签名和交易');
  await snapshot('example-holdings-wrapper');
  for (const [label, route] of [['收益中心', 'rewards'], ['共同决策', 'governance']]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await frame.waitForFunction(route => document.querySelector('main')?.dataset.readyRoute === route
      && document.querySelector('main')?.getAttribute('aria-busy') === 'false', route);
    assert.equal(await frame.locator('header button[aria-label^="打开钱包信息："]').count(), 1);
  }
  checks.push('预览壳收益中心/共同决策可直接查看并保留普通示例连接');
  await page.getByRole('button', { name: '参与拼矿', exact: true }).click();
  await frame.waitForFunction(() => document.querySelector('main')?.dataset.readyRoute === 'pools'
    && document.querySelector('[data-project-directory="unified"]')?.getAttribute('aria-busy') === 'false');
  assert.equal(await frame.locator('header button[aria-label^="打开钱包信息："]').count(), 1);
  checks.push('预览壳我的资产实际点击仅连接示例provider，展示六项持仓；切页保留连接');
  await writeFile(resultFile, plainJson({ passed: true, synthetic: true, phase, width, checks, errors,
    browserWrites, blockedExternal, captures, broadcastCount: 0, physicalDevice: false }));
}

try {
  let base = process.env.BEMINE_TEST_URL;
  if (!base) {
    const defaultRoot = `/tmp/pinkuang-mobile-layout-20261003/round2/${phase.endsWith('-baseline') ? 'baseline' : 'updated'}/web/out`;
    preview = await createMobileLayoutPreviewServer({ root: process.env.BEMINE_PREVIEW_ROOT || defaultRoot,
      fixture: createMobileLayoutPreviewFixture({ orderEpochMs: fixtureClockMs }) });
    base = preview.base;
  }
  base = base.replace(/\/$/, ''); const origin = new URL(base).origin;
  assert.equal(new URL(base).hostname, '127.0.0.1', 'Only the explicit loopback preview is allowed.');
  const playwrightModule = process.env.BEMINE_PLAYWRIGHT_MODULE
    || '/Users/chcken/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
  const { chromium } = await import(playwrightModule);
  browser = await chromium.launch({ headless: true, channel: process.env.BEMINE_TEST_BROWSER || 'chrome' });
  const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 1000 : 844 },
    isMobile: width < 768, hasTouch: width < 768, serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(4500); page.setDefaultNavigationTimeout(7000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.includes('/api/journal/') && request.method() !== 'GET') browserWrites.push(`${request.method()}:${url.pathname}`);
    if (url.pathname.endsWith('/api/rpc')) { const payload = request.postDataJSON();
      if (/send|sign|wallet_/i.test(payload?.method ?? '')) browserWrites.push(payload.method); }
  });
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    blockedExternal.push(route.request().url()); return route.abort('blockedbyclient');
  });
  if (phase === 'wrapper') await checkPreviewWrapper(origin);
  else if (phase.includes('-finance')) {
    await page.goto(base + '/#pools'); await settle();
    if (width === 1440) await checkDesktopFinance(); else await checkMobileFinance();
  }
  else {
  await page.goto(base + '/#pools'); await settle();
  const directory = page.locator('[data-project-directory="unified"]');
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-project-directory="unified"] button')]
    .some(el => el.textContent === '重新读取' || el.textContent === '读取中…'));
  if (width === 1440) {
    const fingerprints = {};
    for (const label of ['募集中', '挖矿中', '整机出售中', '项目总览']) {
      await directory.getByRole('button', { name: label, exact: true }).click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      fingerprints[label] = await desktopFingerprint(directory);
      assert(fingerprints[label].length > 0);
    }
    if (phase === 'desktop') {
      const baselinePath = process.env.BEMINE_BASELINE_RESULTS || join(output, 'desktop-baseline.json');
      const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
      assert.equal(baseline.passed, true, 'PC comparison requires a completed baseline run.');
      for (const label of Object.keys(fingerprints)) {
        assert.equal(fingerprints[label].length, baseline.desktop[label].length, `${label} PC分组数变化`);
        fingerprints[label].forEach((table, i) => {
          const before = baseline.desktop[label][i];
          assert.deepEqual(table.headers, before.headers, `${label} PC列变化`);
          assert.deepEqual(table.rows, before.rows, `${label} PC内容/操作变化`);
          assert.deepEqual(table.style, before.style, `${label} PC表格字体/样式变化`);
          assert.deepEqual(table.contentStyles, before.contentStyles, `${label} PC表头、数据、身份与操作实际字体/样式变化`);
          assert(Math.abs(table.wrapperWidth - before.wrapperWidth) <= 1, `${label} PC表格宽度变化`);
          assert.equal(table.widths.length, before.widths.length);
          table.widths.forEach((w, j) => assert(Math.abs(w - before.widths[j]) <= 2, `${label} PC列 ${j} 宽度变化`));
        });
      }
      assert.equal(await directory.locator('.live-mobile-projects:visible').count(), 0);
      assert((await directory.locator('.live-project-table-desktop:visible').count()) > 0);
      checks.push('1440px 与旧构建逐分类比较：列、内容、字体、表格与列宽保持一致');
    } else checks.push('1440px 旧构建PC表格基线已保存');
    await assertNoOverflow('PC项目总览'); await snapshot('project-overview');
    if (phase === 'desktop') { await open('home');
      assert.equal(await page.getByRole('button', { name: '暂停动效', exact: true }).count(), 0);
      checks.push('桌面首页暂停动效已删除'); }
    await writeFile(resultFile, plainJson({ passed: true, synthetic: true, phase, width, checks, desktop: fingerprints,
      errors, browserWrites, blockedExternal, captures, broadcastCount: 0 }));
  } else {
    await assertToolbar();
    if (width === 390) await assertMobileNavigation();
    const labels = { Funding: '募集中', Active: '挖矿中', Listed: '整机出售中' };
    for (const [category, label] of Object.entries(labels)) {
      await directory.getByRole('button', { name: label, exact: true }).click();
      const mobile = directory.locator(`.live-mobile-projects[data-mobile-category="${category}"]:visible`);
      await assertFields(mobile, category); await assertCompactProjectEntrances(mobile); await assertNoOverflow(label); await snapshot(category);
    }
    await directory.getByRole('button', { name: '项目总览', exact: true }).click();
    for (const category of Object.keys(labels)) {
      const group = directory.locator(`[data-project-category="${category}"]`);
      assert.equal(await group.count(), 1); await assertFields(group.locator('.live-mobile-projects:visible'), category, true);
    }
    assert.equal(await directory.locator('.live-mobile-project-summary-row:visible').count(), 6);
    await assertNoOverflow('分类总览'); await snapshot('grouped-overview');
    await directory.getByRole('button', { name: '募集中', exact: true }).click();
    await directory.getByRole('button', { name: '筛选排序', exact: true }).click();
    await page.getByRole('menuitemradio', { name: '每份金额从低到高', exact: true }).click();
    const cardRoot = directory.locator('.live-mobile-projects:visible');
    const values = await cardRoot.locator('.live-mobile-project-card [data-project-field="unit"] dd').allTextContents();
    const amounts = values.map(value => Number(value.replace(/[^\d.]/g, '')));
    assert.deepEqual(amounts, [...amounts].sort((a, b) => a - b));
    const search = directory.getByLabel('搜索矿机或地址', { exact: true }); await search.fill('16210');
    assert.equal(await cardRoot.locator('.live-mobile-project-card').count(), 1);
    assert.match(await cardRoot.innerText(), /TapeOut #16210/); await search.fill('');
    checks.push('搜索按矿机编号筛选、每份金额排序正常');
    let returnState;
    if (width === 390) {
      await directory.getByRole('button', { name: '项目总览', exact: true }).click();
      await search.fill('0x');
      const summaries = directory.locator('.live-mobile-project-summary-row:visible');
      const single = directory.locator('.live-mobile-project-summary-row:visible[data-project-kind="single"]').last();
      assert.equal(await single.count(), 1);
      if (await single.locator('details').getAttribute('open') == null) await single.locator('summary').click();
      const action = single.getByRole('button', { name: '查看矿机', exact: true });
      await action.scrollIntoViewIfNeeded();
      returnState = { scrollY: await page.evaluate(() => scrollY), query: await search.inputValue(),
        rows: await summaries.locator('.live-mobile-project-identity').allTextContents(),
        expanded: await summaries.locator('details[open]').count() };
      assert(returnState.scrollY > 100, '滚动恢复应从实际滚动后的目录验收');
      await action.click();
    } else await cardRoot.locator('.live-mobile-project-card[data-project-kind="single"]').first()
      .getByRole('button', { name: '查看矿机', exact: true }).click();
    await page.waitForURL(/#detail\/0x[\da-f]{40}$/i); await settle('detail');
    await page.locator('.detail-heading h1').waitFor();
    assert.match(await page.locator('.detail-heading h1').innerText(), /(?:TapeOut|Behemoth)\s+#\d+/);
    await assertNoOverflow('矿机详情'); checks.push('查看矿机打开既有详情，只读无签名');
    if (returnState) {
      const back = page.getByRole('button', { name: /返回(?:参与拼矿|项目列表|项目大厅)/ });
      if (await back.count()) await back.first().click(); else await page.evaluate(() => { location.hash = 'pools'; });
      await settle();
      await page.waitForFunction(target => Math.abs(scrollY - target) <= 2, returnState.scrollY);
      assert.equal(await search.inputValue(), returnState.query);
      assert.equal(await directory.getByRole('button', { name: '项目总览', exact: true }).getAttribute('class'), 'selected');
      const summaries = directory.locator('.live-mobile-project-summary-row:visible');
      assert.deepEqual(await summaries.locator('.live-mobile-project-identity').allTextContents(), returnState.rows);
      assert.equal(await summaries.locator('details[open]').count(), returnState.expanded);
      await directory.getByRole('button', { name: '筛选排序', exact: true }).click();
      assert.equal(await page.getByRole('menuitemradio', { name: '每份金额从低到高', exact: true }).getAttribute('aria-checked'), 'true');
      await page.keyboard.press('Escape'); await search.fill('');
      checks.push('390px 返回详情前目录：总览类别、展开、搜索、排序与实际scrollY均保留');
      await directory.getByRole('button', { name: '募集中', exact: true }).click();
    } else await open('pools');
    await page.locator('header').getByRole('button', { name: '连接钱包', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    const syntheticConnect = page.getByRole('button', { name: /连接.*效果预览钱包/ });
    if (await syntheticConnect.count()) await syntheticConnect.click();
    else await page.getByRole('button', { name: '连接 MetaMask', exact: true }).click();
    await page.locator('header').getByRole('button', { name: /打开钱包信息：0x/ }).waitFor();
    await assertToolbar(); await open('overview');
    if (width === 390) await assertAssetHeading();
    const holdings = page.locator('[data-asset-directory="unified"] .live-mobile-projects:visible');
    assert((await holdings.locator('.live-mobile-project-card').count()) >= 4);
    for (const card of await holdings.locator('.live-mobile-project-card').all()) {
      const fields = await card.locator('dl > div').evaluateAll(rows => rows.map(row => row.dataset.projectField));
      assert.deepEqual(fields, ['shares', 'unit', 'daily', 'capacity']);
    }
    await assertNoOverflow('持仓'); await snapshot('holdings'); checks.push('普通示例成员持仓四项指标正常');
    await open('market'); await page.locator('.firsto-board-mobile-cards:visible').waitFor();
    assert((await page.locator('.firsto-board-mobile-cards:visible article').count()) > 0);
    await assertNoOverflow('矿机转让'); await snapshot('market');
    await open('records'); assert((await page.locator('.live-mobile-activity-row:visible').count()) > 0);
    await assertNoOverflow('公开记录'); await snapshot('activity');
    await open('pools');
    let failPortfolio = true;
    await page.route(/\/api\/chain-index\/v1\/display\/portfolios(?:\?|$)/, async route => failPortfolio
      ? route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"synthetic_directory_unavailable"}' }) : route.continue());
    await page.getByRole('button', { name: '刷新', exact: true }).first().click();
    await directory.locator('[role="alert"]').waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.live-project-summary strong')].every(el => el.textContent === '—'));
    assert((await directory.locator('.live-mobile-project-card:visible[data-project-kind="single"]').count()) > 0);
    failPortfolio = false; await directory.locator('[role="alert"]').getByRole('button', { name: '重新读取', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-project-directory="unified"] [role="alert"]'));
    await settle(); checks.push('读取失败保留可用单矿，计数显示未知而非0；明确重试恢复');
    await open('home'); assert.equal(await page.getByRole('button', { name: '暂停动效', exact: true }).count(), 0);
    assert.equal(await page.locator('.bemine-scene:visible').count(), 0, '手机首页hero图须隐藏');
    await assertNoOverflow('首页'); await snapshot('home'); checks.push('手机首页暂停动效已删除');
    const walletCalls = await page.evaluate(async () => ({ account: await window.ethereum.request({ method: 'eth_accounts' }),
      chain: await window.ethereum.request({ method: 'eth_chainId' }), synthetic: window.__BEMINE_EFFECT_PREVIEW__?.synthetic }));
    assert.equal(walletCalls.synthetic, true); assert.equal(walletCalls.chain, '0x38');
    assert.equal(walletCalls.account[0].toLowerCase(), '0x0000000000000000000000000000000000000b0b');
    assert.deepEqual(browserWrites, []); assert.deepEqual(errors, []);
    await writeFile(resultFile, plainJson({ passed: true, synthetic: true, phase, width, checks, errors,
      browserWrites, blockedExternal, captures, broadcastCount: 0, physicalDevice: false }));
  }
  }
  assert.deepEqual(browserWrites, []); assert.deepEqual(errors, []);
  console.log(plainJson({ passed: true, phase, checks: checks.length, output: resultFile, synthetic: true, broadcastCount: 0 }));
} catch (error) {
  await writeFile(resultFile, plainJson({ passed: false, synthetic: true, phase, width, error: error.stack,
    checks, errors, browserWrites, blockedExternal, captures, trace: preview?.fixture.trace,
    text: page ? await page.locator('body').innerText().catch(() => '') : '' }));
  if (page) await page.screenshot({ path: join(output, phase + '-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); await preview?.close(); clearTimeout(gracefulStop); clearTimeout(hardStop);
}
