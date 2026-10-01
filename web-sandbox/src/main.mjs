import { BrowserProvider, Contract, Interface, keccak256, toUtf8Bytes, toQuantity } from 'ethers';
import { ADDRESS, HASH, KIND, PREFIX, DEPLOY_ORDER, CHAIN_ID, MAX_TEST_PRICE, amount5, exactBnb, parseTestPrice, initialMembers, shortAddress, escapeHtml as h, checkArtifact, checkManifest, addressesOf, isComplete, isOwner, linkBytecode, walletRejected, friendlyError, receiptResult, proposalView, runtimeMatches, transactionMatches } from './sandbox-model.mjs';

const $ = (id) => document.getElementById(id);
const artifactUrl = new URL('./sale-sandbox-artifacts.json', import.meta.url);
const state = { artifact: null, digest: '', account: '', wallet: null, provider: null, manifest: null, data: null, busy: false, reading: false, verified: false, delegated: false, directConfirmed: false, providers: [], selectedProposal: '', form: { cost: '0.00001', members: '', price: '0.00001', reference: '0.00001', recipient: '', shares: '1', recoveryHash: '' } };
const app = $('app');
let confirmAction = null;
let selectedWallet = null;
let epoch = 0;
const nftInterface = new Interface(['function ownerOf(uint256) view returns (address)']);
const activeKey = () => `${PREFIX}${location.origin}:${state.digest}:active`;
const deploymentKey = (owner) => `${PREFIX}${location.origin}:${state.digest}:${owner.toLowerCase()}`;
const explorer = (value, type = 'address') => `https://bscscan.com/${type}/${value}`;
const addressLink = (address) => ADDRESS.test(address ?? '') ? `<a class="address" href="${explorer(address)}" target="_blank" rel="noopener noreferrer">${h(shortAddress(address))} ↗</a>` : '—';
const txLink = (hash) => HASH.test(hash ?? '') ? `<a href="${explorer(hash, 'tx')}" target="_blank" rel="noopener noreferrer">查看交易 ↗</a>` : '';
const disabled = (condition) => condition ? ' disabled' : '';
const row = (label, value) => `<div class="row"><span>${h(label)}</span><strong>${value}</strong></div>`;
const actionMethods = { propose: 'propose', transfer: 'transfer', reference: 'setSaleReference', approve: 'reviewSale', reject: 'reviewSale', yes: 'vote', no: 'vote', execute: 'executeSale', buy: 'completeSimulatedSale', expire: 'cancelExpired', withdraw: 'withdrawBnb' };
const hasPendingMethod = (method, account = state.account) => (state.manifest?.transactions ?? []).some((record) => ['signing', 'uncertain', 'pending'].includes(record.status) && record.method === method && record.account?.toLowerCase() === account?.toLowerCase());
const button = (id, label, blocked = false, cls = '') => `<button type="button" data-action="${id}" class="${cls}"${disabled(blocked || state.busy || ((actionMethods[id] || id === 'deploy') && state.delegated && !state.directConfirmed) || (actionMethods[id] && hasPendingMethod(actionMethods[id])))}>${h(label)}</button>`;
const field = (name, label, value = '', hint = '') => `<div class="field"><label for="field-${name}">${h(label)}</label><input id="field-${name}" data-field="${name}" value="${h(value)}" ${['price', 'cost', 'reference'].includes(name) ? 'inputmode="decimal"' : ''}/>${hint ? `<p class="help muted">${h(hint)}</p>` : ''}</div>`;

function notice(message = '', tone = '') { $('notice').textContent = message; $('notice').className = `notice ${tone}`; $('notice').hidden = !message; }
function save() {
  if (!state.manifest) return;
  const json = JSON.stringify(state.manifest);
  localStorage.setItem(deploymentKey(state.manifest.owner), json);
  localStorage.setItem(activeKey(), json);
}
function loadSaved() {
  try {
    const json = localStorage.getItem(activeKey());
    if (json) state.manifest = checkManifest(JSON.parse(json), state.artifact, state.digest);
  } catch { notice('本地测试记录无法恢复，请导入已导出的测试清单。', 'error'); }
}

function preserveForms() { for (const input of app.querySelectorAll('[data-field]')) state.form[input.dataset.field] = input.value; }
function showResult(kind, title, message, hash) {
  const dialog = $('result-dialog');
  $('result-title').textContent = title;
  $('result-body').innerHTML = `<div class="result-mark ${kind === 'failed' ? 'fail' : kind === 'pending' ? 'wait' : ''}">${kind === 'success' ? '✓' : kind === 'failed' ? '×' : kind === 'pending' ? '◷' : '·'}</div><p>${h(message)}</p>${txLink(hash)}`;
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('.dialog-footer button').focus();
}
function confirm(title, body, action, submitLabel = '在钱包确认') {
  $('confirm-title').textContent = title;
  $('confirm-body').innerHTML = body;
  $('confirm-submit').textContent = submitLabel;
  $('confirm-submit').disabled = false;
  confirmAction = action;
  $('confirm-dialog').showModal();
  $('confirm-submit').focus();
}
$('confirm-submit').addEventListener('click', async () => {
  const run = confirmAction;
  if (!run || state.busy) return;
  confirmAction = null;
  $('confirm-dialog').close();
  await run();
});
for (const id of ['confirm-dialog', 'result-dialog']) $(id).addEventListener('click', (event) => { if (event.target === $(id)) $(id).close(); });
$('confirm-dialog').addEventListener('close', () => { confirmAction = null; });

