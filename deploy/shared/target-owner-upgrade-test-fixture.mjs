import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, ZeroAddress, getCreateAddress, keccak256, toUtf8Bytes } from 'ethers';
import { buildDigest, evidenceDigest } from './firsto-upgrade-proof.mjs';
import { reviewedUpgradeBytecode } from './integrated-upgrade-plan.mjs';
import { TARGET_OWNER_REVIEW_KIND, TARGET_OWNER_UPGRADE_KIND, targetOwnerBaselineNames, targetOwnerUpgradeDeploymentOrder,
  buildTargetOwnerUpgradePlan, prepareTargetOwnerUpgradeDeployment } from './target-owner-upgrade-plan.mjs';

const json = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const original = json('../public/upgrade-genesis/genesis-record.json'), genesisBundle = json('../public/upgrade-genesis/genesis-artifacts.json');
const originalManifest = json('../../web/public/data/frontend-manifest.json');
const hash = value => keccak256(toUtf8Bytes(value));
const dependencies = { PoolFunds: [], FlexiblePurchase: ['PoolFunds', 'PurchaseValidation'],
  PoolVault: ['FirstoSale', 'FlexiblePurchase', 'MiningOperations', 'PoolFunds', 'RewardAccounting', 'SaleGovernance', 'SaleSettlement', 'ShareCheckpoints'] };
