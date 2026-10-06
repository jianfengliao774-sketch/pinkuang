import { AbiCoder, Interface, ZeroAddress, ZeroHash, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { evidenceDigest, settleReads } from './firsto-upgrade-proof.mjs';
import { reviewedUpgradeBytecode } from './integrated-upgrade-plan.mjs';

export const PORTFOLIO_DUST_KIND = 'portfolio-dust-release-v1';
export const PORTFOLIO_DUST_MIN_DELAY = 172800;
const HASH = /^0x[\da-f]{64}$/i;
const BYTECODE = /^0x(?:[\da-f]{2}|__\$[\da-f]{34}\$__)+$/i;
const PLACEHOLDER = /^__\$[\da-f]{34}\$__$/i;
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const need = (condition, message) => { if (!condition) throw new Error(message); };
const same = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
const role = name => keccak256(toUtf8Bytes(name));
const abi = new Interface([
  'function owner() view returns(address)', 'function timelock() view returns(address)',
  'function operator() view returns(address)', 'function treasury() view returns(address)',
  'function beacon() view returns(address)', 'function implementation() view returns(address)',
  'function OFFICIAL_FACTORY() view returns(address)', 'function coreFactory() view returns(address)',
  'function budgetFactory() view returns(address)', 'function administratorOne() view returns(address)',
  'function administratorTwo() view returns(address)', 'function gasWallet() view returns(address)',
  'function getMinDelay() view returns(uint256)', 'function hasRole(bytes32,address) view returns(bool)',
  'function hashOperation(address,uint256,bytes,bytes32,bytes32) view returns(bytes32)',
  'function getTimestamp(bytes32) view returns(uint256)', 'function isOperation(bytes32) view returns(bool)',
  'function isOperationReady(bytes32) view returns(bool)', 'function isOperationDone(bytes32) view returns(bool)',
  'function upgradeTo(address)', 'function schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
  'function execute(address,uint256,bytes,bytes32,bytes32) payable',
]);
function address(value, label) {
  try { const result = getAddress(value); need(result !== ZeroAddress, 'zero'); return result; }
  catch { throw new Error(`Invalid ${label} address.`); }
}
function links(artifact, field, code) {
  need(BYTECODE.test(code ?? ''), `Malformed BudgetPortfolioVault ${field} bytecode.`);
  const references = artifact[field];
  need(references && Object.keys(references).join(',') === 'src/libraries/SaleGovernance.sol'
    && Object.keys(references['src/libraries/SaleGovernance.sol']).join(',') === 'SaleGovernance',
  `Only the preserved SaleGovernance link is permitted in ${field}.`);
  const locations = references['src/libraries/SaleGovernance.sol'].SaleGovernance, occupied = new Set();
  need(Array.isArray(locations) && locations.length > 0, `Missing ${field} link locations.`);
  for (const { start, length } of locations) {
    need(Number.isSafeInteger(start) && start >= 0 && length === 20 && 2 + (start + length) * 2 <= code.length
      && PLACEHOLDER.test(code.slice(2 + start * 2, 2 + (start + length) * 2)), `Invalid ${field} link location.`);
    for (let offset = start; offset < start + length; offset++) {
      need(!occupied.has(offset), `Overlapping ${field} links.`); occupied.add(offset);
    }
  }
  return occupied;
}
function configuration(supplied) {
  // The caller supplies the build-pinned release JSON, never a browser upload.
  // Snapshot it before asynchronous reads so later mutations cannot change a proof.
  const config = structuredClone(supplied);
  need(config?.schemaVersion === 1 && config.kind === PORTFOLIO_DUST_KIND && config.chainId === 56,
    'A fixed BSC portfolio-dust release configuration is required.');
  const manifest = config.manifest, record = config.genesisRecord;
  need(manifest?.chainId === 56 && manifest.kind === 'integrated-v2' && HASH.test(manifest.artifactDigest ?? '')
    && record?.chainId === 56 && record.kind === 'integrated-v2' && record.status === 'complete'
    && same(record.artifactDigest, manifest.artifactDigest), 'Formal genesis record and manifest differ.');
  const keys = ['factory', 'portfolioFactory', 'portfolioBeacon', 'timelock', 'portfolioImplementation', 'portfolioFactoryImplementation'];
  const addresses = Object.fromEntries(keys.map(key => [key, address(manifest[key], key)]));
  for (const key of ['factory', 'portfolioFactory', 'portfolioBeacon', 'timelock']) {
    need(same(record.addresses?.[key], addresses[key]), `Genesis ${key} binding differs.`);
  }
  for (const key of keys.filter(key => key !== 'factory')) need(HASH.test(manifest.codehash?.[key] ?? ''), `Missing ${key} codehash pin.`);
  const active = manifest.freshAuthority;
  need(active && same(manifest.authority, active.address) && same(manifest.gasWallet, active.gasWallet)
    && HASH.test(active.codehash ?? ''), 'Formal active Authority pins differ.');
  const authority = Object.fromEntries(['address', 'administratorOne', 'administratorTwo', 'gasWallet'].map(key => [key, address(active[key], `Authority ${key}`)]));
  const deployer = address(config.deployer, 'deployer'), proposer = address(config.proposer, 'proposer');
  need(same(proposer, record.input?.ownerMultisig), 'Proposer differs from the preserved genesis proposer.');
  const library = config.saleGovernance;
  need(library && HASH.test(library.codehash ?? ''), 'Preserved SaleGovernance codehash pin is required.');
  const libraryAddress = address(library.address, 'SaleGovernance');
  need(new Set([addresses.portfolioFactory, addresses.portfolioBeacon, addresses.timelock,
    addresses.portfolioImplementation, addresses.portfolioFactoryImplementation, authority.address,
    authority.administratorOne, authority.administratorTwo, authority.gasWallet, libraryAddress]
    .map(value => value.toLowerCase())).size === 10, 'Preserved graph or Authority addresses overlap.');
  need(HASH.test(config.candidateArtifactDigest ?? '') && !same(config.candidateArtifactDigest, manifest.artifactDigest)
    && HASH.test(config.candidateArtifactHash ?? '') && same(evidenceDigest(config.candidateArtifact), config.candidateArtifactHash),
  'Candidate BudgetPortfolioVault differs from its fixed artifact pin.');
  const artifact = config.candidateArtifact;
  need(artifact?.contractName === 'BudgetPortfolioVault' && Array.isArray(artifact.abi), 'Only BudgetPortfolioVault may be deployed.');
  const constructors = artifact.abi.filter(item => item.type === 'constructor');
  need(constructors.length === 1 && constructors[0].stateMutability === 'nonpayable'
    && constructors[0].inputs?.length === 1 && constructors[0].inputs[0].type === 'address',
  'BudgetPortfolioVault must preserve its single factory constructor argument.');
  links(artifact, 'linkReferences', artifact.bytecode);
  const occupied = links(artifact, 'deployedLinkReferences', artifact.deployedBytecode);
  need((artifact.deployedBytecode.length - 2) / 2 <= 24576, 'BudgetPortfolioVault exceeds EIP-170.');
  const groups = Object.values(artifact.immutableReferences ?? {});
  need(groups.length === 1 && Array.isArray(groups[0]) && groups[0].length > 0, 'Exactly one factory immutable group is required.');
  for (const { start, length } of groups[0]) {
    need(Number.isSafeInteger(start) && start >= 0 && length === 32 && 2 + (start + length) * 2 <= artifact.deployedBytecode.length
      && artifact.deployedBytecode.slice(2 + start * 2, 2 + (start + length) * 2) === '0'.repeat(64), 'Invalid preserved factory immutable location.');
    for (let offset = start; offset < start + length; offset++) {
      need(!occupied.has(offset), 'Overlapping factory immutable and library locations.'); occupied.add(offset);
    }
  }
  const linked = { SaleGovernance: libraryAddress };
  const data = reviewedUpgradeBytecode.spliceLinks(artifact.bytecode, artifact.linkReferences, linked)
    + new Interface(artifact.abi).encodeDeploy([addresses.portfolioFactory]).slice(2);
  need((data.length - 2) / 2 <= 49152, 'BudgetPortfolioVault initcode exceeds EIP-3860.');
  const expectedRuntime = reviewedUpgradeBytecode.expectedRuntime(artifact, linked, ZeroAddress, addresses.portfolioFactory);
  need(!same(keccak256(expectedRuntime), manifest.codehash.portfolioImplementation), 'Candidate runtime still equals the old portfolio implementation.');
  return { config, manifest, addresses, authority, deployer, proposer, libraryAddress, data, expectedRuntime };
}

/** Exact CREATE initcode and runtime template; no provider or wallet is consulted. */
export function preparePortfolioDustDeployment(config) {
  const { data, expectedRuntime } = configuration(config);
  return Object.freeze({ data, expectedRuntime, dataHash: keccak256(data) });
}
function replacementAddress(replacement, context) {
  const result = address(replacement, 'replacement BudgetPortfolioVault');
  const preserved = [...Object.values(context.addresses), ...Object.values(context.authority),
    context.libraryAddress, context.deployer, context.proposer];
  need(!preserved.some(value => same(value, result)), 'Replacement must be a new implementation address.');
  return result;
}

/** The sole governance call upgrades the existing portfolio Beacon. */
export function buildPortfolioDustPlan(config, replacement, salt, delaySeconds = PORTFOLIO_DUST_MIN_DELAY) {
  const context = configuration(config), next = replacementAddress(replacement, context);
  need(HASH.test(salt ?? '') && BigInt(salt) !== 0n, 'A unique nonzero 32-byte salt is required.');
  need(Number.isSafeInteger(delaySeconds) && delaySeconds >= PORTFOLIO_DUST_MIN_DELAY, 'Delay must be at least 48 hours.');
  const target = context.addresses.portfolioBeacon, payload = abi.encodeFunctionData('upgradeTo', [next]);
  const args = [target, 0n, payload, ZeroHash, salt];
  return Object.freeze({ operationId: keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'uint256', 'bytes', 'bytes32', 'bytes32'], args)),
    to: context.addresses.timelock, target, payload, predecessor: ZeroHash, value: '0', replacement: next,
    scheduleData: abi.encodeFunctionData('schedule', [...args, delaySeconds]),
    executeData: abi.encodeFunctionData('execute', args), salt, delaySeconds });
}
async function read(provider, to, method, args, block) {
  const raw = await provider.send('eth_call', [{ to, data: abi.encodeFunctionData(method, args) }, `0x${block.number.toString(16)}`]);
  return abi.decodeFunctionResult(method, raw)[0];
}
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

