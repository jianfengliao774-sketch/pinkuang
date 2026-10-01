export const CHAIN_ID = 56;
export const KIND = 'bemine-mainnet-sale-sandbox';
export const DEPLOY_ORDER = ['ShareCheckpoints', 'SaleSettlement', 'SandboxSalePool'];
export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const HASH = /^0x[0-9a-fA-F]{64}$/;
export const PREFIX = 'bemine-sale-sandbox:v1:';
export const MAX_TEST_PRICE = 10n ** 15n;

export function amount5(value) {
  const n = BigInt(value ?? 0);
  if (n < 0n) throw new Error('金额不能为负数。');
  const whole = n / 10n ** 18n;
  const fraction = (n % (10n ** 18n)).toString().padStart(18, '0').slice(0, 5);
  return n > 0n && whole === 0n && fraction === '00000' ? '<0.00001' : `${whole}.${fraction}`;
}

export function parseBnb(input) {
  const text = String(input).trim();
  if (!/^\d+(?:\.\d{1,18})?$/.test(text)) throw new Error('请输入有效 BNB 金额，最多十八位小数。');
  const [whole, fraction = ''] = text.split('.');
  const value = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
  if (value <= 0n || value >= 2n ** 128n) throw new Error('BNB 金额需大于零且在合约范围内。');
  return value;
}

export function exactBnb(value) {
  const n = BigInt(value);
  const fraction = (n % (10n ** 18n)).toString().padStart(18, '0').replace(/0+$/, '');
  return `${n / 10n ** 18n}${fraction ? `.${fraction}` : ''}`;
}

export function parseTestPrice(input) {
  const value = parseBnb(input);
  if (value > MAX_TEST_PRICE) throw new Error('模拟矿机测试金额最高为 0.00100 BNB。');
  return value;
}

export function shortAddress(value) {
  return ADDRESS.test(value ?? '') ? `${value.slice(0, 6)}…${value.slice(-4)}` : '—';
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

export function checkArtifact(artifact) {
  if (artifact?.schemaVersion !== 1 || artifact.kind !== KIND || artifact.chainId !== CHAIN_ID) throw new Error('测试编译产物格式或网络不正确。');
  if (JSON.stringify(artifact.deployOrder) !== JSON.stringify(DEPLOY_ORDER)) throw new Error('测试部署步骤不正确。');
  for (const name of DEPLOY_ORDER) {
    const contract = artifact.contracts?.[name];
    if (!Array.isArray(contract?.abi) || typeof contract.bytecode !== 'string' || contract.bytecode.length < 10) throw new Error(`缺少 ${name} 编译产物。`);
  }
  return artifact;
}

export function linkBytecode(bytecode, references, addresses) {
  let raw = String(bytecode).replace(/^0x/, '');
  const used = new Set();
  for (const libraries of Object.values(references ?? {})) {
    for (const [name, slots] of Object.entries(libraries)) {
      const address = addresses[name];
      if (!DEPLOY_ORDER.slice(0, 2).includes(name) || !ADDRESS.test(address ?? '')) throw new Error(`未部署链接库 ${name}。`);
      for (const slot of slots) {
        if (slot.length !== 20 || !Number.isInteger(slot.start) || slot.start < 0 || slot.start * 2 + 40 > raw.length || used.has(slot.start)) throw new Error('链接库位置无效。');
        used.add(slot.start);
        raw = raw.slice(0, slot.start * 2) + address.slice(2).toLowerCase() + raw.slice(slot.start * 2 + 40);
      }
    }
  }
  if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length % 2) throw new Error('合约字节码仍有未完成的链接。');
  return `0x${raw}`;
}