function discoverWallets() {
  const add = (provider, info = {}) => {
    if (!provider?.request || state.providers.some((entry) => entry.provider === provider)) return;
    const same = state.providers.find((entry) => info.rdns && entry.rdns === info.rdns);
    if (same) return;
    state.providers.push({ provider, name: info.name ?? (provider.isMetaMask ? 'MetaMask' : provider.isOkxWallet ? 'OKX Wallet' : '浏览器钱包'), rdns: info.rdns ?? '' });
  };
  window.addEventListener('eip6963:announceProvider', (event) => add(event.detail?.provider, event.detail?.info));
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  for (const provider of window.ethereum?.providers ?? [window.ethereum]) add(provider);
}

async function chainAndAccount(expected = state.account) {
  if (!state.wallet || !ADDRESS.test(expected)) throw new Error('请先连接测试钱包。');
  const [chain, accounts] = await Promise.all([state.wallet.request({ method: 'eth_chainId' }), state.wallet.request({ method: 'eth_accounts' })]);
  if (Number(BigInt(chain)) !== CHAIN_ID) throw new Error('请在钱包切换至 BNB Smart Chain 主网（56），再继续。');
  if (accounts?.[0]?.toLowerCase() !== expected.toLowerCase()) throw new Error('当前钱包已变化，请重新查看本次操作。');
  return expected;
}

async function connect(provider) {
  try {
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    if (!ADDRESS.test(accounts?.[0] ?? '')) throw new Error('钱包未返回公开账户。');
    if (state.wallet !== provider) {
      if (state.wallet?.removeListener) {
        state.wallet.removeListener('accountsChanged', accountChanged);
        state.wallet.removeListener('chainChanged', chainChanged);
      }
      provider.on?.('accountsChanged', accountChanged);
      provider.on?.('chainChanged', chainChanged);
    }
    state.wallet = provider; state.provider = new BrowserProvider(provider, 'any'); state.account = accounts[0]; epoch++; state.data = null; state.verified = false;
    $('connect').textContent = shortAddress(state.account);
    await chainAndAccount();
    const code = await provider.request({ method: 'eth_getCode', params: [state.account, 'latest'] });
    state.delegated = /^0xef0100[0-9a-f]{40}$/i.test(code); state.directConfirmed = false;
    notice(''); render(); await refresh();
  } catch (error) { notice(friendlyError(error), 'error'); render(); }
}

function accountChanged(accounts) {
  epoch++; state.account = ADDRESS.test(accounts?.[0] ?? '') ? accounts[0] : ''; state.data = null; state.verified = false; state.delegated = false; state.directConfirmed = false;
  $('confirm-dialog').close(); $('connect').textContent = state.account ? shortAddress(state.account) : '连接钱包';
  notice(state.account ? '钱包已切换。' : '钱包已断开，请重新连接。'); render();
  if (state.account) void state.wallet.request({ method: 'eth_getCode', params: [state.account, 'latest'] }).then((code) => { state.delegated = /^0xef0100[0-9a-f]{40}$/i.test(code); render(); return refresh(); }).catch((error) => notice(friendlyError(error), 'error'));
}
function chainChanged() { epoch++; state.data = null; state.verified = false; state.directConfirmed = false; $('confirm-dialog').close(); notice('网络已变化，请使用 BNB 主网（56）。', 'wait'); render(); if (state.account) void refresh(); }
$('connect').addEventListener('click', () => {
  if (state.busy) return;
  if (!state.providers.length) { notice('未检测到浏览器钱包，请先安装钱包扩展。', 'error'); return; }
  if (state.providers.length === 1) { void connect(state.providers[0].provider); return; }
  confirm('选择钱包', `<div class="wallet-options">${state.providers.map((entry, i) => `<button type="button" data-wallet="${i}">${h(entry.name)}</button>`).join('')}</div>`, null);
  $('confirm-submit').hidden = true;
  $('confirm-body').querySelectorAll('[data-wallet]').forEach((button) => button.addEventListener('click', () => { selectedWallet = state.providers[Number(button.dataset.wallet)]; $('confirm-dialog').close(); $('confirm-submit').hidden = false; void connect(selectedWallet.provider); }));
});
$('confirm-dialog').addEventListener('close', () => { $('confirm-submit').hidden = false; });

function contract() { return new Contract(addressesOf(state.manifest).SandboxSalePool, state.artifact.contracts.SandboxSalePool.abi, state.provider); }
async function latestBlock() {
  const block = await state.wallet.request({ method: 'eth_getBlockByNumber', params: ['latest', false] });
  if (!block?.timestamp) throw new Error('暂时无法读取主网区块时间。');
  return { timestamp: Number(BigInt(block.timestamp)), number: Number(BigInt(block.number)) };
}

async function validateDeployment(manifest = state.manifest) {
  const addresses = addressesOf(manifest);
  for (const name of DEPLOY_ORDER.filter((name) => addresses[name])) {
    const code = await state.wallet.request({ method: 'eth_getCode', params: [addresses[name], 'latest'] });
    if (!runtimeMatches(code, state.artifact.contracts[name], addresses, DEPLOY_ORDER.slice(0, 2).includes(name) ? addresses[name] : null)) throw new Error('测试合约代码与当前编译版本不一致，请使用对应的测试清单。');
  }
  if (isComplete(manifest)) {
    const pool = new Contract(addresses.SandboxSalePool, state.artifact.contracts.SandboxSalePool.abi, state.provider);
    const [owner, treasury, simulation, factory, market, nft, tokenId, supply] = await Promise.all([pool.owner(), pool.treasury(), pool.simulationOnly(), pool.factory(), pool.shareMarket(), pool.simulatedNft(), pool.tokenId(), pool.totalSupply()]);
    const forbidden = new Set((state.artifact.productionExcludedAddresses ?? []).map((address) => address.toLowerCase()));
    if (owner.toLowerCase() !== manifest.owner.toLowerCase() || treasury.toLowerCase() !== manifest.owner.toLowerCase() || !simulation || factory.toLowerCase() !== addresses.SandboxSalePool.toLowerCase() || market.toLowerCase() !== addresses.SandboxSalePool.toLowerCase() || !ADDRESS.test(nft) || forbidden.has(nft.toLowerCase()) || tokenId !== 1n || supply !== 100n) throw new Error('测试项目身份或所有权不符合部署清单。');
    const nftArtifact = state.artifact.auxiliaryContracts?.SandboxMockMiner;
    if (!nftArtifact || !runtimeMatches(await state.wallet.request({ method: 'eth_getCode', params: [nft, 'latest'] }), nftArtifact, addresses)) throw new Error('模拟 NFT 代码与本测试版本不一致。');
    manifest.simulatedNft = nft;
  }
}

