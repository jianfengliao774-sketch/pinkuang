import { BrowserProvider, Contract, JsonRpcProvider, ZeroAddress, formatEther, getAddress, parseEther, type Provider, type TransactionReceipt } from 'ethers';
import type { WalletProvider } from './wallet';

export const MARKET_CHAIN_ID = 56;
export const MARKET_PAGE_SIZE = 20;
export const PENDING_MARKET_KEY = 'pinkuang.market.pending.v1';
export const MARKET_ABI = [
  'function factory() view returns(address)', 'function timelock() view returns(address)',
  'function feeBps() view returns(uint16)', 'function nextOrderId() view returns(uint256)',
  'function orders(uint256) view returns(tuple(address seller,address pool,uint256 remaining,uint256 pricePerUnit,bool active))',
  'function bnbOwed(address) view returns(uint256)', 'function list(address,uint256,uint256) returns(uint256)',
  'function fill(uint256,uint256) payable', 'function cancel(uint256)', 'function withdrawBnb()',
  'function orderExpiresAt(uint256) view returns(uint64)', 'function expire(uint256)',
  'error OrderExpired()', 'error OrderNotExpired()', 'error WrongState()', 'error InvalidAmount()', 'error InactiveOrder()', 'error PaymentMismatch()',
  'error NothingToClaim()', 'error InvalidPool()', 'error MarketNotRegistered()', 'error Unauthorized()',
];
export const FACTORY_ABI = ['function shareMarket() view returns(address)', 'function timelock() view returns(address)', 'function isPool(address) view returns(bool)'];
export const POOL_ABI = [
  'function factory() view returns(address)', 'function OFFICIAL_FACTORY() view returns(address)',
  'function shareTradingAllowed() view returns(bool)', 'function state() view returns(uint8)', 'function balanceOf(address) view returns(uint256)',
  'function lockedShares(address) view returns(uint256)', 'function availableShares(address) view returns(uint256)',
  'function treasury() view returns(address)', 'function name() view returns(string)', 'function decimals() view returns(uint8)',
];
export const POOL_STATES = ['认购中', '待购机', '运行中', '整机出售中', '已关闭', '退款中'] as const;
export const BSC_EXPLORER = 'https://bscscan.com';

export type MarketIdentity = { factory: string; market: string; timelock: string; blockNumber: number };
export type PoolPosition = { address: string; name: string; state: number; tradingAllowed: boolean; balance: bigint; locked: bigint; available: bigint; treasury: string };
export type MarketOrder = { id: bigint; seller: string; pool: string; remaining: bigint; pricePerUnit: bigint; active: boolean; expiresAt: bigint; state?: number; tradingAllowed?: boolean; verificationError?: string };
export type OrderPage = { orders: MarketOrder[]; nextCursor: bigint | null; scanned: number; lastOrderId: bigint };
export type MarketAction = { kind: 'list'; pool: string; amount: string; price: string } | { kind: 'fill'; orderId: string; amount: string; expectedPrice: string } | { kind: 'cancel'; orderId: string } | { kind: 'withdraw' };
export type MarketQuote = {
  action: MarketAction; account: string; identity: MarketIdentity; title: string; pool?: string; amount?: bigint;
  gross: bigint; fee: bigint; sellerProceeds: bigint; withdrawal: bigint;
  gasLimit: bigint; gasPrice: bigint; gasCost: bigint; total: bigint; data: string;
};
export type PendingMarketTransaction = {
  version: 1; chainId: 56; account: string; factory: string; market: string; nonce: number;
  action: MarketAction; data: string; value: string; hash?: string; submittedAt: string;
  recoveryHashes?: string[];
};
/** Server-backed, durable journal. Writes must reject conflicting revisions across devices. */
export type MarketJournalStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string, finalizedHash: string): Promise<void>;
};
export type MarketRecovery = {
  pending: PendingMarketTransaction; receipt: TransactionReceipt | null;
  resolution: 'confirmed' | 'reverted' | 'cancelled' | 'replaced' | null; message: string;
};

