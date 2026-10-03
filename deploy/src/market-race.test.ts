import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BaseContract, Contract, ContractFactory, Interface, JsonRpcProvider, getAddress, parseEther, toQuantity,
  type InterfaceAbi } from 'ethers';
import { PENDING_MARKET_KEY, reconcileMarketPending, type MarketJournalStorage,
  type PendingMarketTransaction } from './market';

const require = createRequire(import.meta.url);
const solc = require('solc') as { compile(input: string): string };
const harnessSource = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
contract DelayStub { function getMinDelay() external pure returns (uint256) { return 48 hours; } }
contract FactoryStub {
    address public timelock;
    address public shareMarket;
    address public pool;
    constructor(address delay_) { timelock = delay_; }
    function register(address market_, address pool_) external { shareMarket = market_; pool = pool_; }
    function isPool(address candidate) external view returns (bool) { return candidate == pool; }
}
contract PoolStub {
    uint8 public state = 2;
    bool public shareTradingAllowed = true;
    address public treasury;
    address public market;
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public lockedShares;
    constructor(address seller, address treasury_) { balanceOf[seller] = 1; treasury = treasury_; }
    function setMarket(address market_) external { market = market_; }
    function lock(address seller, uint256 amount) external {
        require(msg.sender == market && balanceOf[seller] >= lockedShares[seller] + amount);
        lockedShares[seller] += amount;
    }
    function unlock(address seller, uint256 amount) external {
        require(msg.sender == market && lockedShares[seller] >= amount);
        lockedShares[seller] -= amount;
    }
    function transferLocked(address seller, address buyer, uint256 amount) external {
        require(msg.sender == market && lockedShares[seller] >= amount && balanceOf[seller] >= amount);
        lockedShares[seller] -= amount;
        balanceOf[seller] -= amount;
        balanceOf[buyer] += amount;
    }
}`;

type Artifact = { abi: InterfaceAbi; bytecode: string };
function harness(): Record<string, Artifact> {
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity',
    sources: { 'Harness.sol': { content: harnessSource } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  }))) as { errors?: { severity: string; formattedMessage: string }[];
    contracts: Record<string, Record<string, { abi: InterfaceAbi; evm: { bytecode: { object: string } } }>> };
  assert.deepEqual((output.errors ?? []).filter(error => error.severity === 'error'), []);
  return Object.fromEntries(Object.entries(output.contracts['Harness.sol'])
    .map(([name, value]) => [name, { abi: value.abi, bytecode: `0x${value.evm.bytecode.object}` }]));
}

test('Anvil: two wallets broadcast against the same final share; only one fill and BNB credit survive', async () => {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const anvilPath = process.platform === 'win32' ? '../node_modules/@foundry-rs/anvil-win32-amd64/bin/anvil.exe' : '../node_modules/.bin/anvil';
  const node = spawn(fileURLToPath(new URL(anvilPath, import.meta.url)),
    ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '56', '--no-mining', '--base-fee', '0', '--silent'], { stdio: 'ignore', windowsHide: true });
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, 56, { cacheTimeout: -1, staticNetwork: true });
  const mine = (count = 1) => provider.send('anvil_mine', [toQuantity(count)]);
  try {
    let accounts: string[] = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      try { accounts = (await provider.send('eth_accounts', []) as string[]).map(getAddress); break; }
      catch { await delay(100); }
    }
    assert(accounts.length >= 4);
    const [seller, buyerA, buyerB, treasury] = accounts;
    const signer = await provider.getSigner(seller);
    const compiled = harness();
    const bundle = JSON.parse(readFileSync(new URL('../public/deployment-artifacts.json', import.meta.url), 'utf8')) as {
      artifacts: Record<string, Artifact> };
    async function deploy(artifact: Artifact, ...args: unknown[]) {
      const instance = await new ContractFactory(artifact.abi, artifact.bytecode, signer).deploy(...args, { gasLimit: 8_000_000 });
      await mine(); await instance.waitForDeployment();
      return instance;
    }
    async function execute(contract: BaseContract, method: string, ...args: unknown[]) {
      const sent = await contract.getFunction(method)(...args, { gasLimit: 1_000_000 });
      await mine();
      assert.equal((await sent.wait()).status, 1);
    }
    const delayStub = await deploy(compiled.DelayStub);
    const factory = await deploy(compiled.FactoryStub, await delayStub.getAddress());
    const pool = await deploy(compiled.PoolStub, seller, treasury);
    const implementation = await deploy(bundle.artifacts.ShareMarket);
    const marketInterface = new Interface(bundle.artifacts.ShareMarket.abi);
    const init = marketInterface.encodeFunctionData('initialize', [await factory.getAddress(), await delayStub.getAddress()]);
    const proxy = await deploy(bundle.artifacts.ERC1967Proxy, await implementation.getAddress(), init);
    const market = new Contract(await proxy.getAddress(), bundle.artifacts.ShareMarket.abi, signer);
    await execute(factory, 'register', await market.getAddress(), await pool.getAddress());
    await execute(pool, 'setMarket', await market.getAddress());

    const price = parseEther('1');
    await execute(market, 'list', await pool.getAddress(), 1n, price);
    assert.equal((await market.getFunction('orders')(1n)).remaining, 1n);
    const data = marketInterface.encodeFunctionData('fill', [1n, 1n]);
    const buyerFee = price / 100n, payment = price + buyerFee;
    const balancesBefore = [await provider.getBalance(buyerA), await provider.getBalance(buyerB)];
    const sendFill = (buyer: string) => provider.send('eth_sendTransaction', [{ from: buyer,
      to: market.target, data, value: toQuantity(payment), gas: toQuantity(1_000_000), gasPrice: toQuantity(1_000_000_000) }]) as Promise<string>;
    const [hashA, hashB] = await Promise.all([sendFill(buyerA), sendFill(buyerB)]);
    assert.notEqual(hashA, hashB);
    assert.equal(await provider.getTransactionReceipt(hashA), null);
    assert.equal(await provider.getTransactionReceipt(hashB), null);
    await mine();
    const receiptA = await provider.getTransactionReceipt(hashA);
    const receiptB = await provider.getTransactionReceipt(hashB);
    assert(receiptA && receiptB);
    const receipts = [receiptA, receiptB];
    assert.deepEqual(receipts.map(receipt => receipt.status).sort(), [0, 1]);
    assert.equal(receiptA.blockNumber, receiptB.blockNumber, 'both broadcasts are mined in one block');
    const winner = receipts[0].status === 1 ? buyerA : buyerB;
    const loser = receipts[0].status === 0 ? buyerA : buyerB;
    const loserIndex = receipts[0].status === 0 ? 0 : 1;
    assert(receipts[loserIndex].fee > 0n, 'the losing reverted transaction still consumes gas');
    assert.equal(balancesBefore[loserIndex] - await provider.getBalance(loser), receipts[loserIndex].fee,
      'a revert burns gas but does not transfer the losing buyer\'s purchase principal');
    const order = await market.getFunction('orders')(1n);
    assert.equal(order.remaining, 0n); assert.equal(order.active, false);
    assert.equal(await pool.getFunction('balanceOf')(winner), 1n);
    assert.equal(await pool.getFunction('balanceOf')(loser), 0n);
    assert.equal(await pool.getFunction('lockedShares')(seller), 0n);
    const fee = price / 100n;
    assert.equal(await market.getFunction('bnbOwed')(seller), price - fee);
    assert.equal(await market.getFunction('bnbOwed')(treasury), fee + buyerFee);
    assert.equal(await market.getFunction('totalBnbOwed')(), payment);
    assert.equal(await provider.getBalance(market.target as string), payment);
    const filled = receipts.flatMap(receipt => receipt.logs.map(log => {
      try { return marketInterface.parseLog(log); } catch { return null; }
    })).filter(log => log?.name === 'OrderFilled');
    assert.equal(filled.length, 1, 'a reverted contender cannot emit a second fill');
    const buyerFeeEvents = receipts.flatMap(receipt => receipt.logs.map(log => {
      try { return marketInterface.parseLog(log); } catch { return null; }
    })).filter(log => log?.name === 'BuyerFeeCharged');
    assert.equal(buyerFeeEvents.length, 1, 'only the winning fill charges a buyer fee');

    await mine(66);
    const states = await Promise.all([buyerA, buyerB].map(async (buyer, index) => {
      const hash = index === 0 ? hashA : hashB;
      const transaction = await provider.getTransaction(hash);
      assert(transaction);
      const pending: PendingMarketTransaction = { version: 1, chainId: 56, account: buyer,
        factory: await factory.getAddress(), market: await market.getAddress(), nonce: transaction.nonce,
        action: { kind: 'fill', orderId: '1', amount: '1', expectedPrice: price.toString() }, data,
        value: payment.toString(), hash, submittedAt: '2026-09-27T00:00:00.000Z' };
      let saved: string | null = JSON.stringify(pending);
      const storage: MarketJournalStorage = { getItem: async key => key === PENDING_MARKET_KEY ? saved : null,
        setItem: async (_key, value) => { saved = value; }, removeItem: async (_key, finalHash) => {
          assert.equal(finalHash, hash); saved = null;
        } };
      const result = await reconcileMarketPending(provider, pending, storage);
      assert.equal(saved, null);
      return result.resolution;
    }));
    assert.deepEqual(states, winner === buyerA ? ['confirmed', 'reverted'] : ['reverted', 'confirmed']);
  } finally { provider.destroy(); node.kill('SIGTERM'); }
});
