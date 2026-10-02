import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Interface } from 'ethers';
import { confirmUpgradeTransaction, scheduleUpgradeTransaction, submitUpgradeTransaction, upgradeBatch, upgradeDeployment, validateSaleUpgradeCatalog } from '../lib/sale-policy-upgrade.mjs';
const address = n => '0x' + n.toString(16).padStart(40, '0');
const hash = '0x' + 'ab'.repeat(32);
const catalog = { schemaVersion: 1, kind: 'fresh-sale-policy-upgrade-v1', chainId: 56, profile: 'full-test',
  genesisArtifactDigest: hash, candidateArtifactDigest: '0x' + 'cd'.repeat(32),
  bindings: Object.fromEntries(['factory','portfolioFactory','beacon','portfolioBeacon','shareMarket','timelock','authority','gasWallet','proposer'].map((name, i) => [name, address(i + 1)])),
  expectedImplementations: { PoolVault: address(20), BudgetPortfolioVault: address(21), ShareMarket: address(22) },
  libraries: {}, artifacts: Object.fromEntries(['SaleGovernance','PoolVault','BudgetPortfolioVault','ShareMarket'].map(name => [name, { abi: [], bytecode: '0x00' }])) };
test('an upgrade catalog from the other website is rejected before requesting signatures', () => {
  assert.equal(validateSaleUpgradeCatalog(catalog, {profile:'full-test'}), catalog);
  assert.throws(() => validateSaleUpgradeCatalog(catalog, {profile:'formal'}), /当前网站/);
});
test('one batch upgrades both vaults and the core market, without changing authority roles', () => {
  const deployed = { SaleGovernance: address(30), PoolVault: address(31), BudgetPortfolioVault: address(32), ShareMarket: address(33) };
  const batch = upgradeBatch(catalog, deployed);
  assert.deepEqual(batch.targets, [catalog.bindings.beacon, catalog.bindings.portfolioBeacon, catalog.bindings.shareMarket]);
  assert.deepEqual(batch.values, [0n,0n,0n]);
  assert.equal(new Interface(['function upgradeTo(address)']).decodeFunctionData('upgradeTo', batch.payloads[0])[0].toLowerCase(), deployed.PoolVault);
  const decoded = new Interface(['function upgradeToAndCall(address,bytes)']).decodeFunctionData('upgradeToAndCall', batch.payloads[2]);
  assert.equal(decoded[1], '0x');
  assert.match(batch.operationId, /^0x[\da-f]{64}$/);
  assert.equal(upgradeDeployment(catalog, 'PoolVault', deployed).slice(-40), catalog.bindings.factory.slice(2));
});
test('a wallet rejection is retryable, while an ambiguous send is retained', async () => {
  for (const [problem, expected] of [[{code:4001},'rejected'], [{info:{error:{code:'ACTION_REJECTED'}}},'rejected'], [new Error('transport unavailable'),'unknown']]) {
    const saved=[];
    const provider={async request({method}) { if(method==='eth_chainId')return '0x38'; if(method==='eth_accounts')return [address(9)]; throw problem; }};
    await assert.rejects(submitUpgradeTransaction(provider, address(9), {data:'0x00'}, value => saved.push({...value})));
    assert.equal(saved.at(-1).status, expected); assert.equal(saved.at(-1).hash, null);
  }
});
test('receipt recovery queries the existing hash and never sends another transaction', async () => {
  let calls=0, time=0; const methods=[];
  const provider={async request({method}) { methods.push(method); if(method==='eth_getTransactionReceipt')return ++calls===1?null:{status:'0x1',contractAddress:address(40)};
    return {from:address(9),to:null,input:'0x00',value:'0x0',chainId:'0x38'}; }};
  const result = await confirmUpgradeTransaction(provider,{hash},{from:address(9),data:'0x00'},{now:()=>time,pause:async ms=>{time+=ms;}});
  assert.equal(result.contractAddress,address(40)); assert.equal(methods.includes('eth_sendTransaction'),false);
});
test('a receipt for different calldata cannot mark a deployment complete', async () => {
  const provider={async request({method}){return method==='eth_getTransactionReceipt'?{status:'0x1',contractAddress:address(40)}:{from:address(9),to:null,input:'0xff',value:'0x0',chainId:'0x38'};}};
  await assert.rejects(confirmUpgradeTransaction(provider,{hash},{from:address(9),data:'0x00'}), /升级不一致/);
});

test('a successful send remains saved when the account changes while the wallet is open', async () => {
  let active=true;const saved=[];
  const provider={async request({method}) {
    if(method==='eth_chainId')return '0x38';if(method==='eth_accounts')return [address(9)];
    active=false;return hash;
  }};
  const step=await submitUpgradeTransaction(provider,address(9),{data:'0x00'},value=>saved.push({...value}),{current:()=>active});
  assert.equal(step.hash,hash);assert.equal(saved.at(-1).status,'submitted');
  await assert.rejects(confirmUpgradeTransaction(provider,step,{from:address(9),data:'0x00'},{current:()=>active}),/钱包或页面/);
});

