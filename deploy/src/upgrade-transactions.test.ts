import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256, type Provider } from 'ethers';
import { sendUpgradeTransaction, UncertainUpgradeSubmission, verifyUpgradeReceipt } from './upgrade-transactions';
import type { WalletProvider } from './wallet';

const signer = '0x1111111111111111111111111111111111111111';
const target = '0x2222222222222222222222222222222222222222';
const data = '0x12345678';
const hash = `0x${'a'.repeat(64)}`;
const blockHash = `0x${'b'.repeat(64)}`;

test('wallet submission uses exact zero-value calldata without simulation', async () => {
  const methods: string[] = [];
  const wallet = {request: async ({method, params}: {method: string; params?: unknown[]}) => {
    methods.push(method);
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_accounts') return [signer];
    assert.deepEqual(params, [{from:signer,to:target,data,value:'0x0'}]);
    return hash;
  }} as WalletProvider;
  assert.equal(await sendUpgradeTransaction(wallet,{from:signer,to:target,data}),hash);
  assert.deepEqual(methods,['eth_chainId','eth_accounts','eth_sendTransaction']);
});

test('ambiguous wallet result stays blocked, while an explicit user rejection is retryable', async () => {
  const wallet = {request: async ({method}: {method: string}) => {
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_accounts') return [signer];
    throw new Error('transport timeout');
  }} as WalletProvider;
  await assert.rejects(sendUpgradeTransaction(wallet,{from:signer,data}),UncertainUpgradeSubmission);
  const rejected = {request: async ({method}: {method: string}) => {
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_accounts') return [signer];
    throw Object.assign(new Error('user rejected'),{code:4001});
  }} as WalletProvider;
  await assert.rejects(sendUpgradeTransaction(rejected,{from:signer,data}),/user rejected/);
});

function receiptProvider(overrides: {txData?: string; receiptBlock?: number; canonical?: boolean; status?: number} = {}) {
  return {
    getTransaction: async () => ({hash,chainId:56n,from:signer,to:target,value:0n,data:overrides.txData ?? data,
      blockNumber:overrides.receiptBlock ?? 90,blockHash}),
    getTransactionReceipt: async () => ({hash,blockNumber:overrides.receiptBlock ?? 90,blockHash,status:overrides.status ?? 1}),
    getBlock: async (which: number | string) => which === 'finalized' ? {number:100}
      : {hash:overrides.canonical === false ? `0x${'c'.repeat(64)}` : blockHash},
  } as unknown as Provider;
}

test('recovery accepts only the finalized exact transaction on the canonical chain', async () => {
  const expected = {from:signer,to:target,dataHash:keccak256(data)};
  assert.ok(await verifyUpgradeReceipt(receiptProvider(),hash,expected));
  assert.equal(await verifyUpgradeReceipt(receiptProvider({receiptBlock:101}),hash,expected),null);
  await assert.rejects(verifyUpgradeReceipt(receiptProvider({txData:'0x12345679'}),hash,expected),/calldata/);
  await assert.rejects(verifyUpgradeReceipt(receiptProvider({canonical:false}),hash,expected),/规范链/);
  await assert.rejects(verifyUpgradeReceipt(receiptProvider({status:0}),hash,expected),/执行失败/);
});