async function refresh() {
  if (!state.account || !state.manifest || !isComplete(state.manifest) || state.reading) return;
  state.reading = true; const ticket = epoch;
  try {
    await chainAndAccount();
    if (!state.verified) { await validateDeployment(); if (ticket !== epoch) return; state.verified = true; save(); }
    const pool = contract(), account = state.account, target = addressesOf(state.manifest).SandboxSalePool;
    const names = ['state', 'activatedAt', 'firstProposalAt', 'proposalCooldown', 'voteDuration', 'listingDuration', 'purchaseCost', 'memberCount', 'activeProposalId', 'nextProposalId', 'listedProposalId', 'expiresAt', 'salePrice', 'saleBuyer', 'saleProceeds'];
    const reads = await Promise.all(names.map((name) => pool[name]()));
    const data = Object.fromEntries(names.map((name, i) => [name, reads[i]]));
    const [block, balance, owed, pending, reference, last, nftOwner] = await Promise.all([latestBlock(), pool.balanceOf(account), pool.bnbOwed(account), pool.pendingSaleProceeds(account), pool.saleReference(target), pool.lastProposed(account), state.provider.call({ to: state.manifest.simulatedNft, data: nftInterface.encodeFunctionData('ownerOf', [1]) })]);
    Object.assign(data, { ...block, balance, owed, pending, claimable: owed + pending, reference, last, nftOwner: nftInterface.decodeFunctionResult('ownerOf', nftOwner)[0] });
    const maxId = data.nextProposalId - 1n;
    const id = state.selectedProposal && BigInt(state.selectedProposal) <= maxId ? BigInt(state.selectedProposal) : maxId;
    if (id > 0n) {
      const [proposal, voted, review] = await Promise.all([pool.getProposal(id), pool.hasVoted(id, account), pool.saleReview(target, id)]);
      const activeProposal = data.activeProposalId > 0n ? (data.activeProposalId === id ? proposal : await pool.getProposal(data.activeProposalId)) : null;
      Object.assign(data, { proposal, voted, review, id, proposalView: proposalView(proposal, reference, review, block.timestamp), activeRound: activeProposal ? proposalView(activeProposal, reference, review, block.timestamp) : null });
      state.selectedProposal = id.toString();
    }
    if (ticket !== epoch) return;
    state.data = data; notice(''); render();
  } catch (error) { if (ticket === epoch) notice(friendlyError(error), 'error'); }
  finally { state.reading = false; if (ticket === epoch) render(); }
}

function renderDeployment() {
  const manifest = state.manifest, complete = isComplete(manifest), owner = isOwner(manifest, state.account);
  const partial = manifest && !complete;
  const pending = DEPLOY_ORDER.some((name) => manifest?.steps?.[name]?.status === 'pending');
  const uncertain = DEPLOY_ORDER.some((name) => ['signing', 'uncertain'].includes(manifest?.steps?.[name]?.status));
  const content = !manifest ? `<div class="grid"><div>${field('cost', '模拟采购参考价 · BNB（不支付本金）', state.form.cost, '默认 0.00001 BNB，测试最高 0.00100 BNB。')}<details><summary>设置初始测试成员（默认当前钱包持有 100 份）</summary><div class="field"><label for="field-members">每行一个钱包地址与份额，合计 100</label><textarea id="field-members" data-field="members" placeholder="0x… 60&#10;0x… 40">${h(state.form.members)}</textarea></div></details></div><div><p class="emphasis">创建一套独立测试项目</p><p class="muted compact">两份链接库 + 一份测试矿池，共 ${state.artifact.deployOrder.length} 笔部署交易。测试矿池自动创建模拟 NFT。</p><p class="muted compact">部署不支付采购款，只支付网络 Gas。每一步由你的钱包确认，可中断后继续。</p></div></div>${button('deploy', '部署测试项目', !state.account)}` : `<p class="compact">部署钱包：${addressLink(manifest.owner)} ${complete ? '<span class="badge">部署完成</span>' : ''}</p><ol class="progress">${DEPLOY_ORDER.map((name, i) => { const step = manifest.steps[name]; return `<li><span class="number ${step?.status === 'confirmed' ? 'done' : ''}">${step?.status === 'confirmed' ? '✓' : i + 1}</span><span class="step-name">${h(name)}<small>${step?.status === 'confirmed' ? addressLink(step.address) : step?.status === 'pending' ? '已发送，等待链上确认' : ['signing', 'uncertain'].includes(step?.status) ? '钱包响应未完成，需补录交易编号恢复' : step?.status === 'failed' ? '链上失败，可重新部署本步骤' : '尚未部署'}</small></span>${txLink(step?.hash)}</li>`; }).join('')}</ol>${partial ? `<div class="actions">${button('deploy', uncertain ? '请先恢复钱包交易' : pending ? '检查待确认部署' : '继续剩余部署', !owner || uncertain)}${!owner ? '<small>继续部署需切换回上面的部署钱包。</small>' : ''}</div>` : ''}`;
  const directMode = state.delegated ? '<div class="scope"><strong>当前钱包启用了智能账户委托。</strong>本测试工具只恢复普通合约部署与普通交易。请先在钱包关闭智能交易、批量或代付模式；保持已有账户委托不变。<label class="checkbox-row"><input id="direct-confirm" type="checkbox"' + (state.directConfirmed ? ' checked' : '') + '>我已设置普通交易模式，部署时逐笔确认合约创建交易</label></div>' : '';
  return `<section class="card"><div class="card-head"><h2>1. 连接与部署</h2><div class="actions">${button('export', '导出清单', !manifest, 'secondary')}</div></div>${directMode}${content}<details><summary>导入已有测试项目，或查看独立测试清单</summary><div class="actions"><label>导入本测试版本 JSON 清单<input id="import-file" type="file" accept="application/json,.json" class="file-input"></label></div>${manifest ? `<pre>${h(JSON.stringify({ chainId: manifest.chainId, owner: manifest.owner, simulatedNft: manifest.simulatedNft, contracts: addressesOf(manifest), initialMembers: manifest.initialMembers, initialShares: manifest.initialShares }, null, 2))}</pre>${button('new', '创建另一测试项目', state.busy, 'secondary')}` : ''}</details></section>`;
}

