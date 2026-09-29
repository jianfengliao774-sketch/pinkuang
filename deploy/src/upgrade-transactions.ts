import { getAddress, isHexString, keccak256, type Provider, type TransactionReceipt } from 'ethers';
import type { WalletProvider } from './wallet';

const same = (left: string, right: string) => getAddress(left) === getAddress(right);

export class UncertainUpgradeSubmission extends Error {}

export async function sendUpgradeTransaction(
  wallet: WalletProvider,
  transaction: { from: string; to?: string; data: string },
): Promise<string> {
  if (!isHexString(transaction.data) || transaction.data.length < 4) throw new Error('交易数据不是完整十六进制字节码。');
  const [chainId, accounts] = await Promise.all([
    wallet.request({ method: 'eth_chainId' }),
    wallet.request({ method: 'eth_accounts' }),
  ]);
  if (Number(chainId) !== 56 || !Array.isArray(accounts) || typeof accounts[0] !== 'string'
    || !same(accounts[0], transaction.from)) throw new Error('钱包账户或网络已变化，请重新连接。');
  let result: unknown;
  try {
    result = await wallet.request({ method: 'eth_sendTransaction', params: [{
      from: getAddress(transaction.from),
      ...(transaction.to ? { to: getAddress(transaction.to) } : {}),
      data: transaction.data,
      value: '0x0',
    }] });
  } catch (error) {
    if ((error as { code?: number | string })?.code === 4001
      || (error as { code?: number | string })?.code === 'ACTION_REJECTED') throw error;
    throw new UncertainUpgradeSubmission('钱包发送结果未确定。先核对钱包交易记录并输入原交易哈希；禁止再次发送。');
  }
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result)) {
    throw new UncertainUpgradeSubmission('钱包未返回有效交易哈希。先核对钱包交易记录；禁止再次发送。');
  }
  return result;
}

export async function verifyUpgradeReceipt(
  provider: Provider,
  hash: string,
  expected: { from: string; to?: string; dataHash: string },
): Promise<TransactionReceipt | null> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('交易哈希格式不正确。');
  const tx = await provider.getTransaction(hash);
  if (!tx) return null;
  if (tx.hash.toLowerCase() !== hash.toLowerCase() || tx.chainId !== 56n
    || !same(tx.from, expected.from) || (tx.to === null) !== !expected.to
    || (expected.to && (!tx.to || !same(tx.to, expected.to)))
    || tx.value !== 0n || keccak256(tx.data).toLowerCase() !== expected.dataHash.toLowerCase()) {
    throw new Error('该交易的发送者、目标、金额或 calldata 与已核验升级步骤不一致。');
  }
  const receipt = await provider.getTransactionReceipt(hash);
  if (!receipt) return null;
  if (receipt.hash.toLowerCase() !== hash.toLowerCase() || tx.blockNumber !== receipt.blockNumber
    || !tx.blockHash || tx.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    throw new Error('交易与回执不属于同一笔规范链交易。');
  }
  const finalized = await provider.getBlock('finalized');
  if (!finalized || receipt.blockNumber > finalized.number) return null;
  const block = await provider.getBlock(receipt.blockNumber);
  if (!block || !block.hash || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    throw new Error('交易回执不在当前规范链上，等待重新核对。');
  }
  if (receipt.status !== 1) throw new Error('该交易在链上执行失败，不能标记升级步骤完成。');
  if (!expected.to && !receipt.contractAddress) throw new Error('部署交易成功但没有合约地址。');
  return receipt;
}