test('a confirmed failure is distinctly retryable only after its exact transaction is verified', async () => {
  const provider={async request({method}) {return method==='eth_getTransactionReceipt'?{status:'0x0'}
    :{from:address(9),to:null,input:'0x00',value:'0x0',chainId:'0x38'};}};
  await assert.rejects(confirmUpgradeTransaction(provider,{hash},{from:address(9),data:'0x00'}),error=>
    error.confirmedFailure===true&&error.hash===hash);
  await assert.rejects(confirmUpgradeTransaction(provider,{hash},{from:address(9),data:'0xff'}),error=>
    error.confirmedFailure!==true&&/升级不一致/.test(error.message));
});

test('a chain switch during receipt lookup cannot return a successful confirmation', async () => {
  let current=true;
  const provider={async request({method}) {
    if(method==='eth_getTransactionReceipt')return {status:'0x1',contractAddress:address(40)};
    current=false;return {from:address(9),to:null,input:'0x00',value:'0x0',chainId:'0x38'};
  }};
  await assert.rejects(confirmUpgradeTransaction(provider,{hash},{from:address(9),data:'0x00'},{current:()=>current}),/钱包或页面/);
});

const actual = JSON.parse(await readFile(new URL('./fixtures/sale-upgrade-wrapped-schedule.json', import.meta.url), 'utf8'));
const runtimeProof = JSON.parse(await readFile(new URL('../../deploy/fixtures/fresh-activation-envelope.json', import.meta.url), 'utf8')).runtimeProof;
const actualCatalog = { bindings: {
  factory: '0x7F0681ed1035584b1B3e4f3D43f3c9ddfA4c1f2c', beacon: '0x4f9dd052df9793fac3bc5bB24587f2F8023C37AB',
  portfolioBeacon: '0x89B3833A5C0d5dbFa3419A762Ad95C7280E019EF', shareMarket: '0x8003B8A6e774849C1686C94f1BAccC44b0A1a400',
  timelock: '0x9021E33Db265CE4253E7f9e79741BB94f119C4A0' },
  candidateArtifactDigest: '0xf162aa46f2edc02b7ae0e6ae13eec32cf0c5a6eb377625eb699f7143666179d7' };
const actualBatch = upgradeBatch(actualCatalog, { SaleGovernance: address(30),
  PoolVault: '0x9a1f8d0e6110ed660b190d7359ff9fa4cd19cd4b', BudgetPortfolioVault: '0x83f09a8a06f817f28bb9645847c82a957b92d6b0',
  ShareMarket: '0xced7202db8aebfdae17a9474faee18525b13578e' });
const actualExpected = { from: actual.tx.from, ...scheduleUpgradeTransaction(actualCatalog, actualBatch, 0n),
  batchProof: { kind: 'schedule', batch: actualBatch, delay: 0n } };
const actualProvider = (tx, receipt) => ({ async request({ method }) {
  if (method === 'eth_getTransactionReceipt') return receipt;
  if (method === 'eth_getTransactionByHash') return tx;
  throw new Error('Unexpected method ' + method);
} });

test('the actual mainnet MetaMask schedule wrapper confirms the fixed batch from its complete Timelock receipt', async () => {
  assert.equal(actualBatch.operationId, '0xff99459a6a2c9495a6068b272f34efe9f73d8f06ea94517008f62bf294c86358');
  assert.notEqual(actual.tx.to.toLowerCase(), actualExpected.to.toLowerCase());
  const receipt = await confirmUpgradeTransaction(actualProvider(actual.tx, actual.receipt), { hash: actual.tx.hash }, actualExpected, { runtimeProof });
  assert.equal(receipt.transactionHash, actual.tx.hash);
});

for (const [name, alter] of [
  ['wrong wrapper runtime', (tx, receipt, proof) => { proof.managerCode += '00'; }],
  ['another operation', (tx, receipt) => { receipt.logs.find(log => log.address.toLowerCase() === actualExpected.to.toLowerCase()).topics[1] = hash; }],
  ['missing batch index', (tx, receipt) => { receipt.logs = receipt.logs.filter(log => log.topics?.[2] !== '0x' + '0'.repeat(63) + '1'); }],
  ['duplicate index', (tx, receipt) => { const logs = receipt.logs.filter(log => log.address.toLowerCase() === actualExpected.to.toLowerCase()); logs[1].topics[2] = logs[0].topics[2]; }],
  ['wrong Timelock', (tx, receipt) => { receipt.logs.forEach(log => { log.address = address(77); }); }],
  ['wrong event payload', (tx, receipt) => { const log = receipt.logs.find(log => log.address.toLowerCase() === actualExpected.to.toLowerCase()); log.data = log.data.slice(0, -2) + '01'; }],
  ['wrong salt', (tx, receipt) => { const logs = receipt.logs.filter(log => log.address.toLowerCase() === actualExpected.to.toLowerCase()); logs.at(-1).data = hash; }],
  ['another receipt transaction', (tx, receipt) => { receipt.transactionHash = hash; }],
  ['nonzero outer payment', tx => { tx.value = '0x1'; }],
  ['wrong account', tx => { tx.from = address(77); }],
  ['wrong chain', tx => { tx.chainId = '0x1'; }],
  ['unapproved wrapper', tx => { tx.to = address(77); }],
]) test('the schedule wrapper rejects ' + name, async () => {
  const tx = structuredClone(actual.tx), receipt = structuredClone(actual.receipt), proof = structuredClone(runtimeProof);
  alter(tx, receipt, proof);
  await assert.rejects(confirmUpgradeTransaction(actualProvider(tx, receipt), { hash: actual.tx.hash }, actualExpected, { runtimeProof: proof }));
});