function renderProject() {
  const d = state.data, m = state.manifest;
  if (!d) return `<section class="card"><p class="empty">${state.account ? '读取测试项目数据中…' : '连接钱包后可读取测试项目。'}</p>${button('refresh', '读取项目', !state.account, 'secondary')}</section>`;
  const active = Number(d.state) === 2, listed = Number(d.state) === 3, closed = Number(d.state) === 4;
  const current = active ? (d.proposalView?.votingOpen ? 2 : 1) : listed ? 3 : 4;
  const owner = isOwner(m, state.account), p = d.proposal, view = d.proposalView;
  const notReady = Math.max(0, Number(d.firstProposalAt) - d.timestamp);
  const currentTime = d.timestamp;
  const ref = d.reference, refPrice = BigInt(ref[0]), refAt = Number(ref[1]);
  const frozen = active && d.activeProposalId > 0n && d.activeRound?.votingOpen;
  const cooldown = Math.max(0, Number(d.last) + Number(d.proposalCooldown) - currentTime);
  const readonly = !state.verified || !state.account;
  const proposalIds = []; for (let id = d.nextProposalId - 1n; id > 0n && proposalIds.length < 30; id--) proposalIds.push(id.toString());
  const summary = `<div class="steps">${['准备提案', '审核与投票', '已挂牌', '已成交与领取'].map((label, i) => `<span class="${current === i + 1 ? 'current' : ''}">${i + 1}. ${label}</span>`).join('')}</div><div class="kpis"><div class="kpi"><span>项目状态</span><strong>${active ? frozen ? '投票中' : '可提案' : listed ? '已挂牌' : closed ? '已成交' : '—'}</strong><small>模拟矿机 #1</small></div><div class="kpi"><span>我的持有份额</span><strong>${d.balance.toString()} / 100</strong><small>当前钱包</small></div><div class="kpi"><span>我的可领取 BNB</span><strong>${amount5(d.claimable)}</strong><small>含当前钱包售款与平台费</small></div><div class="kpi"><span>测试持有人数</span><strong>${d.memberCount.toString()}</strong><small>人数和份额均需过半</small></div></div>`;
  const propose = `<section class="card"><h2>2. 出售提案</h2>${field('price', '模拟 NFT 出售价格 · BNB', state.form.price)}${row('当前测试参考价', `${amount5(refPrice)} BNB`)}<p class="help muted">${currentTime - refAt <= 900 ? '参考价有效。' : '参考价已过期，请部署钱包更新。'}首次提案等待 ${Number(d.proposalCooldown)} 秒；投票期限 ${Number(d.voteDuration)} 秒。</p>${notReady ? `<p class="help">首次提案还需等待约 ${notReady} 秒。</p>` : cooldown ? `<p class="help">当前钱包提案冷却约 ${cooldown} 秒。</p>` : ''}<div class="actions">${button('propose', '提交出售提案', readonly || !active || d.balance === 0n || notReady > 0 || cooldown > 0)}</div><details><summary>分配份额给其他测试钱包</summary><p class="help muted">提案创建后冻结份额。请在发起提案前分配，以测试持有人数与份额双多数。</p>${field('recipient', '接收测试钱包', state.form.recipient)}${field('shares', '转出整数份额', state.form.shares)}${button('transfer', '转出测试份额', readonly || !active || frozen || d.balance === 0n, 'secondary')}</details></section>`;
  const administration = `<section class="card"><h2>管理员 · 测试参考价与审核</h2><p class="help muted">部署钱包：${addressLink(m.owner)}。参考价只用于本次模拟出售。</p>${field('reference', '更新测试参考价 · BNB', state.form.reference)}${button('reference', '更新测试参考价', readonly || !owner || closed, 'secondary')}${p ? `<div class="divider"></div>${row('当前提案审核', Number(d.review[0]) === 1 ? '已通过' : Number(d.review[0]) === 2 ? '已拒绝' : view.lowPrice ? '低于参考价，等待审核' : '未低于参考价，无需审核')}<div class="actions">${button('approve', '通过低价审核', readonly || !owner || !active || !view.votingOpen || Number(d.review[0]) === 2)}${button('reject', '拒绝低价审核', readonly || !owner || !active || !view.votingOpen || Number(d.review[0]) === 2, 'danger')}</div>` : ''}</section>`;
  const voting = `<section class="card"><div class="card-head"><h2>3. 审核与投票</h2>${proposalIds.length ? `<div class="inline"><select id="proposal-select" aria-label="选择出售提案">${proposalIds.map((id) => `<option value="${id}"${id === state.selectedProposal ? ' selected' : ''}>提案 #${id}</option>`).join('')}</select></div>` : ''}</div>${p ? `${row('提案出售价格', `${amount5(p.price)} BNB`)}${row('赞成人数', `${p.yesCount} / ${p.snapshotMemberCount}，至少 ${view.yesNeeded} 人`)}${row('赞成份额', `${p.yesShares} / ${p.snapshotTotalShares}，至少 ${view.sharesNeeded} 份`)}${row('投票状态', p.executed ? '已执行挂牌' : view.votingOpen ? `进行中 · 约 ${Math.max(0, Number(p.endsAt) - d.timestamp)} 秒后截止` : '已截止')}${row('我的投票', d.voted ? '已投票' : d.balance > 0n ? '尚未投票' : '当前钱包无份额')}<div class="actions">${button('yes', '投赞成票', readonly || !active || !view.votingOpen || d.voted || d.balance === 0n)}${button('no', '投反对票', readonly || !active || !view.votingOpen || d.voted || d.balance === 0n, 'secondary')}${button('execute', '执行挂牌', readonly || !active || !view.executable)}</div><p class="help muted">${view.passed ? '人数与份额双多数已达到。' : '需赞成人数和赞成份额均超过一半。'}通过后可在投票截止前立即执行；低价出售还需管理员通过审核。</p>` : '<p class="empty">尚无出售提案。</p>'}</section>`;
  const gross = listed ? d.salePrice : closed ? d.saleProceeds : 0n, fee = gross / 100n;
  const expired = listed && currentTime >= Number(d.expiresAt);
  const settlement = `<section class="card"><h2>4. 模拟买入与 BNB 领取</h2>${row('模拟 NFT 当前持有人', addressLink(d.nftOwner))}${row('成交 / 挂牌金额', `${amount5(gross)} BNB`)}${row('平台费（1%）', `${amount5(fee)} BNB`)}${row('持有人净款（99%）', `${amount5(gross - fee)} BNB`)}${listed ? `<p class="help">${expired ? '挂牌已到期。' : `挂牌约 ${Number(d.expiresAt) - currentTime} 秒后到期。`}买入仅获得模拟 NFT；真实 Firsto 买方手续费未覆盖。</p><div class="actions">${button('buy', '支付 BNB 买入模拟 NFT', readonly || expired || gross > MAX_TEST_PRICE)}${button('expire', '撤销到期挂牌', readonly || !expired, 'secondary')}</div>` : closed ? `<p class="help">买方：${addressLink(d.saleBuyer)}。卖款结算与 BNB 提现将在同一笔交易完成。</p><div class="actions">${button('withdraw', `领取我的 ${amount5(d.claimable)} BNB`, readonly || d.claimable <= 0n)}</div>` : '<p class="empty">执行挂牌后可用买方钱包测试成交。</p>'}</section>`;
  return `${summary}<div class="card-head"><p class="compact">测试项目 ${addressLink(addressesOf(m).SandboxSalePool)} · 区块 ${d.number}</p>${button('refresh', state.reading ? '更新中' : '刷新项目', state.reading, 'secondary')}</div><div class="grid">${propose}${administration}</div>${voting}${settlement}`;
}