/** Read-only portfolio graph proof at one finalized canonical BSC block.
 * Operation state does not replace exact schedule/execute receipt verification.
 * Core Beacon and core implementation pointers are deliberately outside this scope.
 */
export async function validatePortfolioDustChain(provider, config, options = {}) {
  const context = configuration(config), { manifest, addresses: a, authority } = context;
  const replacement = options.replacement ? replacementAddress(options.replacement, context) : null;
  const plan = replacement && options.salt ? buildPortfolioDustPlan(context.config, replacement, options.salt,
    options.delaySeconds ?? PORTFOLIO_DUST_MIN_DELAY) : null;
  const [chain, block] = await settleReads([provider.send('eth_chainId', []), provider.getBlock('finalized')]);
  need(BigInt(chain) === 56n && Number.isSafeInteger(block?.number) && block.number > 0
    && HASH.test(block.hash ?? '') && Number.isSafeInteger(block.timestamp) && block.timestamp > 0, 'A finalized BSC block is required.');
  need(Number.isSafeInteger(manifest.verifiedBlockNumber) && manifest.verifiedBlockNumber > 0
    && manifest.verifiedBlockNumber <= block.number && HASH.test(manifest.verifiedBlockHash ?? ''), 'The formal activation anchor is required.');
  const anchor = await provider.getBlock(manifest.verifiedBlockNumber);
  need(anchor?.number === manifest.verifiedBlockNumber && same(anchor.hash, manifest.verifiedBlockHash), 'Formal activation anchor is not canonical.');
  const codehash = {};
  for (const key of ['portfolioFactory', 'portfolioBeacon', 'timelock', 'portfolioImplementation', 'portfolioFactoryImplementation']) {
    const code = await provider.getCode(a[key], block.number);
    need(/^0x(?:[\da-f]{2})+$/i.test(code ?? '') && same(keccak256(code), manifest.codehash[key]), `Pinned ${key} runtime differs.`);
    codehash[key] = keccak256(code);
  }
  const libraryCode = await provider.getCode(context.libraryAddress, block.number);
  need(/^0x(?:[\da-f]{2})+$/i.test(libraryCode ?? '')
    && same(keccak256(libraryCode), context.config.saleGovernance.codehash), 'Preserved SaleGovernance runtime differs.');
  if (context.config.saleGovernance.artifact) {
    const libraryArtifact = context.config.saleGovernance.artifact;
    need(libraryArtifact.contractName === 'SaleGovernance', 'Unexpected preserved library artifact.');
    const runtime = reviewedUpgradeBytecode.expectedRuntime(libraryArtifact, {}, context.libraryAddress, null);
    need(same(runtime, libraryCode), 'Preserved SaleGovernance runtime differs from its complete artifact.');
  }
  codehash.SaleGovernance = keccak256(libraryCode);
  if (replacement) {
    const code = await provider.getCode(replacement, block.number);
    need(same(code, context.expectedRuntime), 'Replacement runtime, SaleGovernance link or factory immutable differs.');
    need(same(await read(provider, replacement, 'OFFICIAL_FACTORY', [], block), a.portfolioFactory), 'Replacement factory binding differs.');
    codehash.replacement = keccak256(code);
  }
  const implementationSlot = await provider.getStorage(a.portfolioFactory, SLOT, block.number);
  need(/^0x0{24}[\da-f]{40}$/i.test(implementationSlot ?? '')
    && same(`0x${implementationSlot.slice(-40)}`, a.portfolioFactoryImplementation), 'Portfolio Factory implementation pointer differs.');
  const factoryValues = await settleReads(['owner', 'timelock', 'operator', 'treasury', 'beacon']
    .map(method => read(provider, a.portfolioFactory, method, [], block)));
  need(factoryValues.every((value, index) => same(value,
    [a.timelock, a.timelock, authority.address, authority.address, a.portfolioBeacon][index])), 'Portfolio Factory Authority or Beacon wiring differs.');
  const [beaconOwner, implementation, beaconFactory, oldFactory] = await settleReads([
    read(provider, a.portfolioBeacon, 'owner', [], block), read(provider, a.portfolioBeacon, 'implementation', [], block),
    read(provider, a.portfolioBeacon, 'OFFICIAL_FACTORY', [], block), read(provider, a.portfolioImplementation, 'OFFICIAL_FACTORY', [], block),
  ]);
  need(same(beaconOwner, a.timelock) && same(beaconFactory, a.portfolioFactory) && same(oldFactory, a.portfolioFactory), 'Portfolio Beacon ownership or factory binding differs.');
  const implState = same(implementation, a.portfolioImplementation) ? 'old' : replacement && same(implementation, replacement) ? 'new' : null;
  need(implState, 'Portfolio Beacon points to an unreviewed implementation.');
  const authorityCode = await provider.getCode(authority.address, block.number);
  need(/^0x(?:[\da-f]{2})+$/i.test(authorityCode ?? '') && same(keccak256(authorityCode), manifest.freshAuthority.codehash), 'Active Authority runtime differs.');
  const authorityMethods = ['owner', 'coreFactory', 'budgetFactory', 'administratorOne', 'administratorTwo', 'gasWallet'];
  const authorityValues = await settleReads(authorityMethods.map(method => read(provider, authority.address, method, [], block)));
  need(authorityValues.every((value, index) => same(value, [a.timelock, a.factory, a.portfolioFactory,
    authority.administratorOne, authority.administratorTwo, authority.gasWallet][index])), 'Active Authority binding or roles differ.');
  const [minDelay, proposerRole, cancellerRole, openExecutor] = await settleReads([
    read(provider, a.timelock, 'getMinDelay', [], block),
    read(provider, a.timelock, 'hasRole', [role('PROPOSER_ROLE'), context.proposer], block),
    read(provider, a.timelock, 'hasRole', [role('CANCELLER_ROLE'), context.proposer], block),
    read(provider, a.timelock, 'hasRole', [role('EXECUTOR_ROLE'), ZeroAddress], block),
  ]);
  need(minDelay >= BigInt(PORTFOLIO_DUST_MIN_DELAY) && proposerRole === true && cancellerRole === true && openExecutor === true,
    'Current proposer, canceller, open executor or 48-hour Timelock differs.');
  if (plan) need(BigInt(plan.delaySeconds) >= minDelay, 'Planned delay is below the current Timelock minimum.');
  let operation = null, readyAt = null, timestamp = null;
  if (plan) {
    const [operationId, exists, ready, done, observedTimestamp] = await settleReads([
      read(provider, a.timelock, 'hashOperation', [plan.target, 0n, plan.payload, ZeroHash, plan.salt], block),
      read(provider, a.timelock, 'isOperation', [plan.operationId], block),
      read(provider, a.timelock, 'isOperationReady', [plan.operationId], block),
      read(provider, a.timelock, 'isOperationDone', [plan.operationId], block),
      read(provider, a.timelock, 'getTimestamp', [plan.operationId], block),
    ]);
    need(same(operationId, plan.operationId), 'Timelock single-call operation hash differs.');
    need(observedTimestamp >= 0n && observedTimestamp <= BigInt(Number.MAX_SAFE_INTEGER), 'Unsafe Timelock timestamp.');
    timestamp = observedTimestamp.toString();
    operation = observedTimestamp === 0n ? 'unscheduled' : observedTimestamp === 1n ? 'done'
      : observedTimestamp <= BigInt(block.timestamp) ? 'ready' : 'waiting';
    need(exists === (observedTimestamp > 0n) && done === (operation === 'done') && ready === (operation === 'ready'), 'Inconsistent Timelock operation state.');
    need(implState === (operation === 'done' ? 'new' : 'old'), 'Portfolio implementation does not match this operation phase.');
    readyAt = observedTimestamp > 1n ? Number(observedTimestamp) : null;
  }
  const [again, againAnchor, againChain] = await settleReads([provider.getBlock(block.number),
    provider.getBlock(manifest.verifiedBlockNumber), provider.send('eth_chainId', [])]);
  need(BigInt(againChain) === 56n && again?.number === block.number && same(again.hash, block.hash)
    && againAnchor?.number === anchor.number && same(againAnchor.hash, anchor.hash), 'Canonical BSC block changed during verification.');
  return freeze({ chainId: 56, blockNumber: block.number, blockHash: block.hash, blockTimestamp: block.timestamp,
    checkedAt: new Date().toISOString(), readOnly: true, chainActionsPerformed: false,
    portfolioFactory: a.portfolioFactory, portfolioBeacon: a.portfolioBeacon, timelock: a.timelock,
    oldImplementation: a.portfolioImplementation, portfolioImplementation: getAddress(implementation), implState,
    replacement, replacementVerified: !!replacement, minDelay: minDelay.toString(), deployer: context.deployer,
    proposer: context.proposer, proposerRole, cancellerRole, openExecutor, authority, codehash,
    operationId: plan?.operationId ?? null, operation, readyAt, timestamp, operationReceiptVerified: false });
}