function artifact(name) {
  let code = `0x${name === 'PoolVault' ? '6000' : `73${'0'.repeat(40)}6000`}`, refs = {};
  for (const dep of dependencies[name]) {
    const start = (code.length - 2) / 2; code += `__$${hash(dep).slice(2, 36)}$__`;
    refs[`src/libraries/${dep}.sol`] = { [dep]: [{ start, length: 20 }] };
  }
  const start = (code.length - 2) / 2;
  return { contractName: name, abi: name === 'PoolVault' ? [{ type: 'constructor', stateMutability: 'nonpayable', inputs: [{ name: 'officialFactory_', type: 'address' }] },
    { type: 'function', name: 'OFFICIAL_FACTORY', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
    { type: 'function', name: 'targetOwnerVersion', stateMutability: 'pure', inputs: [], outputs: [{ type: 'uint8' }] }] : [],
    bytecode: code + '6000', deployedBytecode: code + (name === 'PoolVault' ? '0'.repeat(64) : '') + '00',
    linkReferences: structuredClone(refs), deployedLinkReferences: refs, immutableReferences: name === 'PoolVault' ? { factory: [{ start, length: 32 }] } : {} };
}
const abi = new Interface([
  'function owner() view returns(address)', 'function timelock() view returns(address)', 'function operator() view returns(address)',
  'function treasury() view returns(address)', 'function lens() view returns(address)', 'function factory() view returns(address)',
  'function OFFICIAL_FACTORY() view returns(address)', 'function implementation() view returns(address)', 'function targetOwnerVersion() view returns(uint8)',
  'function coreFactory() view returns(address)', 'function budgetFactory() view returns(address)',
  'function administratorOne() view returns(address)', 'function administratorTwo() view returns(address)', 'function gasWallet() view returns(address)',
  'function getMinDelay() view returns(uint256)', 'function hasRole(bytes32,address) view returns(bool)',
  'function hashOperation(address,uint256,bytes,bytes32,bytes32) view returns(bytes32)',
  'function isOperation(bytes32) view returns(bool)', 'function isOperationReady(bytes32) view returns(bool)',
  'function isOperationDone(bytes32) view returns(bool)', 'function getTimestamp(bytes32) view returns(uint256)',
  'event CallScheduled(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data,bytes32 predecessor,uint256 delay)',
  'event CallExecuted(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data)',
  'event Upgraded(address indexed implementation)',
]);

/** Self-contained FakeProvider fixture; no RPC endpoints, accounts, signing or deploy operations. */
export function createTargetOwnerFixture({ phase = 'done', waiting = false, aliases = true, splitMarkets = false } = {}) {
  const record = structuredClone(original), manifest = structuredClone(originalManifest), old = record.addresses;
  const authorityCode = '0x60006001'; manifest.freshAuthority.codehash = keccak256(authorityCode);
  const candidate = { schemaVersion: 1, artifacts: Object.fromEntries(targetOwnerUpgradeDeploymentOrder.map(name => [name, artifact(name)])) };
  const a = { ...old };
  if (splitMarkets) { a.PortfolioShareMarketImplementation = old.ShareMarket; a.ShareMarket = `0x${(0x995510).toString(16).padStart(40, '0')}`; }
  if (aliases) for (const [index, name] of ['PoolVault', 'FirstoSale', 'SaleGovernance', 'SaleSettlement'].entries()) a[name] = `0x${(0x995500 + index).toString(16).padStart(40, '0')}`;
  const catalog = { schemaVersion: 1, kind: TARGET_OWNER_REVIEW_KIND, chainId: 56, profile: 'full-test',
    genesisRecordDigest: evidenceDigest(record), genesisManifestDigest: evidenceDigest(manifest), genesisArtifactDigest: buildDigest(genesisBundle),
    candidateArtifactDigest: buildDigest(candidate), anchor: { blockNumber: 300, blockHash: hash('block300') },
    deployer: record.input.ownerMultisig, bindings: Object.fromEntries(['factory', 'portfolioFactory', 'beacon', 'portfolioBeacon', 'timelock', 'lens', 'shareMarket', 'portfolioShareMarket'].map(name => [name, old[name]])),
    authority: structuredClone(manifest.freshAuthority), nodes: {} };
  catalog.bindings.proposer = record.input.ownerMultisig;
  catalog.implementations = { factory: 'FreshPoolFactory', portfolioFactory: 'BudgetPortfolioFactory', shareMarket: 'ShareMarket',
    portfolioShareMarket: splitMarkets ? 'PortfolioShareMarketImplementation' : 'ShareMarket', beacon: 'PoolVault', portfolioBeacon: 'BudgetPortfolioVault' };
  const artifactAliases = { factory: 'ERC1967Proxy', shareMarket: 'ERC1967Proxy', portfolioFactory: 'ERC1967Proxy', portfolioShareMarket: 'ERC1967Proxy',
    lens: 'PoolLens', beacon: 'PoolBeacon', portfolioBeacon: 'PoolBeacon', timelock: 'PoolTimelock', PortfolioShareMarketImplementation: 'ShareMarket' };
  for (const name of [...targetOwnerBaselineNames, ...(splitMarkets ? ['PortfolioShareMarketImplementation'] : [])]) {
    const art = structuredClone(genesisBundle.artifacts[artifactAliases[name] ?? name]);
    const refs = Object.values(art.deployedLinkReferences ?? {}).flatMap(ref => Object.keys(ref));
    const links = Object.fromEntries(refs.map(dep => [dep, a[dep]]));
    const immutable = ({ AtomicDeployment: record.account, PoolVault: old.factory, BudgetPortfolioVault: old.portfolioFactory,
      FreshPoolFactory: a.FreshPoolFactory, ShareMarket: a.ShareMarket, BudgetPortfolioFactory: a.BudgetPortfolioFactory,
      lens: old.factory, beacon: old.factory, portfolioBeacon: old.portfolioFactory, PortfolioShareMarketImplementation: a.PortfolioShareMarketImplementation })[name] ?? null;
    const immutableAddress = Object.values(art.immutableReferences ?? {}).flat().length ? immutable : null;
    const runtime = reviewedUpgradeBytecode.expectedRuntime(art, links, a[name], immutableAddress);
    catalog.nodes[name] = { address: a[name], artifact: art, links, immutableAddress, codehash: keccak256(runtime) };
  }
  const input = { genesisRecord: record, genesisBundle, trustedGenesisManifest: manifest,
    trustedGenesisRecordDigest: evidenceDigest(record), trustedGenesisManifestDigest: evidenceDigest(manifest), upgradeBundle: candidate,
    trustedUpgradeArtifactDigest: buildDigest(candidate), reviewCatalog: catalog, trustedReviewCatalogDigest: evidenceDigest(catalog),
    salt: hash('target-owner-review'), delaySeconds: 172800 };
  const replacements = Object.fromEntries(targetOwnerUpgradeDeploymentOrder.map((name, index) => [name, getCreateAddress({ from: catalog.deployer, nonce: 20 + index })]));
  const plan = buildTargetOwnerUpgradePlan({ ...input, replacements });
  const codes = new Map(Object.entries(catalog.nodes).map(([name, row]) => [row.address.toLowerCase(),
    reviewedUpgradeBytecode.expectedRuntime(row.artifact, row.links, row.address, row.immutableAddress)]));
  codes.set(catalog.authority.address.toLowerCase(), authorityCode);
  for (const row of plan.deployments) codes.set(row.address.toLowerCase(), row.expectedRuntime);
  const blocks = new Map();
  const makeBlock = number => ({ number, hash: hash(`block${number}`), timestamp: number === 320 ? 100000 : number === 380 ? 272800
    : number === 400 ? waiting ? 200000 : 300000 : number < 320 ? 90000 : 270000, transactions: [] });
  for (const number of [300, 310, 311, 312, 320, 379, 380, 390, 400]) blocks.set(number, makeBlock(number));
  const transactions = new Map(), receipts = new Map(), deployments = {};
  function addTx(label, number, from, to, data, contractAddress = null, nonce = 0) {
    const txHash = hash(label), block = blocks.get(number);
    const tx = { hash: txHash, chainId: 56n, from, to, value: 0n, data, nonce, blockNumber: number, blockHash: block.hash, index: 0 };
    const receipt = { hash: txHash, from, to, status: 1, contractAddress, blockNumber: number, blockHash: block.hash, index: 0, logs: [] };
    block.transactions = [txHash]; transactions.set(txHash, tx); receipts.set(txHash, receipt); return txHash;
  }
  for (const [index, name] of targetOwnerUpgradeDeploymentOrder.entries()) {
    const row = plan.deployments[index], txHash = addTx(name, 310 + index, catalog.deployer, null, row.data, row.address, 20 + index);
    deployments[name] = { address: row.address, txHash };
  }
  const scheduleTxHash = addTx('schedule', 320, catalog.bindings.proposer, old.timelock, plan.scheduleData);
  const executeTxHash = addTx('execute', 380, '0x0000000000000000000000000000000000004444', old.timelock, plan.executeData);
  function event(txHash, to, name, values, index) {
    const receipt = receipts.get(txHash), encoded = abi.encodeEventLog(abi.getEvent(name), values);
    receipt.logs.push({ ...encoded, address: to, transactionHash: txHash, blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber, index, transactionIndex: receipt.index, removed: false });
  }
  event(scheduleTxHash, old.timelock, 'CallScheduled', [plan.operationId, 0n, plan.target, 0n, plan.data, plan.predecessor, 172800n], 0);
  event(executeTxHash, old.timelock, 'CallExecuted', [plan.operationId, 0n, plan.target, 0n, plan.data], 0);
  event(executeTxHash, old.beacon, 'Upgraded', [replacements.PoolVault], 1);
  const calls = [], state = { phase, chain: '0x38', delay: 172800n, authorityOwner: old.timelock, oldFirstoLinksChanged: false };
  const provider = {
    async getBlock(tag) { calls.push(['getBlock', tag]); return structuredClone(blocks.get(tag === 'finalized' ? 400 : tag) ?? makeBlock(tag)); },
    async getCode(to, block) { calls.push(['getCode', to, block]); return codes.get(to.toLowerCase()) ?? '0x'; },
    async getStorage(to, slot, block) { calls.push(['getStorage', to, slot, block]);
      const pairs = catalog.implementations;
      const name = Object.keys(pairs).find(key => old[key].toLowerCase() === to.toLowerCase()); return `0x${a[pairs[name]].slice(2).toLowerCase().padStart(64, '0')}`; },
    async getTransaction(txHash) { calls.push(['getTransaction', txHash]); return structuredClone(transactions.get(txHash)); },
    async getTransactionReceipt(txHash) { calls.push(['getTransactionReceipt', txHash]); return structuredClone(receipts.get(txHash)); },
    async send(method, args) { calls.push([method, args]); if (method === 'eth_chainId') return state.chain;
      assert.equal(method, 'eth_call', 'proof modules only read'); const parsed = abi.parseTransaction({ data: args[0].data }), to = args[0].to.toLowerCase(), block = Number(BigInt(args[1]));
      const name = parsed.name; let value;
      if (name === 'owner') value = to === catalog.authority.address.toLowerCase() ? state.authorityOwner : old.timelock;
      else if (name === 'timelock') value = old.timelock;
      else if (name === 'operator' || name === 'treasury') value = catalog.authority.address;
      else if (name === 'lens') value = old.lens;
      else if (name === 'factory' || name === 'coreFactory' || name === 'OFFICIAL_FACTORY') value = to === old.portfolioBeacon.toLowerCase() ? old.portfolioFactory : old.factory;
      else if (name === 'budgetFactory') value = old.portfolioFactory;
      else if (['administratorOne', 'administratorTwo', 'gasWallet'].includes(name)) value = catalog.authority[name];
      else if (name === 'implementation') value = to === old.portfolioBeacon.toLowerCase() ? a.BudgetPortfolioVault
        : state.phase === 'done' && block >= 380 ? replacements.PoolVault : a.PoolVault;
      else if (name === 'targetOwnerVersion') value = state.version ?? 1n;
      else if (name === 'getMinDelay') value = state.delay;
      else if (name === 'hasRole') value = true;
      else if (name === 'hashOperation') value = plan.operationId;
      else if (name === 'isOperation') value = state.phase !== 'unscheduled';
      else if (name === 'isOperationReady') value = state.phase === 'scheduled' && !waiting;
      else if (name === 'isOperationDone') value = state.phase === 'done';
      else if (name === 'getTimestamp') value = state.phase === 'done' ? 1n : state.phase === 'unscheduled' ? 0n : 272800n;
      else throw new Error(`Unsupported fixture read: ${name}`);
      return abi.encodeFunctionResult(name, [value]);
    },
  };
  const options = { phase, deployments, plan, scheduleTxHash, executeTxHash };
  const finalCatalog = { schemaVersion: 1, kind: TARGET_OWNER_UPGRADE_KIND, chainId: 56, profile: 'full-test', reviewCatalog: catalog,
    reviewCatalogDigest: input.trustedReviewCatalogDigest, candidateArtifactDigest: input.trustedUpgradeArtifactDigest,
    deployments, salt: input.salt, delaySeconds: input.delaySeconds, operation: { scheduleTxHash, executeTxHash }, verification: { blockNumber: 390, blockHash: hash('block390') } };
  return { input, provider, state, options, plan, codes, blocks, transactions, receipts, deployments, replacements, finalCatalog, calls };
}