export function initialMembers(input, fallback) {
  const lines = String(input ?? '').trim().split(/\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { members: [fallback], shares: [100] };
  const members = [], shares = [], seen = new Set();
  for (const line of lines) {
    const [address, count, extra] = line.split(/[\s,，]+/);
    if (!ADDRESS.test(address ?? '') || !/^\d+$/.test(count ?? '') || extra) throw new Error('每行填写一个钱包地址和整数份额，例如 0x… 60。');
    const n = Number(count), key = address.toLowerCase();
    if (n < 1 || n > 100 || seen.has(key)) throw new Error('测试成员地址不能重复，份额需为 1 至 100。');
    seen.add(key); members.push(address); shares.push(n);
  }
  if (shares.reduce((a, b) => a + b, 0) !== 100) throw new Error('所有测试成员的份额合计必须为 100。');
  return { members, shares };
}

export function checkManifest(manifest, artifact, digest) {
  if (manifest?.schemaVersion !== 1 || manifest.kind !== KIND || manifest.chainId !== CHAIN_ID || manifest.artifactDigest !== digest || !ADDRESS.test(manifest.owner ?? '')) throw new Error('请导入本测试版本的部署清单。');
  const forbidden = new Set((artifact.productionExcludedAddresses ?? []).map((a) => String(a).toLowerCase()));
  const seen = new Set();
  for (const name of DEPLOY_ORDER) {
    const step = manifest.steps?.[name];
    if (!step) continue;
    if (!['idle', 'signing', 'uncertain', 'pending', 'confirmed', 'failed'].includes(step.status)) throw new Error('部署记录状态无效。');
    if (step.hash && !HASH.test(step.hash)) throw new Error('部署交易记录无效。');
    if (step.status === 'confirmed') {
      if (!ADDRESS.test(step.address ?? '') || !HASH.test(step.hash ?? '') || forbidden.has(step.address.toLowerCase()) || seen.has(step.address.toLowerCase())) throw new Error('测试合约地址无效或属于正式合约。');
      seen.add(step.address.toLowerCase());
    }
  }
  const { members, shares } = initialMembers((manifest.initialMembers ?? []).map((a, i) => `${a} ${manifest.initialShares?.[i]}`).join('\n'), manifest.owner);
  if (!members.length || shares.reduce((a, b) => a + b, 0) !== 100) throw new Error('测试初始份额无效。');
  parseTestPrice(exactBnb(manifest.purchaseCost));
  return manifest;
}

export function runtimeMatches(code, contract, addresses, selfAddress = null) {
  let expected = linkBytecode(contract.deployedBytecode, contract.deployedLinkReferences, addresses).slice(2).toLowerCase();
  let actual = String(code).replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(actual) || actual.length !== expected.length) return false;
  // Solidity libraries substitute their own address in the initial PUSH20.
  if (selfAddress && expected.startsWith(`73${'0'.repeat(40)}`)) {
    if (!ADDRESS.test(selfAddress) || actual.slice(2, 42) !== selfAddress.slice(2).toLowerCase()) return false;
    expected = expected.slice(0, 2) + selfAddress.slice(2).toLowerCase() + expected.slice(42);
  }
  for (const slots of Object.values(contract.immutableReferences ?? {})) for (const slot of slots) {
    if (!Number.isInteger(slot.start) || !Number.isInteger(slot.length) || slot.start < 0 || slot.length < 1 || (slot.start + slot.length) * 2 > expected.length) throw new Error('合约 immutable 位置无效。');
    const offset = slot.start * 2, length = slot.length * 2;
    expected = expected.slice(0, offset) + '0'.repeat(length) + expected.slice(offset + length);
    actual = actual.slice(0, offset) + '0'.repeat(length) + actual.slice(offset + length);
  }
  return actual === expected;
}

export function isOwner(manifest, account) { return ADDRESS.test(account ?? '') && account.toLowerCase() === manifest?.owner?.toLowerCase(); }
export function addressesOf(manifest) { return Object.fromEntries(DEPLOY_ORDER.filter((name) => manifest?.steps?.[name]?.status === 'confirmed').map((name) => [name, manifest.steps[name].address])); }
export function isComplete(manifest) { return DEPLOY_ORDER.every((name) => manifest?.steps?.[name]?.status === 'confirmed'); }