export function address(value: string): string {
  let result: string;
  try { result = getAddress(value.trim()); } catch { throw new Error('请输入有效的合约地址（0x 开头）。'); }
  if (result === ZeroAddress) throw new Error('不能使用零地址。');
  return result;
}
export const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function shareAmount(value: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) throw new Error('份额必须是 1 至 49 的整数。');
  const amount = BigInt(value);
  if (amount > 49n) throw new Error('每次交易最多 49 份。');
  return amount;
}
export function unitPrice(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)) throw new Error('单价应为非负 BNB 金额，最多 18 位小数。');
  const price = parseEther(value);
  if (price > (2n ** 256n - 1n) / 49n) throw new Error('单价超出合约范围。');
  return price;
}
export function tradeAmounts(amount: bigint, price: bigint) {
  if (amount < 1n || amount > 49n || price < 0n) throw new Error('份额或单价无效。');
  const gross = amount * price;
  if (gross >= 2n ** 256n) throw new Error('成交金额超出合约范围。');
  const fee = gross / 100n;
  return { gross, fee, sellerProceeds: gross - fee };
}
export function requireList(position: Pick<PoolPosition, 'state' | 'tradingAllowed' | 'available'>, amount: bigint) {
  if (position.state !== 2) throw new Error('仅运行中（Active）的资金池可挂单。');
  if (!position.tradingAllowed) throw new Error('整机出售表决期间暂停挂单，待表决结束后再试。');
  if (amount < 1n || amount > 49n || amount > position.available) throw new Error('可用份额不足，已挂单锁定的份额不能重复出售。');
}
export function requireFill(order: MarketOrder, position: Pick<PoolPosition, 'state' | 'tradingAllowed' | 'balance'>, account: string, amount: bigint, now = BigInt(Math.floor(Date.now() / 1000))) {
  if (!order.active || order.remaining === 0n) throw new Error('订单已成交或撤销，请刷新。');
  if (order.expiresAt <= now) throw new Error('订单已到期，请卖家撤单后重新挂单。');
  if (position.state !== 2 || !position.tradingAllowed) throw new Error('资金池当前暂停份额交易；卖家仍可撤单。');
  if (sameAddress(order.seller, account)) throw new Error('这是你的挂单，请使用撤单操作解锁份额。');
  if (amount < 1n || amount > 49n || amount > order.remaining) throw new Error('购买数量超过订单剩余份额。');
  if (position.balance + amount > 49n) throw new Error(`每个钱包最多持有 49 份；当前最多还可购买 ${49n - position.balance} 份。`);
}
export function pageIds(nextOrderId: bigint, cursor: bigint | null = null): bigint[] {
  if (nextOrderId < 1n) throw new Error('市场尚未正确初始化。');
  let current = cursor === null ? nextOrderId - 1n : cursor;
  if (current >= nextOrderId || current < 0n) throw new Error('分页游标无效，请刷新列表。');
  const ids: bigint[] = [];
  while (current > 0n && ids.length < MARKET_PAGE_SIZE) ids.push(current--);
  return ids;
}
export function bnb(value: bigint): string { return formatEther(value); }

export function marketProvider(wallet: WalletProvider | null): Provider {
  return wallet ? new BrowserProvider(wallet, 'any') : new JsonRpcProvider('https://bsc-dataseed.bnbchain.org', 56, { staticNetwork: true });
}
export async function requireWallet(wallet: WalletProvider, expectedAccount: string): Promise<BrowserProvider> {
  const [rawChain, accounts] = await Promise.all([
    wallet.request({ method: 'eth_chainId' }), wallet.request({ method: 'eth_accounts' }),
  ]) as [string, string[]];
  const chain = Number(rawChain);
  if (chain !== MARKET_CHAIN_ID) throw new Error('请将钱包切换到 BSC 主网（Chain ID 56）。');
  if (!accounts[0] || !sameAddress(accounts[0], expectedAccount)) throw new Error('钱包账户已变化，请重新连接并检查交易。');
  return new BrowserProvider(wallet, 'any');
}

