import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, ContractFactory, JsonRpcProvider, ZeroAddress, ZeroHash, keccak256, parseEther, toUtf8Bytes } from '../../deploy/node_modules/ethers/lib.esm/index.js';
import solc from '../../deploy/node_modules/solc/index.js';
import { artifactContentDigest, compilerSettings, libraryNames, linkedDeploymentOrder, repositoryRoot } from '../../deploy/scripts/build-artifacts.mjs';
const outputDirectory = join(repositoryRoot, 'deploy/public/formal-v5');
const outputPath = join(repositoryRoot, 'deploy/public/deployment-artifacts.json');
import { authorityTypedAction } from '../../deploy/shared/authority-typed.mjs';

const WAIT = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const PROTOCOL = Object.freeze({
  nft: '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C',
  mining: '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46',
  market: '0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f',
  bem: '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a',
  firsto: '0x33423244F9a5bF81b12B1a018aF6F4e079B97f29',
  firstoFactory: '0x68224F668083c29e9800Be2a646d42d18cedF7e2',
});

export function linkBytecode(template, references, addresses) {
  let code = template.slice(2);
  for (const libraries of Object.values(references ?? {})) for (const [name, slots] of Object.entries(libraries)) {
    assert(/^0x[0-9a-fA-F]{40}$/.test(addresses[name]), `Missing linked library ${name}`);
    for (const slot of slots) {
      assert.equal(slot.length, 20);
      code = code.slice(0, slot.start * 2) + addresses[name].slice(2).toLowerCase() + code.slice((slot.start + 20) * 2);
    }
  }
  assert.match(code, /^[0-9a-fA-F]+$/);
  return `0x${code}`;
}

export function runtimeMatches(actualCode, artifact, addresses, selfAddress) {
  let expected = linkBytecode(artifact.deployedBytecode, artifact.deployedLinkReferences, addresses).slice(2).toLowerCase();
  let actual = actualCode.slice(2).toLowerCase();
  if (actual.length !== expected.length) return false;
  if (selfAddress && expected.startsWith(`73${'0'.repeat(40)}`)) {
    expected = expected.slice(0, 2) + selfAddress.slice(2).toLowerCase() + expected.slice(42);
  }
  for (const slots of Object.values(artifact.immutableReferences ?? {})) for (const { start, length } of slots) {
    expected = expected.slice(0, start * 2) + '0'.repeat(length * 2) + expected.slice((start + length) * 2);
    actual = actual.slice(0, start * 2) + '0'.repeat(length * 2) + actual.slice((start + length) * 2);
  }
  return expected === actual;
}

async function availablePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function compileLocalFixtures() {
  const sources = Object.fromEntries(['test/utils/PurchaseMocks.sol', 'test/utils/FirstoMocks.sol'].map(name => [name,
    { content: readFileSync(join(repositoryRoot, 'contracts', name), 'utf8') }]));
  const result = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: compilerSettings }), {
    import(name) {
      if (name.startsWith('@openzeppelin/')) return { contents: readFileSync(join(repositoryRoot, 'node_modules', name), 'utf8') };
      if (!/^(src|script|test)\/[\w./-]+\.sol$/.test(name) || name.split('/').includes('..')) return { error: `Unsupported local fixture import ${name}` };
      return { contents: readFileSync(join(repositoryRoot, 'contracts', name), 'utf8') };
    },
  }));
  const errors = (result.errors ?? []).filter(error => error.severity === 'error');
  assert.equal(errors.length, 0, errors.map(error => error.formattedMessage).join('\n'));
  return Object.fromEntries(Object.values(result.contracts).flatMap(contracts => Object.entries(contracts)));
}