export function walletRejected(error) {
  return [error, error?.error, error?.info?.error, error?.cause].some((e) => e?.code === 4001 || e?.code === '4001' || e?.code === 'ACTION_REJECTED');
}

export function friendlyError(error) {
  if (walletRejected(error)) return '你取消了钱包确认，交易未发送。';
  const text = String(error?.shortMessage ?? error?.reason ?? error?.message ?? error ?? '操作暂时未完成。');
  const errors = { DeadlineNotReached: '还未达到本测试合约的时间条件。', DeadlinePassed: '当前投票或挂牌已到期。', SaleNotApproved: '请更新测试参考价；低于参考价的出售需管理员通过审核。', ProposalNotPassed: '赞成人数和赞成份额都必须超过一半。', AlreadyVoted: '当前钱包已经对该提案投过票。', NotMember: '当前钱包没有此项目的份额。', ProposalActive: '当前已有进行中的投票。', ProposeCooldown: '当前提案仍在冷却期。', InvalidListing: '当前没有有效挂牌。', OnlyOwner: '请切换到部署钱包完成管理员操作。', PaymentMismatch: '支付金额与挂牌价格不一致。', TradingFrozen: '投票期间份额已冻结。' };
  for (const [key, description] of Object.entries(errors)) if (text.includes(key)) return description;
  return text.replace(/\s*\(action=.*$/s, '').slice(0, 180);
}

export function receiptResult(receipt, expectedHash) {
  if (!receipt || !HASH.test(expectedHash ?? '')) return 'pending';
  const hash = receipt.hash ?? receipt.transactionHash;
  if (String(hash).toLowerCase() !== expectedHash.toLowerCase()) return 'pending';
  const status = receipt.status;
  if (status === 1 || status === 1n || status === '0x1' || status === '0x01') return 'success';
  if (status === 0 || status === 0n || status === '0x0' || status === '0x00') return 'failed';
  return 'pending';
}

export function transactionMatches(record, transaction) {
  if (!transaction || !HASH.test(transaction.hash ?? '') || !ADDRESS.test(record.account ?? '')) return false;
  return (!record.hash || transaction.hash.toLowerCase() === record.hash.toLowerCase())
    && transaction.from?.toLowerCase() === record.account.toLowerCase()
    && (record.target ? transaction.to?.toLowerCase() === record.target.toLowerCase() : !transaction.to)
    && typeof record.data === 'string'
    && String(transaction.input ?? transaction.data).toLowerCase() === record.data.toLowerCase()
    && BigInt(transaction.value ?? 0) === BigInt(record.value);
}

export function proposalView(proposal, reference, review, now) {
  const yesCount = BigInt(proposal?.yesCount ?? 0), yesShares = BigInt(proposal?.yesShares ?? 0);
  const members = BigInt(proposal?.snapshotMemberCount ?? 0), total = BigInt(proposal?.snapshotTotalShares ?? 0);
  const passed = total === 100n && members > 0n && yesCount * 2n > members && yesShares * 2n > total;
  const refPrice = BigInt(reference?.priceWei ?? reference?.[0] ?? 0), refAt = Number(reference?.observedAt ?? reference?.[1] ?? 0);
  const digest = reference?.sourceDigest ?? reference?.[2];
  const referenceFresh = refPrice > 0n && refAt <= now && now - refAt <= 900 && HASH.test(digest ?? '') && !/^0x0{64}$/.test(digest);
  const lowPrice = BigInt(proposal?.price ?? 0) < refPrice;
  const approved = Number(review?.status ?? review?.[0] ?? 0) === 1 && BigInt(review?.priceWei ?? review?.[1] ?? 0) === BigInt(proposal?.price ?? 0);
  const votingOpen = now < Number(proposal?.endsAt ?? 0) && !proposal?.executed;
  return { passed, referenceFresh, lowPrice, approved, votingOpen, executable: passed && referenceFresh && votingOpen && (!lowPrice || approved), yesNeeded: members / 2n + 1n, sharesNeeded: total / 2n + 1n };
}
