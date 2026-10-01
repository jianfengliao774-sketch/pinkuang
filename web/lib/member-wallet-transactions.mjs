import { toQuantity } from 'ethers';
import { isFreshWalletAction } from '../../deploy/shared/fresh-wallet-actions.mjs';
import { productGasLimit, validateProductTransactionStage } from './live-transactions.mjs';

const HASH = /^0x[0-9a-f]{64}$/i;
const sending = new Set();
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export function directMemberTransaction(config, transaction, action) {
  if (config?.displayOnly !== true) return false;
  try {
    const normalized = validateProductTransactionStage(config, transaction, action);
    return isFreshWalletAction(normalized.targetType, normalized.action.kind, normalized.value);
  } catch { return false; }
}

/** No login, journal, simulation, nonce, balance or gas-price RPC before opening the wallet. */
export async function sendMemberWalletTransaction({ provider, config, transaction, action, onState }) {
  if (!directMemberTransaction(config, transaction, action)) throw new Error('该操作不能使用用户钱包直接发送。');
  const intent = validateProductTransactionStage(config, transaction, action);
  if (typeof provider?.request !== 'function') throw new Error('请先连接钱包。');
  const lane = intent.account.toLowerCase();
  if (sending.has(lane)) throw new Error('钱包确认窗口已打开。');
  sending.add(lane);
  try {
    onState?.({ status: 'awaiting-signature' });
    // The wallet manages nonce, fee selection, available funds and approval.
    // A fixed gas cap avoids an application-side estimate; unused gas is not charged.
    const hash = await provider.request({ method: 'eth_sendTransaction', params: [{
      chainId: '0x38', from: intent.account, to: intent.target, data: intent.data,
      value: toQuantity(intent.value), gas: toQuantity(productGasLimit(intent.action.kind, intent.targetType)),
    }] });
    if (!HASH.test(hash ?? '')) throw new Error('钱包未返回交易哈希，请查看钱包交易记录。');
    const record = {
      hash, account: intent.account, target: intent.target, action: intent.action.kind,
      value: intent.value.toString(), data: intent.data, submittedAt: new Date().toISOString(), status: 'pending',
    };
    // Save before returning even if the user switched accounts while the wallet was open.
    const saved = readMemberTransactions(config, intent.account);
    saveMemberTransactions(config, intent.account, [...saved.filter(r => r.hash !== hash), record]);
    return { status: 'pending', walletOnly: true, hash, record };
  } finally { sending.delete(lane); }
}

function storageKey(config, account) {
  const graph = { ...config.manifest, ...config };
  return `bemine-member-transactions:56:${graph.factory.toLowerCase()}:${graph.portfolioFactory.toLowerCase()}:${account.toLowerCase()}`;
}
export function readMemberTransactions(config, account, storage) {
  try {
    storage ??= globalThis.localStorage;
    const records = JSON.parse(storage.getItem(storageKey(config, account)) ?? '[]');
    return Array.isArray(records) ? records.filter(r => HASH.test(r?.hash ?? '') && same(r.account, account)
      && /^0x[0-9a-f]{40}$/i.test(r.target ?? '') && ['pending', 'confirmed', 'failed'].includes(r.status)).slice(-20) : [];
  } catch { return []; }
}
export function saveMemberTransactions(config, account, records, storage) {
  try {
    storage ??= globalThis.localStorage;
    storage.setItem(storageKey(config, account), JSON.stringify(records.slice(-20)));
  } catch { /* Wallet history remains authoritative if storage is unavailable. */ }
}

/** Read-only background work. A read failure never resends a transaction. */
export async function readMemberReceipt(provider, record) {
  const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [record.hash] });
  if (!receipt) return { status: 'pending' };
  if (!same(receipt.transactionHash, record.hash) || !same(receipt.from, record.account)
    || !same(receipt.to, record.target) || !HASH.test(receipt.blockHash ?? '')
    || !/^0x[0-9a-f]+$/i.test(receipt.blockNumber ?? '') || !['0x0', '0x1'].includes(receipt.status))
    throw new Error('交易回执不匹配。');
  const block = await provider.request({ method: 'eth_getBlockByNumber', params: [receipt.blockNumber, false] });
  if (!same(block?.hash, receipt.blockHash)) return { status: 'pending' };
  return { status: receipt.status === '0x1' ? 'confirmed' : 'failed', blockNumber: receipt.blockNumber };
}