export async function checkFormalGraph() {
  const bundle = JSON.parse(readFileSync(outputPath, 'utf8'));
  mkdirSync(outputDirectory, {recursive:true});
  const artifactDigest = artifactContentDigest(bundle);
  const existingPlanPath = join(outputDirectory, 'gas-plan.json');
  const existingPlan = existsSync(existingPlanPath) ? JSON.parse(readFileSync(existingPlanPath, 'utf8')) : null;
  const plannedLimits = existingPlan?.artifactDigest === artifactDigest
    ? { ...existingPlan.gasLimits, ...existingPlan.activationGasLimits } : {};
  const port = await availablePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const child = spawn(join(repositoryRoot, `deploy/node_modules/@foundry-rs/anvil-${process.platform === 'win32' ? 'win32-amd64' : process.platform + '-' + (process.arch === 'x64' ? 'amd64' : process.arch)}/bin/anvil${process.platform === 'win32' ? '.exe' : ''}`),
    ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '56', '--hardfork', 'shanghai', '--accounts', '10', '--balance', '10000', '--gas-limit', '30000000', '--silent'],
    { windowsHide: true, stdio: 'ignore' });
  const provider = new JsonRpcProvider(endpoint, 56, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 50 });
  const steps = [], runtimeChecks = [];
  const addresses = {};
  const same = (left, right) => assert.equal(left.toLowerCase(), right.toLowerCase());
  async function record(id, transaction) {
    const receipt = await transaction.wait();
    assert.equal(receipt.status, 1, `${id} reverted`);
    if (plannedLimits[id]) assert(receipt.gasUsed <= BigInt(plannedLimits[id]), `${id} exceeds the independently pinned gas plan`);
    steps.push({ id, hash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() });
    return receipt;
  }
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      try { if (await provider.send('eth_chainId', []) === '0x38') break; } catch {}
      if (attempt === 199) throw new Error('Local Anvil did not start.');
      await WAIT(50);
    }
    // This verifier deliberately owns the localhost node; no external endpoint can be configured.
    const accounts = await provider.send('eth_accounts', []);
    const owner = await provider.getSigner(accounts[0]);
    const secondaryAdmin = accounts[1], gasAddress = accounts[2], seller = await provider.getSigner(accounts[3]);
    const buyer = await provider.getSigner(accounts[4]);
    async function deploy(name, args = []) {
      const artifact = bundle.artifacts[name];
      const factory = new ContractFactory(artifact.abi, linkBytecode(artifact.bytecode, artifact.linkReferences, addresses), owner);
      const id = name === 'PlatformAuthority' ? 'deployAuthority' : name;
      const contract = await factory.deploy(...args, { gasLimit: plannedLimits[id] ?? 15_000_000 });
      const receipt = await record(id, contract.deploymentTransaction());
      addresses[name] = receipt.contractAddress;
      const code = await provider.getCode(receipt.contractAddress);
      assert(runtimeMatches(code, artifact, addresses, libraryNames.includes(name) ? receipt.contractAddress : null), `${name} runtime mismatch`);
      runtimeChecks.push({ name, address: receipt.contractAddress, codehash: keccak256(code) });
      return contract;
    }
    for (const name of linkedDeploymentOrder(bundle.artifacts).filter(name => libraryNames.includes(name))) await deploy(name);
    const coordinator = await deploy('AtomicDeployment');
    const predictedCore = await coordinator.predictedFactory(), predictedBudget = await coordinator.predictedPortfolioFactory();
    const vaultImpl = await deploy('PoolVault', [predictedCore]);
    await deploy('FreshPoolFactory'); await deploy('ShareMarket'); await deploy('BudgetPortfolioFactory');
    const budgetVaultImpl = await deploy('BudgetPortfolioVault', [predictedBudget]);
    await record('initialize', await coordinator.deployIntegratedSingleOwner({ core: {
      ownerMultisig: accounts[0], operator: accounts[0], treasury: accounts[0],
      vaultImplementation: addresses.PoolVault, factoryImplementation: addresses.FreshPoolFactory,
      marketImplementation: addresses.ShareMarket }, portfolioFactoryImplementation: addresses.BudgetPortfolioFactory,
      portfolioVaultImplementation: addresses.BudgetPortfolioVault }, { gasLimit: plannedLimits.initialize ?? 15_000_000 }));
    assert.equal(steps.length, 16);
    const core = await coordinator.deployment(), budget = await coordinator.portfolioDeployment();
    const factory = new Contract(core.factory, bundle.artifacts.FreshPoolFactory.abi, owner);
    const budgetFactory = new Contract(budget.factory, bundle.artifacts.BudgetPortfolioFactory.abi, owner);
    const market = new Contract(core.shareMarket, bundle.artifacts.ShareMarket.abi, owner);
    const budgetMarket = new Contract(budget.shareMarket, bundle.artifacts.ShareMarket.abi, owner);
    const timelock = new Contract(core.timelock, bundle.artifacts.PoolTimelock.abi, owner);
    const beacon = new Contract(core.beacon, bundle.artifacts.PoolBeacon.abi, owner);
    const budgetBeacon = new Contract(budget.beacon, bundle.artifacts.PoolBeacon.abi, owner);
    same(core.factory, predictedCore); same(budget.factory, predictedBudget);
    same(await vaultImpl.OFFICIAL_FACTORY(), core.factory); same(await budgetVaultImpl.OFFICIAL_FACTORY(), budget.factory);
    assert.equal(await vaultImpl.voteDuration(), 86400n);
    for (const [contract, expected] of [[factory, core], [budgetFactory, budget]]) {
      for (const getter of ['owner', 'operator', 'treasury']) same(await contract[getter](), accounts[0]);
      same(await contract.shareMarket(), expected.shareMarket); same(await contract.beacon(), expected.beacon);
      same(await contract.timelock(), core.timelock);
      assert.equal(await contract.MINIMUM_UPGRADE_DELAY(), 172800n);
    }
    same(await market.factory(), core.factory); same(await budgetMarket.factory(), budget.factory);
    same(await market.timelock(), core.timelock); same(await budgetMarket.timelock(), core.timelock);
    same(await beacon.owner(), core.timelock); same(await budgetBeacon.owner(), core.timelock);
    same(await beacon.implementation(), addresses.PoolVault); same(await budgetBeacon.implementation(), addresses.BudgetPortfolioVault);
    same(await budgetFactory.legacyFactory(), core.factory); assert(await market.budgetFactoryTrusted(budget.factory));
    assert.equal(await timelock.getMinDelay(), 172800n); assert.equal(await timelock.MINIMUM_DELAY(), 172800n);
    for (const role of ['PROPOSER_ROLE', 'CANCELLER_ROLE']) assert(await timelock.hasRole(await timelock[role](), accounts[0]));
    assert(await timelock.hasRole(await timelock.EXECUTOR_ROLE(), ZeroAddress));
    assert(await timelock.hasRole(await timelock.DEFAULT_ADMIN_ROLE(), core.timelock));
    assert(!await timelock.hasRole(await timelock.DEFAULT_ADMIN_ROLE(), accounts[0]));
    for (const [name, address] of [['PoolTimelock', core.timelock], ['PoolBeacon', core.beacon], ['PoolBeacon', budget.beacon],
      ['ERC1967Proxy', core.factory], ['ERC1967Proxy', budget.factory], ['ERC1967Proxy', core.shareMarket], ['ERC1967Proxy', budget.shareMarket], ['PoolLens', await factory.lens()]]) {
      const code = await provider.getCode(address);
      assert(runtimeMatches(code, bundle.artifacts[name], addresses, null), `${name} child runtime mismatch`);
      runtimeChecks.push({ name, address, codehash: keccak256(code) });
    }

    const authority = await deploy('PlatformAuthority', [core.factory, budget.factory, accounts[0], secondaryAdmin, gasAddress]);
    for (const [id, target, method, destination] of [['coreOperator', factory, 'setOperator', addresses.PlatformAuthority],
      ['coreTreasury', factory, 'setTreasury', addresses.PlatformAuthority], ['budgetOperator', budgetFactory, 'setOperator', addresses.PlatformAuthority],
      ['budgetTreasury', budgetFactory, 'setTreasury', addresses.PlatformAuthority], ['coreOwner', factory, 'transferOwnership', core.timelock],
      ['budgetOwner', budgetFactory, 'transferOwnership', core.timelock]]) await record(id, await target[method](destination, {
        gasLimit: plannedLimits[id] ?? 150_000 }));
    assert.equal(steps.length, 23);
    for (const contract of [factory, budgetFactory]) {
      same(await contract.owner(), core.timelock); same(await contract.operator(), addresses.PlatformAuthority); same(await contract.treasury(), addresses.PlatformAuthority);
    }
    same(await authority.owner(), core.timelock); same(await authority.administratorOne(), accounts[0]);
    same(await authority.administratorTwo(), secondaryAdmin); same(await authority.gasWallet(), gasAddress);
    const gasSigner = await provider.getSigner(gasAddress);
    async function signAction(kind, args) {
      const nonce = await authority.nonces(accounts[0]);
      const deadline = (await provider.getBlock('latest')).timestamp + 600;
      const typed = authorityTypedAction(addresses.PlatformAuthority, kind, args, nonce, deadline);
      return { signature: await owner.signTypedData(typed.domain, typed.types, typed.message), nonce, deadline };
    }

    // Fixture runtimes are installed only on this disposable localhost chain.
    // Test artifacts retain every real protocol address; this is not a mainnet/fork claim.
    const fixtures = compileLocalFixtures();
    for (const [name, address] of [['PurchaseMockNft', PROTOCOL.nft], ['PurchaseMockBem', PROTOCOL.bem],
      ['PurchaseMockMining', PROTOCOL.mining], ['PurchaseMockMarket', PROTOCOL.market], ['FirstoSignedAskMock', PROTOCOL.firsto]]) {
      await provider.send('anvil_setCode', [address, `0x${fixtures[name].evm.deployedBytecode.object}`]);
    }
    const nft = new Contract(PROTOCOL.nft, fixtures.PurchaseMockNft.abi, seller);
    const mining = new Contract(PROTOCOL.mining, fixtures.PurchaseMockMining.abi, owner);
    const protocolMarket = new Contract(PROTOCOL.market, fixtures.PurchaseMockMarket.abi, seller);
    const firsto = new Contract(PROTOCOL.firsto, fixtures.FirstoSignedAskMock.abi, owner);
    await (await nft.mint(accounts[3], 1)).wait(); await (await nft.approve(PROTOCOL.market, 1)).wait();
    await (await mining.configure(PROTOCOL.nft, 1, 0, 0)).wait();
    await (await protocolMarket.createListing(accounts[3], PROTOCOL.nft, 1, parseEther('0.00001'))).wait();
    await (await firsto.configure(PROTOCOL.firstoFactory, 100, 1)).wait();
    const now = (await provider.getBlock('latest')).timestamp;
    const createPoolData = factory.interface.encodeFunctionData('createPool', [{ circuits: PROTOCOL.nft, circuitId: 1,
      targetRaise: parseEther('0.00001'), priceCap: parseEther('0.00001'), directSeller: ZeroAddress,
      directPrice: 0, fundingDeadline: now + 3600, purchaseDeadline: now + 7200 }]);
    const creation = await signAction('executeApprovedOperation', { target: core.factory, data: createPoolData });
    const poolCreation = await (await authority.connect(gasSigner).executeApprovedOperation(core.factory,
      createPoolData, creation.nonce, creation.deadline, creation.signature)).wait();
    const createdEvent = poolCreation.logs.map(log => { try { return factory.interface.parseLog(log); } catch { return null; } }).find(log => log?.name === 'PoolCreated');
    assert(createdEvent, 'Missing pool creation event');
    const poolAddress = createdEvent.args.pool;
    const pool = new Contract(poolAddress, bundle.artifacts.PoolVault.abi, owner);
    await (await pool.deposit(100, { value: parseEther('0.00001') })).wait();
    await (await pool.buyFromMarket(1)).wait();
    assert.equal(await pool.state(), 2n); same(await nft.ownerOf(1), poolAddress);
    const activatedAt = await pool.activatedAt();
    await provider.send('evm_setNextBlockTimestamp', [Number(activatedAt) + 259199]);
    await provider.send('evm_mine', []);
    await assert.rejects(pool.propose.staticCall(parseEther('0.00001'), 0, 0), 'Proposal must wait three full days');
    await provider.send('evm_setNextBlockTimestamp', [Number(activatedAt) + 259200]);
    const proposedReceipt = await (await pool.propose(parseEther('0.00001'), 0, 0, {gasLimit:1000000})).wait();
    const proposedEvent = proposedReceipt.logs.map(log => { try { return pool.interface.parseLog(log); } catch { return null; } }).find(log => log?.name === 'Proposed');
    const proposalId = proposedEvent?.args.proposalId ?? 1n;
    const proposal = await pool.getProposal(proposalId);
    assert.equal(proposal.endsAt - proposal.snapshotTs, 86400n);
    assert.equal(proposal.snapshotTs - activatedAt, 259200n, 'Proposal opens at exactly three days');
    await (await pool.vote(proposalId, true)).wait(); assert(await pool.proposalPassed(proposalId));

    const domain = { name: 'BEMine Platform Authority', version: '1', chainId: 56, verifyingContract: addresses.PlatformAuthority };
    const refNow = (await provider.getBlock('latest')).timestamp;
    const refData = { market: core.shareMarket, pool: poolAddress, priceWei: parseEther('0.00002'), observedAt: refNow,
      digest: keccak256(toUtf8Bytes('local-only-reference')), nonce: await authority.nonces(accounts[0]), deadline: refNow + 600 };
    const referenceSignature = await owner.signTypedData(domain, { SaleReference: [
      { name: 'market', type: 'address' }, { name: 'pool', type: 'address' }, { name: 'priceWei', type: 'uint128' },
      { name: 'observedAt', type: 'uint64' }, { name: 'digest', type: 'bytes32' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }, refData);
    await (await authority.connect(gasSigner).setSaleReference(...Object.values(refData), referenceSignature)).wait();
    await assert.rejects(pool.executeSale(proposalId), 'Discounted sale must require signed review');
    const reviewData = { market: core.shareMarket, pool: poolAddress, proposalId, priceWei: parseEther('0.00001'), approved: true,
      nonce: await authority.nonces(accounts[0]), deadline: refNow + 600 };
    const reviewSignature = await owner.signTypedData(domain, { ReviewSale: [
      { name: 'market', type: 'address' }, { name: 'pool', type: 'address' }, { name: 'proposalId', type: 'uint256' },
      { name: 'priceWei', type: 'uint128' }, { name: 'approved', type: 'bool' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }, reviewData);
    await (await authority.connect(gasSigner).reviewSale(...Object.values(reviewData), reviewSignature)).wait();
    await (await pool.executeSale(proposalId)).wait(); assert.equal(await pool.state(), 3n);
    assert.equal(await pool.expiresAt() - await pool.listedAt(), 604800n);
    const salePrice = parseEther('0.00001');
    await (await pool.connect(buyer).completeFirstoSale(proposalId, salePrice, 100, 1, { value: salePrice + salePrice / 100n })).wait();
    assert.equal(await pool.state(), 4n); same(await nft.ownerOf(1), accounts[4]);
    assert.equal(await pool.bnbOwed(accounts[0]), salePrice * 99n / 100n);
    await (await pool.withdrawBnb()).wait(); assert.equal(await pool.bnbOwed(accounts[0]), 0n);
    assert.equal(await pool.bnbOwed(addresses.PlatformAuthority), salePrice / 100n);
    const claimArgs = { markets: [], pools: [poolAddress], recipient: accounts[0] };
    const feeClaim = await signAction('claimFees', claimArgs);
    await (await authority.connect(gasSigner).claimFees([], [poolAddress], accounts[0],
      feeClaim.nonce, feeClaim.deadline, feeClaim.signature)).wait();
    assert.equal(await pool.bnbOwed(addresses.PlatformAuthority), 0n);
    assert.equal(await provider.getBalance(addresses.PlatformAuthority), 0n);

    // The formal upgrade timelock remains 48 hours; sale cooldown does not weaken it.
    const data = factory.interface.encodeFunctionData('setOperator', [addresses.PlatformAuthority]);
    const salt = keccak256(toUtf8Bytes('local-formal-v5-delay-action'));
    await (await timelock.schedule(core.factory, 0, data, ZeroHash, salt, 172800)).wait();
    await assert.rejects(timelock.execute.staticCall(core.factory, 0, data, ZeroHash, salt));
    await provider.send('evm_increaseTime', [172800]); await provider.send('evm_mine', []);
    await (await timelock.execute(core.factory, 0, data, ZeroHash, salt, {gasLimit:500000})).wait(); same(await factory.operator(), addresses.PlatformAuthority);
    await assert.rejects(timelock.connect(buyer).schedule(core.factory, 0, data, ZeroHash, ZeroHash, 0));

    const gasLimits = {}, activationGasLimits = {};
    for (const [index, step] of steps.entries()) {
      // Independent measured plan with 30% execution headroom plus 50,000, rounded up to 10,000.
      const used = BigInt(step.gasUsed);
      const conservative = ((used * 130n / 100n + 50_000n + 9_999n) / 10_000n) * 10_000n;
      (index < 16 ? gasLimits : activationGasLimits)[step.id] = conservative.toString();
    }
    const gasPlan = { schemaVersion: 1, kind: 'bemine-formal-v5-gas-plan', artifactDigest,
      chainId: 56, gasLimits, activationGasLimits,
      methodology: 'Exact independent artifact bytecode on disposable Anvil Shanghai chain 56; measured gasUsed + 30% + 50000 rounded up to 10000. Transactions transfer zero BNB.',
      bootstrapTransactionCount: 16, authorityActivationTransactionCount: 7 };
    const report = { schemaVersion: 1, kind: 'bemine-formal-v5-local-graph-evidence', artifactDigest,
      chainId: 56, endpoint: 'disposable localhost Anvil only', productionTransactions: 0,
      protocolEvidence: 'Local fault-injection fixtures at fixed protocol addresses; not live protocol or mainnet/fork evidence.',
      steps, runtimeChecks, graph: { factory: core.factory, portfolioFactory: budget.factory,
        shareMarket: core.shareMarket, portfolioMarket: budget.shareMarket, timelock: core.timelock, authority: addresses.PlatformAuthority },
      assertions: ['16 bootstrap and 7 activation receipts', 'runtime/code/library links and immutable getter bindings',
        'all final owner/operator/treasury roles', 'timelock authorization and 48h minimum delay retained',
        'proposal fails before 3 days and succeeds at exact 3-day boundary; 24h vote and 7d listing expiry retained',
        'signed low-price review required', 'Firsto route atomic settlement and NFT delivery', 'member BNB withdrawal and signed Authority fee withdrawal',
        ...(Object.keys(plannedLimits).length ? ['all 23 transactions submitted within the artifact-bound conservative gas plan'] : [])] };
    writeFileSync(join(outputDirectory, 'gas-plan.json'), `${JSON.stringify(gasPlan, null, 2)}\n`);
    writeFileSync(join(outputDirectory, 'local-graph-evidence.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`PASS: 16 bootstrap + 7 Authority activation, ${runtimeChecks.length} runtimes; three-day governance and controlled sale. Digest ${artifactDigest}`);
    console.log(`Gas plan: ${join(outputDirectory, 'gas-plan.json')}`);
    return report;
  } finally {
    provider.destroy();
    if (child.exitCode === null) child.kill();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  checkFormalGraph().catch(error => { console.error(error); process.exitCode = 1; });
}
