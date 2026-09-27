import { formatUnits, getAddress } from 'ethers';

export const POOL_STATES = ['Funding', 'Funded', 'Active', 'Listed', 'Closed', 'Refunding'];
export const shortAddress = value => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) ? `${value.slice(0, 6)}…${value.slice(-4)}` : '—';
/** Formatting never feeds back into transaction amounts. */
export function amount(value, decimals = 18, places = 5) {
  if (value === null || value === undefined) return '—';
  const exact = formatUnits(BigInt(value), decimals);
  const [whole, fraction = ''] = exact.split('.');
  const truncated = fraction.slice(0, places).replace(/0+$/, '');
  if (BigInt(value) > 0n && whole === '0' && !truncated) return `<0.${'0'.repeat(places - 1)}1`;
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${truncated ? `.${truncated}` : ''}`;
}
export function sumKnown(rows, field) {
  if (rows.some(row => row[field] === null || row[field] === undefined)) return null;
  return rows.reduce((total, row) => total + BigInt(row[field]), 0n);
}
export function viewPool(row) {
  if (!row) return null;
  const token = row.params?.circuitId ?? row.tokenId;
  const collection = row.params?.circuits ?? row.collection;
  const name = collection?.toLowerCase() === '0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c' ? 'Behemoth' : collection ? 'TapeOut' : '—';
  return { ...row, id: row.pool, poolAddress: row.pool, tokenId: token?.toString() ?? '—', name,
    status: row.state == null ? 'Unknown' : POOL_STATES[Number(row.state)] ?? 'Unknown',
    funded: row.totalSupply == null ? null : Number(row.totalSupply),
    remaining: row.totalSupply == null ? null : Math.max(0, 100 - Number(row.totalSupply)),
    color: name === 'Behemoth' ? 'violet' : 'blue', daily: null,
    members: row.memberCount == null ? null : Number(row.memberCount) };
}
export function parseProductRoute(hash) {
  const [route, input] = (hash.replace(/^#/, '') || 'home').split('/');
  if (route === 'detail') {
    try { return { route, pool: getAddress(input) }; } catch { return { route, pool: null, invalid: true }; }
  }
  return { route: ['home', 'overview', 'pools', 'market', 'rewards', 'governance', 'records'].includes(route) ? route : 'home', pool: null };
}
export const explorerAddress = address => `https://bscscan.com/address/${getAddress(address)}`;
export const explorerTransaction = hash => /^0x[\da-f]{64}$/i.test(hash ?? '') ? `https://bscscan.com/tx/${hash}` : null;
export function exportActivityCsv(rows) {
  const cell = value => {
    let text = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return '\uFEFF' + [['Block', 'Event', 'Contract', 'Transaction', 'Fields'], ...rows.map(row => [row.blockNumber, row.event ?? row.name, row.contract ?? row.address, row.transactionHash ?? row.txHash, JSON.stringify(row.args ?? row.fields ?? {}, (_, v) => typeof v === 'bigint' ? v.toString() : v)])].map(row => row.map(cell).join(',')).join('\r\n');
}