export async function readMarketIdentity(provider: Provider, factoryInput: string): Promise<MarketIdentity> {
  if (Number((await provider.getNetwork()).chainId) !== MARKET_CHAIN_ID) throw new Error('当前网络不是 BSC 主网。');
  const factory = address(factoryInput);
  const blockNumber = await provider.getBlockNumber();
  const opts = { blockTag: blockNumber };
  if (await provider.getCode(factory, blockNumber) === '0x') throw new Error('该地址没有 Factory 合约代码。');
  const registry = new Contract(factory, FACTORY_ABI, provider);
  const [marketValue, timelockValue] = await Promise.all([registry.shareMarket(opts), registry.timelock(opts)]);
  const market = address(marketValue), timelock = address(timelockValue);
  const [marketCode, timelockCode] = await Promise.all([provider.getCode(market, blockNumber), provider.getCode(timelock, blockNumber)]);
  if (marketCode === '0x' || timelockCode === '0x') throw new Error('市场或时间锁地址缺少合约代码。');
  const contract = new Contract(market, MARKET_ABI, provider);
  const lock = new Contract(timelock, ['function getMinDelay() view returns(uint256)'], provider);
  const [boundFactory, boundTimelock, delay, fee] = await Promise.all([contract.factory(opts), contract.timelock(opts), lock.getMinDelay(opts), contract.feeBps(opts)]);
  if (!sameAddress(boundFactory, factory) || !sameAddress(boundTimelock, timelock)) throw new Error('Factory、市场、时间锁双向绑定不匹配。');
  if (delay < 172800n) throw new Error('时间锁升级延迟不足 48 小时。');
  if (fee !== 100n) throw new Error('市场手续费不是当前版本约定的 1%。');
  return { factory, market, timelock, blockNumber };
}

export async function readPoolPosition(provider: Provider, identity: MarketIdentity, poolInput: string, account: string | null): Promise<PoolPosition> {
  const pool = address(poolInput), opts = { blockTag: identity.blockNumber };
  const registry = new Contract(identity.factory, FACTORY_ABI, provider);
  if (!(await registry.isPool(pool, opts)) || await provider.getCode(pool, identity.blockNumber) === '0x') throw new Error('该资金池未在当前 Factory 登记。');
  const contract = new Contract(pool, POOL_ABI, provider);
  const [factory, officialFactory, state, treasury, name, decimals, tradingAllowed] = await Promise.all([
    contract.factory(opts), contract.OFFICIAL_FACTORY(opts), contract.state(opts), contract.treasury(opts), contract.name(opts), contract.decimals(opts), contract.shareTradingAllowed(opts),
  ]);
  if (!sameAddress(factory, identity.factory) || !sameAddress(officialFactory, identity.factory)) throw new Error('资金池与 Factory 的绑定不匹配。');
  if (decimals !== 0n || state < 0n || state > 5n) throw new Error('资金池份额精度或状态不受支持。');
  const [balance, locked, available]: bigint[] = account ? await Promise.all([
    contract.balanceOf(account, opts), contract.lockedShares(account, opts), contract.availableShares(account, opts),
  ]) : [0n, 0n, 0n];
  if (locked > balance || available !== balance - locked) throw new Error('资金池份额账目不一致，暂不可交易。');
  return { address: pool, name, state: Number(state), tradingAllowed, treasury: address(treasury), balance, locked, available };
}

export async function readOrder(provider: Provider, identity: MarketIdentity, id: bigint): Promise<MarketOrder> {
  if (id < 1n) throw new Error('订单编号无效。');
  const market = new Contract(identity.market, MARKET_ABI, provider);
  const opts = { blockTag: identity.blockNumber };
  const [result, expiresAt] = await Promise.all([market.orders(id, opts), market.orderExpiresAt(id, opts)]);
  return { id, seller: result.seller, pool: result.pool, remaining: result.remaining, pricePerUnit: result.pricePerUnit, active: result.active, expiresAt };
}

export async function readOrderPage(provider: Provider, identity: MarketIdentity, cursor: bigint | null = null): Promise<OrderPage> {
  const contract = new Contract(identity.market, MARKET_ABI, provider);
  const nextId: bigint = await contract.nextOrderId({ blockTag: identity.blockNumber });
  const ids = pageIds(nextId, cursor), orders: MarketOrder[] = [];
  // At most four order requests concurrently; each page scans only 20 IDs.
  for (let offset = 0; offset < ids.length; offset += 4) {
    orders.push(...await Promise.all(ids.slice(offset, offset + 4).map(id => readOrder(provider, identity, id))));
  }
  const states = new Map<string, { state?: number; tradingAllowed?: boolean; verificationError?: string }>();
  for (const order of orders.filter(order => order.active)) {
    const key = order.pool.toLowerCase();
    if (!states.has(key)) {
      try {
        const { state, tradingAllowed } = await readPoolPosition(provider, identity, order.pool, null);
        states.set(key, { state, tradingAllowed });
      }
      catch (error) { states.set(key, { verificationError: marketError(error) }); }
    }
    Object.assign(order, states.get(key));
  }
  const last = ids.at(-1) ?? 0n;
  return { orders: orders.filter(order => order.active && order.remaining > 0n), nextCursor: last > 1n ? last - 1n : null, scanned: ids.length, lastOrderId: nextId - 1n };
}