function renderHistory() {
  const records = (state.manifest?.transactions ?? []).filter((record) => HASH.test(record.hash ?? '')).slice(-20).reverse();
  if (!records.length) return '';
  return `<section class="card"><div class="card-head"><h2>最近测试交易</h2>${button('check', '检查待确认交易', !state.account || !records.some((tx) => tx.status === 'pending'), 'secondary')}</div><div class="table-scroll"><table><thead><tr><th>操作</th><th>状态</th><th>钱包</th><th>交易</th></tr></thead><tbody>${records.map((record) => `<tr><td>${h(record.label)}</td><td>${record.status === 'confirmed' ? '成功' : record.status === 'failed' ? '链上失败' : '等待确认'}</td><td>${h(shortAddress(record.account))}</td><td>${txLink(record.hash)}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function unknownRecords() {
  return [...Object.values(state.manifest?.steps ?? {}), ...(state.manifest?.transactions ?? [])].filter((record) => ['signing', 'uncertain'].includes(record.status) && !record.hash);
}
function renderRecovery() {
  const records = unknownRecords();
  if (!records.length) return '';
  return `<section class="card"><h2>恢复钱包交易</h2><p class="help muted">钱包响应中断，交易可能已经发送。本页已暂停重复发送。请从钱包活动记录复制对应交易编号。</p><label for="recovery-record">待恢复操作</label><select id="recovery-record">${records.map((record, i) => `<option value="${i}">${h(record.label)} · ${h(shortAddress(record.account))}</option>`).join('')}</select>${field('recoveryHash', '交易编号 · 0x 开头的完整 hash', state.form.recoveryHash)}${button('recover', '补录并检查交易', !state.account, 'secondary')}<p class="help muted">仅匹配原钱包、精确目标、字节码 / 调用和金额的普通交易可恢复。智能批量包装交易不支持恢复。</p></section>`;
}
function render() {
  if (!state.artifact) return;
  preserveForms();
  app.innerHTML = renderDeployment() + renderRecovery() + (isComplete(state.manifest) ? renderProject() : '') + renderHistory();
  app.querySelectorAll('[data-action]').forEach((element) => element.addEventListener('click', () => { preserveForms(); void actions[element.dataset.action]?.(); }));
  $('import-file')?.addEventListener('change', importManifest);
  $('direct-confirm')?.addEventListener('change', (event) => { state.directConfirmed = event.target.checked; render(); });
  $('proposal-select')?.addEventListener('change', (event) => { state.selectedProposal = event.target.value; void refresh(); });
}

async function checkRecord(record) {
  const receipt = await state.wallet.request({ method: 'eth_getTransactionReceipt', params: [record.hash] });
  const outcome = receiptResult(receipt, record.hash);
  if (outcome === 'pending') return outcome;
  const tx = await state.wallet.request({ method: 'eth_getTransactionByHash', params: [record.hash] });
  if (!transactionMatches(record, tx)) throw new Error('钱包返回的交易详情与本次测试操作不匹配，请检查交易链接。');
  if (record.step && outcome === 'success') {
    if (!ADDRESS.test(receipt.contractAddress ?? '')) throw new Error('部署回执未包含有效合约地址。');
    const address = receipt.contractAddress;
    if ((state.artifact.productionExcludedAddresses ?? []).some((excluded) => excluded.toLowerCase() === address.toLowerCase())) throw new Error('部署地址不能属于正式合约。');
    record.address = address;
  }
  record.status = outcome === 'success' ? 'confirmed' : 'failed';
  save(); return outcome;
}

async function waitRecord(record) {
  for (let i = 0; i < 30; i++) {
    const outcome = await checkRecord(record);
    if (outcome !== 'pending') return outcome;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return 'pending';
}

async function sendRecord(record) {
  await chainAndAccount(record.account);
  if (state.delegated && !state.directConfirmed) throw new Error('请先在钱包设置并确认普通交易模式。');
  if (record.target && (!isComplete(state.manifest) || !state.verified || record.target.toLowerCase() !== addressesOf(state.manifest).SandboxSalePool.toLowerCase())) throw new Error('仅能操作当前独立测试矿池。');
  const params = { from: record.account, data: record.data, value: toQuantity(BigInt(record.value)) };
  if (record.target) params.to = record.target;
  notice('请在钱包确认这笔测试交易。', 'wait');
  record.status = 'signing'; save(); render();
  let hash;
  try {
    hash = await state.wallet.request({ method: 'eth_sendTransaction', params: [params] });
    if (!HASH.test(hash ?? '')) throw new Error('钱包未返回有效交易编号，请检查钱包记录。');
  } catch (error) { record.status = walletRejected(error) ? 'idle' : 'uncertain'; save(); throw error; }
  record.hash = hash; record.status = 'pending'; save(); render();
  notice('交易已发送，等待链上确认。', 'wait');
  try { return await waitRecord(record); }
  catch (error) { notice(`交易已发送，确认暂时不可读取：${friendlyError(error)}`, 'wait'); return 'pending'; }
}

async function runWrite(label, method, args = [], value = 0n) {
  if (state.busy) return;
  const account = state.account, ticket = epoch;
  let record;
  state.busy = true; render();
  try {
    await chainAndAccount(account);
    if (!state.verified || !isComplete(state.manifest)) throw new Error('请先读取本测试项目。');
    if (hasPendingMethod(method, account)) throw new Error('同类测试操作已发送，请先检查待确认交易。');
    const data = new Interface(state.artifact.contracts.SandboxSalePool.abi).encodeFunctionData(method, args);
    if (value > MAX_TEST_PRICE) throw new Error('模拟矿机最高支付 0.00100 BNB。');
    record = { label, method, account, target: addressesOf(state.manifest).SandboxSalePool, data, value: value.toString(), createdAt: Date.now(), status: 'idle' };
    state.manifest.transactions ??= []; state.manifest.transactions.push(record);
    const outcome = await sendRecord(record);
    if (record.hash) save();
    if (outcome === 'success') { notice(''); showResult('success', '交易成功', `${label}已在链上确认。`, record.hash); }
    else if (outcome === 'failed') { notice(''); showResult('failed', '交易失败', '交易在链上执行失败，项目数据未按本次操作变更。', record.hash); }
    else showResult('pending', '交易等待确认', '交易已发送。可稍后检查回执；请勿重复发送。', record.hash);
    if (ticket === epoch) await refresh();
  } catch (error) {
    if (record && !record.hash && record.status === 'idle') { state.manifest.transactions = state.manifest.transactions.filter((item) => item !== record); save(); }
    showResult(walletRejected(error) ? 'cancelled' : 'pending', walletRejected(error) ? '已取消钱包确认' : '操作尚未完成', friendlyError(error), record?.hash);
  }
  finally { state.busy = false; render(); }
}

function previewWrite(label, method, args = [], value = 0n, extra = '') {
  const account = state.account, ticket = epoch;
  confirm(label, `<p>${h(label)}只作用于本次测试项目。</p>${extra}${row('钱包支付金额', `${amount5(value)} BNB`)}${row('发送钱包', h(shortAddress(account)))}<p class="help muted">另付网络 Gas。部署钱包为管理员；领取由当前钱包自付 Gas。</p>`, async () => {
    if (ticket !== epoch || account !== state.account) { notice('钱包已变化，请重新预览。', 'error'); return; }
    await runWrite(label, method, args, value);
  });
}

async function deploy() {
  if (state.busy) return;
  try {
    await chainAndAccount();
    if (!state.manifest) {
      const allocation = initialMembers(state.form.members, state.account), cost = parseTestPrice(state.form.cost);
      state.manifest = { schemaVersion: 1, kind: KIND, chainId: CHAIN_ID, artifactDigest: state.digest, owner: state.account, initialMembers: allocation.members, initialShares: allocation.shares, purchaseCost: cost.toString(), steps: {}, transactions: [], createdAt: Date.now() };
      save();
    }
    if (!isOwner(state.manifest, state.account)) throw new Error('请切换回部署钱包继续。');
    const remaining = DEPLOY_ORDER.filter((name) => state.manifest.steps[name]?.status !== 'confirmed');
    if (!remaining.length) return;
    confirm('部署独立测试合约', `<p>共需完成 ${remaining.length} 个剩余步骤，每一笔由当前钱包确认。</p>${row('管理员 / 平台费钱包', h(shortAddress(state.account)))}${row('模拟采购参考价', `${amount5(state.manifest.purchaseCost)} BNB（不支付）`)}${row('成员份额合计', '100 份')}<p class="help muted">创建模拟矿机 NFT，仅支付部署 Gas。中途取消后保留已确认步骤，下次可继续。</p><details><summary>初始成员</summary>${state.manifest.initialMembers.map((account, i) => row(shortAddress(account), `${state.manifest.initialShares[i]} 份`)).join('')}</details>`, performDeployment, '逐步部署，在钱包确认');
  } catch (error) { notice(friendlyError(error), 'error'); }
}

async function performDeployment() {
  if (state.busy) return;
  state.busy = true; render(); const owner = state.manifest.owner;
  try {
    await chainAndAccount(owner); await validateDeployment();
    for (const name of DEPLOY_ORDER) {
      const previous = state.manifest.steps[name];
      if (previous?.status === 'confirmed') continue;
      await chainAndAccount(owner);
      if (['signing', 'uncertain'].includes(previous?.status)) throw new Error('当前部署的交易响应不完整，请先补录钱包交易编号恢复，不能重复部署。');
      if (previous?.status === 'pending') {
        const outcome = await checkRecord(previous);
        if (outcome === 'pending') { showResult('pending', '部署仍在等待确认', '该步骤已经发送，请检查回执后继续。', previous.hash); return; }
        if (outcome === 'success') continue;
        showResult('failed', '部署交易失败', '本步骤链上执行失败。已确认的部署仍会保留，可再次继续。', previous.hash); return;
      }
      const artifact = state.artifact.contracts[name], linked = linkBytecode(artifact.bytecode, artifact.linkReferences, addressesOf(state.manifest));
      const args = name === 'SandboxSalePool' ? [owner, state.manifest.initialMembers, state.manifest.initialShares, BigInt(state.manifest.purchaseCost)] : [];
      const data = linked + new Interface(artifact.abi).encodeDeploy(args).slice(2);
      const record = { step: name, label: `部署 ${name}`, account: owner, target: null, data, value: '0', status: 'idle', createdAt: Date.now() };
      state.manifest.steps[name] = record; save();
      const outcome = await sendRecord(record);
      if (outcome !== 'success') { showResult(outcome, outcome === 'failed' ? '部署交易失败' : '部署等待确认', outcome === 'failed' ? '本步骤执行失败，可稍后继续。' : '本步骤已发送，确认后再继续部署。', record.hash); return; }
      await validateDeployment(); render();
    }
    state.verified = true; save(); notice(''); showResult('success', '测试项目部署完成', '可以开始提案、审核、投票、模拟成交和 BNB 领取。', state.manifest.steps.SandboxSalePool.hash);
  } catch (error) { showResult(walletRejected(error) ? 'cancelled' : 'pending', walletRejected(error) ? '部署已暂停' : '部署尚未完成', walletRejected(error) ? '你取消了当前钱包确认。已完成的步骤已保存，可继续剩余部署。' : friendlyError(error)); }
  finally { state.busy = false; render(); await refresh(); }
}

async function checkPending() {
  if (state.busy || !state.account) return;
  state.busy = true; render();
  try {
    await chainAndAccount();
    const records = [...Object.values(state.manifest.steps), ...(state.manifest.transactions ?? [])].filter((record) => record.status === 'pending');
    let pending = 0, last = null;
    for (const record of records) { const outcome = await checkRecord(record); if (outcome === 'pending') pending++; else last = { record, outcome }; }
    if (last) showResult(last.outcome, last.outcome === 'success' ? '交易成功' : '交易失败', `${last.record.label}${last.outcome === 'success' ? '已在链上确认。' : '在链上执行失败。'}`, last.record.hash);
    else notice(pending ? `${pending} 笔交易仍在等待确认。` : '没有待确认的测试交易。', pending ? 'wait' : '');
    state.verified = false; await refresh();
  } catch (error) { notice(friendlyError(error), 'error'); }
  finally { state.busy = false; render(); }
}

async function importManifest(event) {
  const file = event.target.files?.[0]; if (!file || state.busy) return;
  try {
    if (file.size > 2000000) throw new Error('测试清单文件过大。');
    const manifest = checkManifest(JSON.parse(await file.text()), state.artifact, state.digest);
    if (state.account) { await chainAndAccount(); await validateDeployment(manifest); }
    state.manifest = manifest; state.data = null; state.verified = Boolean(state.account); epoch++; save(); render(); await refresh();
  } catch (error) { notice(friendlyError(error), 'error'); }
}

async function recoverHash() {
  if (state.busy) return;
  const record = unknownRecords()[Number($('recovery-record')?.value)], hash = state.form.recoveryHash.trim();
  if (!record || !HASH.test(hash)) { notice('请填写完整的钱包交易编号。', 'error'); return; }
  state.busy = true; render();
  try {
    await chainAndAccount();
    const tx = await state.wallet.request({ method: 'eth_getTransactionByHash', params: [hash] });
    if (!transactionMatches(record, tx)) throw new Error('此交易与原操作的钱包、目标、调用或金额不匹配，未更新部署记录。');
    record.hash = hash; record.status = 'pending'; save();
    const outcome = await checkRecord(record);
    if (outcome === 'success') { await validateDeployment(); state.verified = isComplete(state.manifest); save(); }
    showResult(outcome, outcome === 'success' ? '交易恢复成功' : outcome === 'failed' ? '交易失败' : '交易等待确认', outcome === 'success' ? '已恢复该步骤。可以继续剩余测试操作。' : outcome === 'failed' ? '原交易在链上执行失败，可重新进行本步骤。' : '原交易尚未确认，已保存交易编号，请勿重复发送。', hash);
    await refresh();
  } catch (error) { notice(friendlyError(error), 'error'); }
  finally { state.busy = false; render(); }
}

const actions = {
  deploy,
  refresh,
  check: checkPending,
  recover: recoverHash,
  export: () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(state.manifest, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `bemine-sale-sandbox-${state.manifest.owner.slice(0, 8)}.json`; link.click(); URL.revokeObjectURL(url);
  },
  new: () => confirm('创建另一测试项目', '<p>当前项目清单保留在本机。请先导出，以便之后导入使用。</p><p>新建项目需要重新支付三笔部署 Gas。</p>', async () => { state.manifest = null; state.data = null; state.verified = false; localStorage.removeItem(activeKey()); epoch++; render(); }, '开始新项目'),
  propose: async () => {
    try { const price = parseTestPrice(state.form.price), d = state.data; previewWrite('提交出售提案', 'propose', [price, d.reference[0], d.reference[1]], 0n, row('提案出售价格', `${amount5(price)} BNB`)); } catch (error) { notice(friendlyError(error), 'error'); }
  },
  reference: async () => {
    try {
      const price = parseTestPrice(state.form.reference), block = await latestBlock();
      const digest = keccak256(toUtf8Bytes(`BEMINE_SIMULATED_REFERENCE:${addressesOf(state.manifest).SandboxSalePool}:${price}:${block.timestamp}`));
      previewWrite('更新测试参考价', 'setSaleReference', [addressesOf(state.manifest).SandboxSalePool, price, block.timestamp, digest], 0n, row('测试参考价', `${amount5(price)} BNB`));
    } catch (error) { notice(friendlyError(error), 'error'); }
  },
  approve: () => previewWrite('通过低价审核', 'reviewSale', [addressesOf(state.manifest).SandboxSalePool, state.data.id, state.data.proposal.price, true]),
  reject: () => previewWrite('拒绝低价审核', 'reviewSale', [addressesOf(state.manifest).SandboxSalePool, state.data.id, state.data.proposal.price, false], 0n, '<p>拒绝后同一提案不能再次通过审核。</p>'),
  yes: () => previewWrite('投赞成票', 'vote', [state.data.id, true]),
  no: () => previewWrite('投反对票', 'vote', [state.data.id, false]),
  execute: () => previewWrite('执行模拟 NFT 挂牌', 'executeSale', [state.data.id], 0n, row('出售价格', `${amount5(state.data.proposal.price)} BNB`)),
  buy: () => previewWrite('买入模拟矿机 NFT', 'completeSimulatedSale', [state.data.listedProposalId, state.data.salePrice], state.data.salePrice, '<p>本次支付真实 BNB，只买到本测试项目的模拟 NFT。不是正式矿机，也不会产生挖矿收益。</p>'),
  expire: () => previewWrite('撤销到期挂牌', 'cancelExpired'),
  withdraw: () => previewWrite('领取我的 BNB', 'withdrawBnb', [], 0n, row('预计本次领取', `${amount5(state.data.claimable)} BNB`) + '<p>本笔交易同时结算当前钱包的卖款并领取 BNB，不需要重复操作。</p>'),
  transfer: () => {
    try {
      const recipient = state.form.recipient.trim(), text = state.form.shares.trim();
      if (!ADDRESS.test(recipient) || /^0x0{40}$/.test(recipient) || recipient.toLowerCase() === addressesOf(state.manifest).SandboxSalePool.toLowerCase() || !/^\d+$/.test(text)) throw new Error('请填写有效接收钱包与整数份额。');
      const shares = BigInt(text); if (shares <= 0n || shares > state.data.balance) throw new Error('转出份额需大于零且不超过当前持有份额。');
      previewWrite('转出测试份额', 'transfer', [recipient, shares], 0n, row('接收钱包', h(shortAddress(recipient))) + row('转出份额', `${shares} 份`));
    } catch (error) { notice(friendlyError(error), 'error'); }
  },
};

async function start() {
  discoverWallets();
  try {
    const response = await fetch(artifactUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error('测试编译产物未就绪，请稍后刷新。');
    const raw = await response.text();
    state.artifact = checkArtifact(JSON.parse(raw));
    state.digest = `0x${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    if (state.digest !== __SANDBOX_ARTIFACT_DIGEST__) throw new Error('测试产物与当前页面版本不一致，请重新刷新。');
    if (!['127.0.0.1', 'localhost'].includes(location.hostname) && state.artifact.sourceBound !== true) throw new Error('测试工具还未绑定已提交的源码版本。');
    loadSaved(); render();
    // Only read-only updates occur after an explicit connection. No automatic wallet authorization or send.
    setInterval(() => { if (!state.busy && !document.hidden && state.account) void refresh(); }, 12000);
  } catch (error) { app.innerHTML = '<section class="card"><p class="empty">测试工具暂时不可用。</p></section>'; notice(friendlyError(error), 'error'); }
}
void start();
