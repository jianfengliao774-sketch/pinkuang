import { ZeroAddress } from 'ethers';

const name = row => row.event ?? row.name;
const fields = row => row.fields ?? row.args ?? {};
const address = value => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) ? value.toLowerCase() : null;
const integer = value => {
  const text = typeof value === 'bigint' ? value.toString() : value;
  if (typeof text !== 'string' || !/^(0|[1-9]\d*)$/.test(text) || text.length > 78) return null;
  const result = BigInt(text);
  return result < 2n ** 256n ? result : null;
};
const logIndex = row => Number.isSafeInteger(row.logIndex) && row.logIndex >= 0 ? row.logIndex : null;
function groupKey(row) {
  const hash = row.transactionHash ?? row.txHash;
  const contract = address(row.contract ?? row.address ?? row.pool);
  if (!/^0x[\da-f]{64}$/i.test(hash ?? '') || !contract || row.blockNumber == null) return null;
  return `${String(row.blockNumber)}:${hash.toLowerCase()}:${contract}`;
}

/** Wallet overview only. Public records/CSV must retain every original log.
 * A subscription emits both an ERC20 mint and Deposited. Suppress only the
 * single matching mint, not other transfers/actions sharing the transaction.
 */
export function summarizeOverviewActivity(rows) {
  const groups = new Map();
  rows.forEach((row, index) => {
    if (name(row) !== 'Transfer') return;
    const f = fields(row), key = groupKey(row), value = integer(f.value);
    if (!key || address(f.from) !== ZeroAddress || !address(f.to) || value === null || value === 0n || logIndex(row) === null) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row, index, to: address(f.to), value });
  });
  const hidden = new Set();
  for (const row of rows) {
    if (name(row) !== 'Deposited' || logIndex(row) === null) continue;
    const f = fields(row), recipient = address(f.user ?? f.member), shares = integer(f.shares);
    if (!recipient || shares === null || shares === 0n) continue;
    const candidates = (groups.get(groupKey(row)) ?? []).filter(mint => !hidden.has(mint.index)
      && mint.to === recipient && mint.value === shares && logIndex(mint.row) < logIndex(row));
    // The closest preceding matching mint belongs to this deposit. Even a
    // batched tx can contain several independent deposits/transfers.
    candidates.sort((a, b) => logIndex(b.row) - logIndex(a.row));
    if (candidates.length) hidden.add(candidates[0].index);
  }
  return rows.filter((_, index) => !hidden.has(index));
}

/** Raw exact token values; presentation precision never changes transactions. */
export function activityAmounts(row) {
  const f = fields(row), out = [];
  const add = (key, kind = 'amount', symbol = 'BNB') => {
    const value = integer(f[key]);
    if (value !== null) out.push(Object.freeze({ kind, amount: value, symbol, decimals: symbol === 'BEM' ? 8 : 18 }));
  };
  switch (name(row)) {
    case 'Deposited': case 'DepositWithdrawn': case 'BnbWithdrawn': case 'PurchaseSurplusSettled': add('amount'); break;
    case 'Purchased': add('cost'); break;
    case 'BemClaimed': add('amount', 'amount', 'BEM'); break;
    case 'Harvested': add('toMembers', 'amount', 'BEM'); break;
    case 'SaleCompleted': add('gross'); break;
    case 'OrderFilled': add('gross', 'gross'); add('fee', 'sellerFee'); break;
    case 'BuyerFeeCharged': add('buyerFee', 'buyerFee'); break;
    default: break;
  }
  return out;
}