export async function readMarketCredit(provider: Provider, identity: MarketIdentity, account: string | null): Promise<bigint> {
  return account ? new Contract(identity.market, MARKET_ABI, provider).bnbOwed(account, { blockTag: identity.blockNumber }) : 0n;
}

/** One display-only read before the buyer chooses an amount; preview rechecks the full pool. */
export async function readBuyerBalance(provider: Provider, pool: string, account: string): Promise<bigint> {
  return new Contract(address(pool), POOL_ABI, provider).balanceOf(account);
}

export async function prepareMarketAction(wallet: WalletProvider, account: string, factory: string, action: MarketAction): Promise<MarketQuote> {
  const provider = await requireWallet(wallet, account);
  const identity = await readMarketIdentity(provider, factory);
  const signer = await provider.getSigner(account);
  const market = new Contract(identity.market, MARKET_ABI, signer);
  let method: string, args: unknown[] = [], pool: string | undefined, amount: bigint | undefined;
  let gross = 0n, fee = 0n, sellerProceeds = 0n, withdrawal = 0n, title: string;
  if (action.kind === 'list') {
    amount = shareAmount(action.amount); const price = unitPrice(action.price);
    const position = await readPoolPosition(provider, identity, action.pool, account);
    requireList(position, amount); pool = position.address; method = 'list'; args = [pool, amount, price]; title = '确认挂单';
  } else if (action.kind === 'fill') {
    const order = await readOrder(provider, identity, BigInt(action.orderId));
    const position = await readPoolPosition(provider, identity, order.pool, account);
    amount = shareAmount(action.amount); requireFill(order, position, account, amount);
    if (order.pricePerUnit.toString() !== action.expectedPrice) throw new Error('订单价格与预览不一致，请刷新。');
    ({ gross, fee, sellerProceeds } = tradeAmounts(amount, order.pricePerUnit));
    pool = order.pool; method = 'fill'; args = [order.id, amount]; title = '确认购买份额';
  } else if (action.kind === 'cancel') {
    const order = await readOrder(provider, identity, BigInt(action.orderId));
    if (!order.active || !sameAddress(order.seller, account)) throw new Error('仅卖家可撤销尚未关闭的订单。');
    await readPoolPosition(provider, identity, order.pool, account); // All states, including Listed / Closed, can cancel.
    pool = order.pool; amount = order.remaining; method = 'cancel'; args = [order.id]; title = '确认撤销挂单';
  } else {
    withdrawal = await readMarketCredit(provider, identity, account);
    if (withdrawal === 0n) throw new Error('当前没有可领取的市场 BNB。');
    method = 'withdrawBnb'; title = '确认领取 BNB';
  }
  const fn = market.getFunction(method), overrides = { value: gross };
  // estimateGas executes the same call and reports reverts; a separate staticCall duplicates it.
  const estimate: bigint = await fn.estimateGas(...args, overrides);
  const gasLimit = (estimate * 120n + 99n) / 100n;
  const gasPrice = (await provider.getFeeData()).gasPrice;
  if (!gasPrice || gasPrice <= 0n) throw new Error('无法读取当前 BSC Gas 价格。');
  const gasCost = gasLimit * gasPrice, total = gross + gasCost;
  if (await provider.getBalance(account) < total) throw new Error(`BNB 余额不足，成交金额与 Gas 上限合计 ${bnb(total)} BNB。`);
  return { action, account, identity, title, pool, amount, gross, fee, sellerProceeds, withdrawal, gasLimit, gasPrice, gasCost, total, data: market.interface.encodeFunctionData(method, args) };
}

/** Final, narrow check: the exact destination, amount and action must still execute. */
export async function verifyMarketQuoteForSend(provider: Provider, quote: MarketQuote): Promise<void> {
  const [network, blockNumber] = await Promise.all([provider.getNetwork(), provider.getBlockNumber()]);
  if (Number(network.chainId) !== MARKET_CHAIN_ID) throw new Error('请将钱包切换到 BSC 主网（Chain ID 56）。');
  const opts = { blockTag: blockNumber };
  const factory = new Contract(quote.identity.factory, FACTORY_ABI, provider);
  const market = new Contract(quote.identity.market, MARKET_ABI, provider);
  const checks: Promise<unknown>[] = [
    factory.shareMarket(opts).then((current: string) => {
      if (!sameAddress(current, quote.identity.market)) throw new Error('市场地址已变化，请重新预览交易。');
    }),
    market.feeBps(opts).then((current: bigint) => {
      if (current !== 100n) throw new Error('市场手续费已变化，请重新预览交易。');
    }),
    provider.call({ to: quote.identity.market, from: quote.account, data: quote.data, value: quote.gross, gasLimit: quote.gasLimit, blockTag: blockNumber }),
  ];
  if (quote.action.kind === 'fill') {
    const fill = quote.action;
    checks.push(readOrder(provider, { ...quote.identity, blockNumber }, BigInt(fill.orderId)).then(order => {
      if (!order.active || order.expiresAt <= BigInt(Math.floor(Date.now() / 1000))
        || order.pricePerUnit.toString() !== fill.expectedPrice || !quote.pool || !sameAddress(order.pool, quote.pool)
        || quote.amount === undefined || order.remaining < quote.amount || sameAddress(order.seller, quote.account)) {
        throw new Error('订单、价格或可购买份额已变化，请重新预览交易。');
      }
      if (tradeAmounts(quote.amount, order.pricePerUnit).gross !== quote.gross) {
        throw new Error('成交金额已变化，请重新预览交易。');
      }
    }));
  }
  await Promise.all(checks);
}

export function parseMarketPending(raw: string | null): PendingMarketTransaction | null {
  if (!raw) return null;
  let saved: PendingMarketTransaction;
  try { saved = JSON.parse(raw); } catch { throw new Error('服务器待确认交易记录无法读取，请保留记录并核对 BscScan。'); }
  if (saved.version !== 1 || saved.chainId !== 56 || !Number.isSafeInteger(saved.nonce) || saved.nonce < 0
    || !/^0x(?:[0-9a-f]{2})+$/i.test(saved.data) || !/^\d+$/.test(saved.value) || (saved.hash && !/^0x[0-9a-f]{64}$/i.test(saved.hash))
    || (saved.recoveryHashes !== undefined && (!Array.isArray(saved.recoveryHashes) || saved.recoveryHashes.length > 16
      || saved.recoveryHashes.some(hash => typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash))))) {
    throw new Error('服务器待确认交易记录异常，已停止发送新交易。');
  }
  address(saved.account); address(saved.factory); address(saved.market);
  return saved;
}

export async function loadMarketPending(storage: Pick<MarketJournalStorage, 'getItem'>): Promise<PendingMarketTransaction | null> {
  return parseMarketPending(await storage.getItem(PENDING_MARKET_KEY));
}

function canonicalJournalValue(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
function sameJournalRecord(left: PendingMarketTransaction, right: PendingMarketTransaction): boolean {
  return canonicalJournalValue(left) === canonicalJournalValue(right);
}

export function sameMarketIntent(left: PendingMarketTransaction, right: PendingMarketTransaction): boolean {
  return left.version === right.version && left.chainId === right.chainId
    && sameAddress(left.account, right.account) && sameAddress(left.factory, right.factory)
    && sameAddress(left.market, right.market) && left.nonce === right.nonce
    && left.data.toLowerCase() === right.data.toLowerCase() && left.value === right.value
    && left.submittedAt === right.submittedAt
    && canonicalJournalValue(left.action) === canonicalJournalValue(right.action);
}

/** A lost server write must not hide a hash already returned by the wallet. */
export function withObservedMarketHash(
  saved: PendingMarketTransaction | null, observed: PendingMarketTransaction | null,
): PendingMarketTransaction | null {
  return saved && observed?.hash && sameMarketIntent(saved, observed)
    ? { ...saved, hash: saved.hash ?? observed.hash } : saved;
}

/** Transfer only an authenticated wallet's old browser record into the server journal. */
export async function migrateLegacyMarketPending(
  storage: MarketJournalStorage, account: string, legacyStorage: Pick<Storage, 'getItem' | 'removeItem'>,
): Promise<PendingMarketTransaction | null> {
  let current = await loadMarketPending(storage);
  if (current && !sameAddress(current.account, account)) throw new Error('服务器交易记录属于其他账户，市场写操作已暂停。');
  let legacyRaw: string | null;
  try { legacyRaw = legacyStorage.getItem(PENDING_MARKET_KEY); }
  catch { return current; } // Disabled browser storage cannot displace the server source of truth.
  if (!legacyRaw) return current;
  const legacy = parseMarketPending(legacyRaw)!;
  if (!sameAddress(legacy.account, account)) return current; // Preserve the other wallet's history.
  if (current) {
    if (!sameJournalRecord(current, legacy)) throw new Error('服务器与本机旧交易记录冲突，已暂停交易；请保留两份记录并人工核对。');
  } else {
    await storage.setItem(PENDING_MARKET_KEY, JSON.stringify(legacy));
    current = await loadMarketPending(storage);
    if (!current || !sameJournalRecord(current, legacy)) throw new Error('旧交易记录尚未在服务器确认，已暂停交易。');
  }
  try { legacyStorage.removeItem(PENDING_MARKET_KEY); }
  catch { /* Server persistence is already confirmed; browser cleanup can be retried. */ }
  return current;
}

/** All journal checks, simulations and the signature request run inside one cross-tab lock. */
export async function withMarketTransactionLock<T>(action: () => Promise<T>, locks: Pick<LockManager, 'request'> | undefined = typeof navigator !== 'undefined' ? navigator.locks : undefined): Promise<T> {
  if (locks) {
    return locks.request('pinkuang-market-chain56', { ifAvailable: true, mode: 'exclusive' }, async lock => {
      if (!lock) throw new Error('另一个页面正在提交市场交易，请等该页面完成并核对回执。');
      return action();
    });
  }
  if (typeof window !== 'undefined') throw new Error('当前浏览器不支持跨页面交易锁，请使用现代浏览器和 HTTPS / localhost。');
  return action(); // Non-browser callers are used only by disposable local tests.
}

export async function sendMarketAction(wallet: WalletProvider, quote: MarketQuote, storage: MarketJournalStorage, onPending: (pending: PendingMarketTransaction | null) => void): Promise<PendingMarketTransaction> {
  return withMarketTransactionLock(() => sendMarketActionLocked(wallet, quote, storage, onPending));
}

/** Preserve the broadcast hash in memory before the server update can fail. */
export async function recordMarketBroadcast(
  storage: MarketJournalStorage, pending: PendingMarketTransaction, hash: string,
  onPending: (pending: PendingMarketTransaction | null) => void,
): Promise<void> {
  if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('钱包返回了无效的交易哈希；请保留服务器意图并核对钱包。');
  pending.hash = hash;
  onPending({ ...pending });
  try { await storage.setItem(PENDING_MARKET_KEY, JSON.stringify(pending)); }
  catch {
    throw new Error(`交易可能已广播，哈希 ${hash}，但服务器尚未确认保存。请复制此哈希并在待核对区补录，勿重发交易。`);
  }
}

async function sendMarketActionLocked(wallet: WalletProvider, quote: MarketQuote, storage: MarketJournalStorage, onPending: (pending: PendingMarketTransaction | null) => void): Promise<PendingMarketTransaction> {
  if (await loadMarketPending(storage)) throw new Error('已有待确认的市场交易，请先核对回执。');
  const provider = new BrowserProvider(wallet, 'any');
  await verifyMarketQuoteForSend(provider, quote);
  const nonce = await provider.getTransactionCount(quote.account, 'pending');
  await requireWallet(wallet, quote.account);
  const pending: PendingMarketTransaction = {
    version: 1, chainId: 56, account: quote.account, factory: quote.identity.factory, market: quote.identity.market,
    nonce, action: quote.action, data: quote.data, value: quote.gross.toString(), submittedAt: new Date().toISOString(),
  };
  // The server's CAS write durably accepts this intent before the wallet can broadcast.
  await storage.setItem(PENDING_MARKET_KEY, JSON.stringify(pending));
  onPending({ ...pending });
  try {
    const transaction = provider.getRpcTransaction({
      from: quote.account, to: pending.market, data: pending.data, value: quote.gross,
      gasLimit: quote.gasLimit, gasPrice: quote.gasPrice, nonce, chainId: 56, type: 0,
    });
    const hash = await wallet.request({ method: 'eth_sendTransaction', params: [transaction] }) as string;
    await recordMarketBroadcast(storage, pending, hash, onPending);
    return pending;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    // Even ACTION_REJECTED is not proof that the nonce was never broadcast. Keep the
    // intent until a same-nonce cancellation or replacement is finalized on-chain.
    if (code === 4001 || code === 'ACTION_REJECTED') {
      throw new Error(`钱包拒绝或取消了签名。交易意图已保存在服务器（nonce ${pending.nonce}）；请用钱包发送相同 nonce 的 0 BNB 自转取消交易，并在下方补录哈希，最终确认后才能重新发送。`);
    }
    // Other failures might have broadcast. Keep the intent and never retry automatically.
    throw error;
  }
}

/** Only a canonical, finalized same-nonce transaction can retire an intent. Never sends or signs. */
export async function recoverMarketReceipt(provider: Provider, pending: PendingMarketTransaction, hash?: string): Promise<MarketRecovery> {
  if (Number((await provider.getNetwork()).chainId) !== 56) throw new Error('请在 BSC 主网核对交易。');
  if (hash !== undefined && !/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('请输入钱包记录中的 BSC 交易哈希。');
  const hashes = [...new Set([pending.hash, ...(pending.recoveryHashes ?? []), hash].filter((item): item is string => !!item).map(item => item.toLowerCase()))];
  if (!hashes.length) throw new Error('请输入钱包记录中的原交易、加速或取消交易哈希。');
  if (hashes.length > 17) throw new Error('已记录过多恢复哈希，请保留记录并人工核对。');
  const updated = { ...pending, recoveryHashes: [...(pending.recoveryHashes ?? [])] };
  const waiting = (message: string, receipt: TransactionReceipt | null = null): MarketRecovery => ({ pending: updated, receipt, resolution: null, message });
  let candidate: { receipt: TransactionReceipt; original: boolean; cancellation: boolean } | undefined;
  for (const candidateHash of hashes) {
    const transaction = await provider.getTransaction(candidateHash);
    if (!transaction) continue; // A missing RPC result cannot prove a dropped transaction.
    if (transaction.hash.toLowerCase() !== candidateHash || !sameAddress(transaction.from, pending.account)
      || transaction.nonce !== pending.nonce || transaction.chainId !== 56n) {
      throw new Error('该哈希与本次账户、nonce 或网络不匹配，记录已保留。');
    }
    const original = !!transaction.to && sameAddress(transaction.to, pending.market)
      && transaction.data.toLowerCase() === pending.data.toLowerCase() && transaction.value.toString() === pending.value;
    const cancellation = !!transaction.to && sameAddress(transaction.to, pending.account) && transaction.data === '0x' && transaction.value === 0n;
    if (pending.hash?.toLowerCase() === candidateHash && !original) throw new Error('原交易哈希的市场、操作或金额不匹配。');
    if (!updated.hash && original) updated.hash = candidateHash;
    if (candidateHash !== updated.hash?.toLowerCase() && !updated.recoveryHashes.some(item => item.toLowerCase() === candidateHash)) {
      if (updated.recoveryHashes.length >= 16) throw new Error('已记录过多恢复哈希，请保留记录并人工核对。');
      updated.recoveryHashes.push(candidateHash);
    }
    const receipt = await provider.getTransactionReceipt(candidateHash);
    if (!receipt) continue;
    if (receipt.hash.toLowerCase() !== candidateHash || !sameAddress(receipt.from, pending.account)
      || receipt.to?.toLowerCase() !== transaction.to?.toLowerCase()
      || transaction.blockNumber !== receipt.blockNumber || transaction.blockHash !== receipt.blockHash
      || (receipt.status !== 0 && receipt.status !== 1)) throw new Error('交易与回执身份不一致，保留记录等待人工核对。');
    const canonical = await provider.getBlock(receipt.blockNumber);
    if (!canonical?.hash || canonical.hash !== receipt.blockHash) continue;
    if (candidate) return waiting('节点返回多个同 nonce 的规范链回执，结果不一致；保留记录并更换节点核对。');
    candidate = { receipt, original, cancellation };
  }
  let finalized;
  try { finalized = await provider.getBlock('finalized'); }
  catch { return waiting('节点无法提供 finalized 最终区块；保留记录，请稍后核对或使用支持最终性的 BSC 节点。', candidate?.receipt); }
  if (!finalized?.hash) return waiting('暂未获得最终区块，记录已保留。', candidate?.receipt);
  const finalizedNonce = await provider.getTransactionCount(pending.account, finalized.number);
  if (!candidate) return waiting(finalizedNonce > pending.nonce
    ? '该 nonce 已在最终区块中使用，但未找到已记录交易的规范链回执。请补录钱包中的加速、取消或替换哈希；不会自动重发。'
    : '交易尚未最终确认，或回执已因重组消失。记录已保留，请稍后核对；不要重复发送。');
  const receipt = candidate.receipt;
  const latest = await provider.getBlock('latest');
  if (!latest || latest.number - receipt.blockNumber + 1 < 2 || finalized.number < receipt.blockNumber || finalizedNonce <= pending.nonce) {
    return waiting('交易已进入区块，仍在等待至少 2 次确认及 BSC finalized 最终性。记录已保留。', receipt);
  }
  // Re-read both canonical anchors after the nonce/finality checks; a reorg during the reads stays pending.
  const [canonical, finalizedCanonical] = await Promise.all([provider.getBlock(receipt.blockNumber), provider.getBlock(finalized.number)]);
  if (canonical?.hash !== receipt.blockHash || finalizedCanonical?.hash !== finalized.hash) return waiting('核对期间链上区块发生变化，记录已保留，等待重新确认。');
  if (Number((await provider.getNetwork()).chainId) !== 56) throw new Error('核对期间网络发生变化，记录已保留。');
  const resolution = candidate.original ? (receipt.status === 1 ? 'confirmed' : 'reverted') : candidate.cancellation && receipt.status === 1 ? 'cancelled' : 'replaced';
  const message = resolution === 'confirmed' ? '市场交易已最终确认。请刷新订单与余额。'
    : resolution === 'reverted' ? '市场交易已最终回滚，Gas 已消耗。请重新读取链上状态。'
    : resolution === 'cancelled' ? '钱包取消交易已最终确认，原市场交易已失效。未重新发送任何操作。'
    : '另一笔同 nonce 交易已最终确认，原市场交易已失效。请查看替换交易详情；这不代表原市场操作成功。';
  return { pending: updated, receipt, resolution, message };
}

/** Re-read and update the journal under the same lock as sending; stale tabs cannot erase a newer intent. */
export async function reconcileMarketPending(provider: Provider, pending: PendingMarketTransaction, storage: MarketJournalStorage, hash?: string): Promise<MarketRecovery> {
  return withMarketTransactionLock(async () => {
    const current = await loadMarketPending(storage);
    if (!current || !sameMarketIntent(current, pending)) {
      throw new Error('待确认记录已被其他页面更新，请刷新页面后再核对。');
    }
    const result = await recoverMarketReceipt(provider, current, hash);
    await storage.setItem(PENDING_MARKET_KEY, JSON.stringify(result.pending));
    if (result.resolution && result.receipt) await storage.removeItem(PENDING_MARKET_KEY, result.receipt.hash);
    return result;
  });
}

export function marketError(error: unknown): string {
  const item = error as { code?: number | string; shortMessage?: string; message?: string; revert?: { name?: string } };
  if (item.code === 4001 || item.code === 'ACTION_REJECTED') return '你已取消钱包请求，未确认发送交易。';
  const known: Record<string, string> = { OrderExpired: '订单已到期，请撤单后重新挂单。', WrongState: '资金池状态已变化，目前不可成交。', InactiveOrder: '订单已成交或撤销，请刷新。', InsufficientUnlockedShares: '可用份额不足。', ShareOutOfRange: '购买后持仓不能超过 49 份。', NothingToClaim: '目前没有可领取的 BNB。' };
  return known[item.revert?.name ?? ''] || (item.shortMessage || item.message || '读取失败，请检查网络后重试。').slice(0, 400);
}
