import { AbiCoder, Interface, ZeroAddress, ZeroHash, getCreateAddress, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { buildDigest, evidenceDigest, settleReads } from './firsto-upgrade-proof.mjs';
import { decodeFreshSingleCallEnvelope, FRESH_DELEGATION_MANAGER, FRESH_DELEGATOR,
  FRESH_BALANCE_ENFORCER } from './fresh-activation-execution.mjs';
import { FIRSTO_BATCH_UPGRADE_KIND, firstoBatchUpgradeDeploymentOrder, validateFirstoBatchUpgradeReview,
  prepareFirstoBatchUpgradeDeployment, buildFirstoBatchUpgradePlan } from './firsto-batch-upgrade-plan.mjs';

import { verifyTargetOwnerUpgrade, targetOwnerVerifiedUpgrade } from './target-owner-upgrade-proof.mjs';

const HASH = /^0x[\da-f]{64}$/i;
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const need = (ok, message) => { if (!ok) throw new Error(message); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const address = value => { const result = getAddress(value); need(result !== ZeroAddress, 'Zero address.'); return result; };
const views = new Interface([
  'function owner() view returns(address)', 'function timelock() view returns(address)',
  'function operator() view returns(address)', 'function treasury() view returns(address)',
  'function lens() view returns(address)', 'function factory() view returns(address)',
  'function OFFICIAL_FACTORY() view returns(address)', 'function implementation() view returns(address)',
  'function targetOwnerVersion() view returns(uint8)', 'function firstoBatchPurchaseVersion() view returns(uint16)',
  'function coreFactory() view returns(address)', 'function budgetFactory() view returns(address)',
  'function administratorOne() view returns(address)', 'function administratorTwo() view returns(address)',
  'function gasWallet() view returns(address)', 'function getMinDelay() view returns(uint256)',
  'function hasRole(bytes32,address) view returns(bool)',
  'function hashOperation(address,uint256,bytes,bytes32,bytes32) view returns(bytes32)',
  'function isOperation(bytes32) view returns(bool)', 'function isOperationReady(bytes32) view returns(bool)',
  'function isOperationDone(bytes32) view returns(bool)', 'function getTimestamp(bytes32) view returns(uint256)',
]);
const actions = new Interface([
  'function schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
  'function execute(address,uint256,bytes,bytes32,bytes32) payable',
  'event CallScheduled(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data,bytes32 predecessor,uint256 delay)',
  'event CallSalt(bytes32 indexed id,bytes32 salt)',
  'event CallExecuted(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data)',
]);
const beacon = new Interface(['function upgradeTo(address)', 'event Upgraded(address indexed implementation)']);
const roles = Object.fromEntries(['PROPOSER_ROLE', 'CANCELLER_ROLE', 'EXECUTOR_ROLE'].map(name => [name, keccak256(toUtf8Bytes(name))]));
const accepted = new WeakSet(), completed = new WeakSet(), completedCache = new WeakMap();
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
async function read(p, to, method, args, block) {
  return views.decodeFunctionResult(method, await p.send('eth_call', [{ to, data: views.encodeFunctionData(method, args ?? []) },
    `0x${block.number.toString(16)}`]))[0];
}
async function snapshot(p, supplied) {
  const [chain, finalized] = await settleReads([p.send('eth_chainId', []), p.getBlock('finalized')]);
  need(BigInt(chain) === 56n && Number.isSafeInteger(finalized?.number) && finalized.number > 0 && HASH.test(finalized.hash ?? ''),
    'A canonical finalized chain-56 snapshot is required.');
  const block = supplied ?? finalized;
  need(Number.isSafeInteger(block?.number) && block.number > 0 && block.number <= finalized.number && HASH.test(block.hash ?? '')
    && Number.isSafeInteger(block.timestamp) && block.timestamp >= 0, 'Invalid finalized snapshot.');
  const canonical = await p.getBlock(block.number);
  need(canonical?.number === block.number && same(canonical.hash, block.hash) && canonical.timestamp === block.timestamp,
    'Snapshot is not canonical.');
  return { block, finalized };
}
async function canonical(p, context, anchor, transactions = []) {
  const [chain, block, finality, anchored] = await settleReads([p.send('eth_chainId', []), p.getBlock(context.block.number),
    p.getBlock(context.finalized.number), p.getBlock(anchor.blockNumber)]);
  need(BigInt(chain) === 56n && block?.number === context.block.number && same(block.hash, context.block.hash)
    && block.timestamp === context.block.timestamp && finality?.number === context.finalized.number
    && same(finality.hash, context.finalized.hash) && anchored?.number === anchor.blockNumber && same(anchored.hash, anchor.blockHash),
  'Chain, snapshot, finality or review anchor changed during verification.');
  for (const original of transactions) {
    const again = await transaction(p, original.tx.hash, context);
    need(same(again.tx.data, original.tx.data) && again.tx.nonce === original.tx.nonce
      && same(again.tx.from, original.tx.from) && again.tx.to === original.tx.to && again.tx.value === original.tx.value
      && again.tx.type === original.tx.type
      && (same(original.tx.to, FRESH_DELEGATION_MANAGER.address) ? !again.tx.authorizationList?.length : true)
      && again.receipt.blockNumber === original.receipt.blockNumber && again.receipt.index === original.receipt.index
      && same(again.receipt.blockHash, original.receipt.blockHash)
      && same(again.receipt.contractAddress ?? '', original.receipt.contractAddress ?? '')
      && receiptLogsDigest(again.receipt.logs) === receiptLogsDigest(original.receipt.logs),
    'Transaction evidence changed during canonical recheck.');
  }
}
function receiptLogsDigest(logs) {
  // ethers Log objects contain a provider reference; only receipt fields are evidence.
  return evidenceDigest((logs ?? []).map(log => ({ address: log.address, data: log.data, topics: [...(log.topics ?? [])],
    transactionHash: log.transactionHash, blockHash: log.blockHash, blockNumber: log.blockNumber,
    index: log.index, transactionIndex: log.transactionIndex, removed: log.removed })));
}
async function transaction(p, hash, context) {
  need(HASH.test(hash ?? ''), 'A confirmed transaction hash is required.');
  const [tx, receipt] = await settleReads([p.getTransaction(hash), p.getTransactionReceipt(hash)]);
  need(tx && receipt && same(tx.hash, hash) && same(receipt.hash ?? receipt.transactionHash, hash)
    && BigInt(tx.chainId ?? 0) === 56n && receipt.status === 1 && same(tx.from, receipt.from)
    && Number.isSafeInteger(receipt.blockNumber) && receipt.blockNumber > 0 && receipt.blockNumber <= context.block.number
    && receipt.blockNumber <= context.finalized.number && tx.blockNumber === receipt.blockNumber
    && same(tx.blockHash, receipt.blockHash) && HASH.test(receipt.blockHash ?? ''), 'Transaction is not a matching finalized successful inclusion.');
  const block = await p.getBlock(receipt.blockNumber);
  need(block?.number === receipt.blockNumber && same(block.hash, receipt.blockHash)
    && Number.isSafeInteger(receipt.index) && receipt.index >= 0 && tx.index === receipt.index
    && Array.isArray(block.transactions) && same(block.transactions[receipt.index], hash)
    && Number.isSafeInteger(block.timestamp), 'Transaction receipt is not canonically included.');
  return { tx, receipt, block };
}
function before(a, b) { return a.receipt.blockNumber < b.receipt.blockNumber
  || a.receipt.blockNumber === b.receipt.blockNumber && a.receipt.index < b.receipt.index; }
function logs(proof, to, abi, name) {
  const result = [], seen = new Set(), topic = abi.getEvent(name).topicHash;
  for (const log of proof.receipt.logs ?? []) {
    if (!same(log.address, to) || !same(log.topics?.[0], topic)) continue;
    need(log.removed !== true && same(log.transactionHash, proof.tx.hash) && same(log.blockHash, proof.receipt.blockHash)
      && log.blockNumber === proof.receipt.blockNumber && Number.isSafeInteger(log.index) && log.index >= 0
      && log.transactionIndex === proof.receipt.index
      && !seen.has(log.index), 'Event is not a canonical receipt log.'); seen.add(log.index);
    const parsed = abi.parseLog(log); need(parsed?.name === name, 'Malformed operation event.'); result.push(parsed);
  }
  return result;
}

function exactOperationEvents(proof, timelock, operation) {
  const indices = new Set();
  const event = (to, abi, name, values) => {
    const found = logs(proof, to, abi, name);
    need(found.length === 1, `Operation receipt requires one ${name} event.`);
    const encoded = abi.encodeEventLog(abi.getEvent(name), values);
    const matching = proof.receipt.logs.filter(log => same(log.address, to)
      && same(log.topics?.[0], abi.getEvent(name).topicHash));
    need(!indices.has(matching[0].index), 'Operation receipt repeats a log index.'); indices.add(matching[0].index);
    need(matching[0].topics.length === encoded.topics.length
      && matching[0].topics.every((topic, index) => same(topic, encoded.topics[index]))
      && same(matching[0].data, encoded.data), `${name} event differs from the complete original operation.`);
  };
  if (operation.name === 'schedule') {
    event(timelock, actions, 'CallScheduled', [operation.id, 0n, operation.target, 0n,
      operation.payload, operation.predecessor, operation.delay]);
    event(timelock, actions, 'CallSalt', [operation.id, operation.salt]);
  } else {
    event(timelock, actions, 'CallExecuted', [operation.id, 0n, operation.target, 0n, operation.payload]);
    event(operation.target, beacon, 'Upgraded', [operation.replacement]);
  }
}

/** The complete fixed single-call intent is required; a calldata digest alone never admits a wallet wrapper. */
export async function verifyFirstoBatchOperationReceipt(p, { tx, receipt, expected, finalized }) {
  need(['schedule', 'execute'].includes(expected.operation) && expected.to && HASH.test(expected.dataHash ?? '')
    && /^0x(?:[\da-f]{2})+$/i.test(expected.data ?? '') && same(keccak256(expected.data), expected.dataHash),
  'Complete original Firsto batch operation is required.');
  const parsed = actions.decodeFunctionData(expected.operation, expected.data);
  need(same(actions.encodeFunctionData(expected.operation, parsed), expected.data), 'Original operation calldata is not canonical.');
  const [rawTarget, value, payload, predecessor, salt, delay] = parsed;
  const target = address(rawTarget), timelock = address(expected.to);
  need(value === 0n && same(predecessor, ZeroHash) && HASH.test(salt ?? '') && !same(salt, ZeroHash)
    && (expected.operation !== 'schedule' || delay >= 172800n), 'Original operation value, predecessor, salt or full delay differs.');
  const upgrade = beacon.decodeFunctionData('upgradeTo', payload), replacement = address(upgrade[0]);
  need(same(beacon.encodeFunctionData('upgradeTo', [replacement]), payload), 'Original beacon upgrade payload is not canonical.');
  const id = keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'uint256', 'bytes', 'bytes32', 'bytes32'],
    [target, value, payload, predecessor, salt]));
  let runtimeProof;
  if (!same(tx.to, timelock)) {
    need(same(tx.to, FRESH_DELEGATION_MANAGER.address), 'Original operation has an unreviewed wallet wrapper.');
    need(Number.isSafeInteger(finalized?.number) && finalized.number >= receipt.blockNumber && HASH.test(finalized.hash ?? ''),
      'A canonical finalized wallet runtime anchor is required.');
    const [managerCode, delegatorCode, enforcerCode] = await settleReads([
      p.getCode(FRESH_DELEGATION_MANAGER.address, finalized.number), p.getCode(FRESH_DELEGATOR.address, finalized.number),
      p.getCode(FRESH_BALANCE_ENFORCER.address, finalized.number)]);
    runtimeProof = { managerCode, delegatorCode, enforcerCode };
  }
  const envelope = decodeFreshSingleCallEnvelope({ account: expected.from, target: timelock,
    data: expected.data, tx, receipt, runtimeProof });
  if (runtimeProof) {
    const again = await p.getBlock(finalized.number);
    need(again?.number === finalized.number && same(again.hash, finalized.hash), 'Wallet runtime anchor changed during verification.');
  }
  need(envelope.kind !== 'wrapped' || receipt.status === 1,
    '原钱包封装交易已回滚，原记录保留；不会自动释放 nonce 或允许重发。');
  if (receipt.status === 1) exactOperationEvents({ tx, receipt }, timelock,
    { name: expected.operation, id, target, payload, predecessor, salt, delay, replacement });
  return { ...envelope, operationId: id };
}
async function graph(p, review, context, upgraded = null) {
  const { catalog, addresses: a, runtimes } = review, block = context.block;
  // Prove the completed predecessor at the current review anchor, even after the successor changes the beacon.
  const predecessorBlock = await p.getBlock(catalog.anchor.blockNumber);
  const predecessor = await verifyTargetOwnerUpgrade(p, { targetOwnerUpgrade: review.predecessor }, predecessorBlock);
  targetOwnerVerifiedUpgrade(predecessor);
  const protocolCode = await p.getCode(review.protocol.exchange, block.number);
  need(same(keccak256(protocolCode), review.protocol.runtimeCodehash), 'Firsto batch runtime differs from exact source review.');
  need(block.number >= catalog.anchor.blockNumber, 'Snapshot precedes the reviewed current baseline.');
  const anchor = await p.getBlock(catalog.anchor.blockNumber);
  need(anchor?.number === catalog.anchor.blockNumber && same(anchor.hash, catalog.anchor.blockHash), 'Current baseline anchor is not canonical.');
  await settleReads(Object.entries(runtimes).map(async ([name, runtime]) => {
    const observed = await p.getCode(a[name], block.number);
    need(observed !== '0x' && same(observed, runtime), `Preserved baseline runtime or per-node links differ: ${name}.`);
  }));
  await settleReads(['factory', 'portfolioFactory', 'shareMarket', 'portfolioShareMarket'].map(async proxy => {
    const implementation = review.implementationNames[proxy];
    const slot = await p.getStorage(a[proxy], SLOT, block.number);
    need(/^0x0{24}[\da-f]{40}$/i.test(slot ?? '') && same(`0x${slot.slice(-40)}`, a[implementation]), `Preserved ${proxy} implementation differs.`);
  }));
  await settleReads([['beacon', upgraded?.PoolVault ?? a.PoolVault, a.factory],
    ['portfolioBeacon', a.BudgetPortfolioVault, a.portfolioFactory]].map(async ([name, implementation, factory]) => {
    const [owner, current, binding] = await settleReads([read(p, a[name], 'owner', [], block),
      read(p, a[name], 'implementation', [], block), read(p, a[name], 'OFFICIAL_FACTORY', [], block)]);
    need(same(owner, a.timelock) && same(current, implementation) && same(binding, factory), `Preserved ${name} binding differs.`);
  }));
  await settleReads(['factory', 'portfolioFactory'].map(async name => {
    const [owner, lock, operator, treasury] = await settleReads(['owner', 'timelock', 'operator', 'treasury'].map(method => read(p, a[name], method, [], block)));
    need(same(owner, a.timelock) && same(lock, a.timelock) && same(operator, catalog.authority.address)
      && same(treasury, catalog.authority.address), `Preserved ${name} Authority roles differ.`);
  }));
  need(same(await read(p, a.factory, 'lens', [], block), a.lens)
    && same(await read(p, a.lens, 'factory', [], block), a.factory), 'Preserved Lens binding differs.');
  const authorityCode = await p.getCode(catalog.authority.address, block.number);
  need(authorityCode !== '0x' && same(keccak256(authorityCode), catalog.authority.codehash), 'Preserved Authority runtime differs.');
  const expected = { owner: a.timelock, coreFactory: a.factory, budgetFactory: a.portfolioFactory,
    administratorOne: catalog.authority.administratorOne, administratorTwo: catalog.authority.administratorTwo, gasWallet: catalog.authority.gasWallet };
  await settleReads(Object.entries(expected).map(async ([method, value]) => need(same(await read(p, catalog.authority.address, method, [], block), value), `Current Authority ${method} differs.`)));
  const proposer = catalog.bindings.proposer;
  const [proposes, cancels, executes, delay] = await settleReads([read(p, a.timelock, 'hasRole', [roles.PROPOSER_ROLE, proposer], block),
    read(p, a.timelock, 'hasRole', [roles.CANCELLER_ROLE, proposer], block), read(p, a.timelock, 'hasRole', [roles.EXECUTOR_ROLE, ZeroAddress], block),
    read(p, a.timelock, 'getMinDelay', [], block)]);
  need(proposes === true && cancels === true && executes === true && delay >= 172800n, 'Current proposer or 48-hour Timelock roles differ.');
  return { proposer, authority: catalog.authority, minDelay: delay.toString() };
}
function prefix(deployments, full) {
  need(deployments && typeof deployments === 'object' && !Array.isArray(deployments), 'Deployment receipt map is required.');
  const keys = Object.keys(deployments);
  need(keys.every(name => firstoBatchUpgradeDeploymentOrder.includes(name))
    && keys.sort().join(',') === firstoBatchUpgradeDeploymentOrder.slice(0, keys.length).sort().join(',')
    && (!full || keys.length === firstoBatchUpgradeDeploymentOrder.length), 'Deployments must be the exact confirmed dependency prefix.');
  return firstoBatchUpgradeDeploymentOrder.slice(0, keys.length);
}

/** All provider operations are reads at one finalized snapshot. Supplied addresses never imply confirmed deployments. */
export async function validateFirstoBatchUpgradePreflight(p, input, options = {}) {
  const phase = options.phase ?? 'prepared';
  need(['prepared', 'unscheduled', 'scheduled', 'done'].includes(phase), 'Unknown Firsto batch phase.');
  const review = validateFirstoBatchUpgradeReview(input), deployments = options.deployments ?? {}, names = prefix(deployments, phase !== 'prepared');
  const context = await snapshot(p, options.snapshot), transactions = [];
  const claims = {}, proofs = {}, usedHashes = new Set(), graphInfo = await graph(p, review, context,
    phase === 'done' ? Object.fromEntries(names.map(name => [name, address(deployments[name]?.address)])) : null);
  if (input.signer) need(same(input.signer, graphInfo.proposer), 'Connect the reviewed Timelock proposer.');
  for (const name of names) {
    const item = deployments[name]; need(HASH.test(item?.txHash ?? '') && !usedHashes.has(item.txHash.toLowerCase()), 'Distinct confirmed deployment hashes are required.');
    usedHashes.add(item.txHash.toLowerCase());
    const prepared = prepareFirstoBatchUpgradeDeployment(name, input, { deploymentsPrefix: claims });
    const proof = await transaction(p, item.txHash, context), deployed = address(item.address);
    need(proof.tx.to === null && proof.receipt.to === null && proof.tx.value === 0n
      && same(proof.tx.from, review.catalog.deployer) && same(proof.receipt.contractAddress, deployed)
      && same(getCreateAddress({ from: proof.tx.from, nonce: proof.tx.nonce }), deployed)
      && same(proof.tx.data, prepared.data), `Deployment sender, CREATE address or reviewed initcode differs: ${name}.`);
    const prior = transactions.at(-1); need(!prior || before(prior, proof), 'Deployment dependency order differs.');
    claims[name] = deployed; proofs[name] = proof; transactions.push(proof);
  }
  let plan = null;
  if (names.length === firstoBatchUpgradeDeploymentOrder.length) {
    plan = buildFirstoBatchUpgradePlan({ ...input, replacements: claims, salt: options.plan?.salt ?? input.salt,
      delaySeconds: options.plan?.delaySeconds ?? input.delaySeconds });
    if (options.plan) need(same(evidenceDigest(plan), evidenceDigest(options.plan)), 'Plan differs from exact reviewed beacon operation.');
    need(BigInt(plan.delaySeconds) >= BigInt(graphInfo.minDelay), 'Plan delay is below the current Timelock minimum.');
    for (const entry of plan.deployments) need(same(await p.getCode(entry.address, context.block.number), entry.expectedRuntime), `Reviewed deployed runtime differs: ${entry.name}.`);
    const [factory, version, batchVersion] = await settleReads([read(p, claims.PoolVault, 'OFFICIAL_FACTORY', [], context.block),
      read(p, claims.PoolVault, 'targetOwnerVersion', [], context.block), read(p, claims.PoolVault, 'firstoBatchPurchaseVersion', [], context.block)]);
    need(same(factory, review.addresses.factory) && version === 1n && batchVersion === 1n, 'New Vault factory immutable or Firsto batch version differs.');
  } else {
    // Runtime checks for each confirmed prefix must not rely on future planned addresses.
    for (const name of names) {
      const artifact = input.upgradeBundle.artifacts[name];
      const linked = { ...review.addresses, ...claims };
      const { reviewedUpgradeBytecode } = await import('./integrated-upgrade-plan.mjs');
      const runtime = reviewedUpgradeBytecode.expectedRuntime(artifact, linked, claims[name], name === 'PoolVault' ? review.addresses.factory : null);
      need(same(await p.getCode(claims[name], context.block.number), runtime), `Reviewed deployed prefix runtime differs: ${name}.`);
    }
  }
  let operation = null;
  if (phase !== 'prepared') {
    const a = review.addresses, block = context.block;
    const [id, exists, ready, done, timestamp] = await settleReads([read(p, a.timelock, 'hashOperation',
      [plan.target, 0n, plan.data, plan.predecessor, plan.salt], block), read(p, a.timelock, 'isOperation', [plan.operationId], block),
    read(p, a.timelock, 'isOperationReady', [plan.operationId], block), read(p, a.timelock, 'isOperationDone', [plan.operationId], block),
    read(p, a.timelock, 'getTimestamp', [plan.operationId], block)]);
    need(same(id, plan.operationId), 'Timelock operation hash differs.');
    if (phase === 'unscheduled') need(!exists && !ready && !done && timestamp === 0n, 'Operation is already scheduled.');
    else {
      need(HASH.test(options.scheduleTxHash ?? '') && !usedHashes.has(options.scheduleTxHash.toLowerCase()), 'Distinct schedule receipt is required.');
      usedHashes.add(options.scheduleTxHash.toLowerCase());
      const scheduled = await transaction(p, options.scheduleTxHash, context); transactions.push(scheduled);
      need(same(scheduled.tx.from, graphInfo.proposer) && names.every(name => before(proofs[name], scheduled)),
        'Schedule is not the exact reviewed proposer operation after deployment.');
      await verifyFirstoBatchOperationReceipt(p, { ...scheduled, finalized: context.finalized,
        expected: { from: graphInfo.proposer, to: a.timelock, data: plan.scheduleData,
          dataHash: keccak256(plan.scheduleData), operation: 'schedule' } });
      const scheduledLogs = logs(scheduled, a.timelock, actions, 'CallScheduled');
      need(scheduledLogs.length === 1 && same(scheduledLogs[0].args.id, plan.operationId) && scheduledLogs[0].args.index === 0n
        && same(scheduledLogs[0].args.target, plan.target) && scheduledLogs[0].args.value === 0n && same(scheduledLogs[0].args.data, plan.data)
        && same(scheduledLogs[0].args.predecessor, plan.predecessor) && scheduledLogs[0].args.delay === BigInt(plan.delaySeconds), 'Schedule event differs.');
      const readyAt = BigInt(scheduled.block.timestamp) + BigInt(plan.delaySeconds);
      if (phase === 'scheduled') need(exists && !done && timestamp === readyAt && ready === (readyAt <= BigInt(block.timestamp)), 'Scheduled readiness or full delay differs.');
      if (phase === 'done') {
        need(HASH.test(options.executeTxHash ?? '') && !usedHashes.has(options.executeTxHash.toLowerCase()), 'Distinct execution receipt is required.');
        const executed = await transaction(p, options.executeTxHash, context); transactions.push(executed);
        await verifyFirstoBatchOperationReceipt(p, { ...executed, finalized: context.finalized,
          expected: { from: executed.tx.from, to: a.timelock, data: plan.executeData,
            dataHash: keccak256(plan.executeData), operation: 'execute' } });
        need(before(scheduled, executed) && BigInt(executed.block.timestamp) >= readyAt,
        'Execution calldata, order or full Timelock delay differs.');
        const executedLogs = logs(executed, a.timelock, actions, 'CallExecuted'), upgradedLogs = logs(executed, a.beacon, beacon, 'Upgraded');
        need(executedLogs.length === 1 && same(executedLogs[0].args.id, plan.operationId) && executedLogs[0].args.index === 0n
          && same(executedLogs[0].args.target, plan.target) && executedLogs[0].args.value === 0n && same(executedLogs[0].args.data, plan.data)
          && upgradedLogs.length === 1 && same(upgradedLogs[0].args.implementation, claims.PoolVault), 'Execution or beacon upgrade event differs.');
        need(exists && done && !ready && timestamp === 1n, 'Reviewed operation is not completed.');
        const beforeBlock = await p.getBlock(executed.receipt.blockNumber - 1);
        need(beforeBlock?.number >= review.catalog.anchor.blockNumber
          && same(await read(p, a.beacon, 'implementation', [], beforeBlock), review.addresses.PoolVault), 'Pre-execution beacon baseline differs.');
      }
    }
    need(timestamp <= BigInt(Number.MAX_SAFE_INTEGER), 'Timelock timestamp exceeds safe display range.');
    operation = { operationId: plan.operationId, timelockTimestamp: timestamp.toString(), readyAt: timestamp > 1n ? Number(timestamp) : null,
      operation: phase === 'done' ? 'done' : phase === 'unscheduled' ? 'unscheduled' : ready ? 'ready' : 'waiting',
      ready: phase === 'scheduled' && ready, codeUpgradeComplete: phase === 'done' };
  }
  await canonical(p, context, review.catalog.anchor, transactions);
  const result = freeze({ operation: null, readyAt: null, ...graphInfo, ...operation, deployer: review.catalog.deployer, phase, blockNumber: context.block.number, blockHash: context.block.hash,
    checkedAt: new Date().toISOString(), baselineVerified: true, verifiedDeploymentNames: names,
    deployments: Object.fromEntries(names.map(name => [name, { address: claims[name], txHash: deployments[name].txHash }])),
    replacements: claims, replacementDeploymentVerified: names.length === firstoBatchUpgradeDeploymentOrder.length,
    candidateArtifactDigest: input.trustedUpgradeArtifactDigest, reviewCatalogDigest: input.trustedReviewCatalogDigest,
    codehash: plan ? Object.fromEntries(plan.deployments.map(row => [row.name, row.codehash])) : {},
    codeUpgradeComplete: phase === 'done' });
  if (phase === 'done') completed.add(result); return result;
}

/** Operator-owned persistent catalog; copied and branded so later mutation cannot turn claims into proofs. */
export function validateFirstoBatchUpgradeCatalog(catalog, bundle, baseInputs, { trustedCatalogDigest } = {}) {
  need(HASH.test(trustedCatalogDigest ?? '') && same(evidenceDigest(catalog), trustedCatalogDigest), 'Activated catalog differs from independent operator pin.');
  need(catalog?.schemaVersion === 1 && catalog.kind === FIRSTO_BATCH_UPGRADE_KIND && catalog.chainId === 56
    && ['formal', 'full-test'].includes(catalog.profile) && catalog.profile === catalog.reviewCatalog?.profile
    && same(catalog.candidateArtifactDigest, buildDigest(bundle)) && Number.isSafeInteger(catalog.verification?.blockNumber)
    && catalog.verification.blockNumber > 0 && HASH.test(catalog.verification.blockHash ?? ''), 'Activated catalog identity or anchor differs.');
  const input = { ...baseInputs, upgradeBundle: bundle, trustedUpgradeArtifactDigest: catalog.candidateArtifactDigest,
    reviewCatalog: catalog.reviewCatalog, trustedReviewCatalogDigest: catalog.reviewCatalogDigest,
    salt: catalog.salt, delaySeconds: catalog.delaySeconds };
  const review = validateFirstoBatchUpgradeReview(input); prefix(catalog.deployments, true);
  need(catalog.verification.blockNumber >= review.catalog.anchor.blockNumber, 'Activation anchor precedes baseline review.');
  const hashes = [...Object.values(catalog.deployments).map(row => row.txHash), catalog.operation?.scheduleTxHash, catalog.operation?.executeTxHash];
  need(hashes.every(hash => HASH.test(hash ?? '')) && new Set(hashes.map(hash => hash.toLowerCase())).size === firstoBatchUpgradeDeploymentOrder.length + 2, 'Activated catalog requires distinct confirmed deployment, schedule and execution hashes.');
  buildFirstoBatchUpgradePlan({ ...input, replacements: Object.fromEntries(Object.entries(catalog.deployments).map(([name, row]) => [name, row.address])) });
  const copied = JSON.parse(JSON.stringify({ catalog, bundle, input }));
  copied.catalog.nodes = copied.catalog.reviewCatalog.nodes;
  copied.catalog.implementations = review.implementationNames;
  copied.catalogDigest = trustedCatalogDigest; freeze(copied); accepted.add(copied); return copied;
}

/** Product-graph adapter verifies history at finalized state; its caller checks newer live code separately. */
export async function verifyFirstoBatchUpgrade(p, trusted, suppliedBlock) {
  const approved = trusted.firstoBatchUpgrade; if (!approved) return null;
  need(accepted.has(approved), 'Unvalidated Firsto batch catalog.');
  const { catalog, input } = approved, a = catalog.reviewCatalog.bindings, context = await snapshot(p);
  const block = suppliedBlock && suppliedBlock.number <= context.finalized.number ? (await snapshot(p, suppliedBlock)).block : context.block;
  const current = await read(p, a.beacon, 'implementation', [], block);
  if (same(current, catalog.nodes.PoolVault.address)) {
    await validateFirstoBatchUpgradePreflight(p, input, { phase: 'prepared', deployments: {}, snapshot: block }); return null;
  }
  need(block.number >= catalog.verification.blockNumber, 'Snapshot precedes Firsto batch activation verification.');
  const anchor = await p.getBlock(catalog.verification.blockNumber);
  need(anchor?.number === catalog.verification.blockNumber && same(anchor.hash, catalog.verification.blockHash), 'Activated catalog anchor is not canonical.');
  let providers = completedCache.get(approved);
  if (!providers) { providers = new WeakMap(); completedCache.set(approved, providers); }
  const cached = providers.get(p);
  if (cached) {
    const protocol = validateFirstoBatchUpgradeReview(input).protocol;
    need(same(keccak256(await p.getCode(protocol.exchange, block.number)), protocol.runtimeCodehash),
      'Cached Firsto batch protocol runtime differs from the exact source review.');
    const cachedBlock = await p.getBlock(cached.blockNumber);
    need(cachedBlock?.number === cached.blockNumber && same(cachedBlock.hash, cached.blockHash), 'Cached completion block changed.');
    const [factory, version, batchVersion, done] = await settleReads([read(p, cached.replacements.PoolVault, 'OFFICIAL_FACTORY', [], block),
      read(p, cached.replacements.PoolVault, 'targetOwnerVersion', [], block), read(p, cached.replacements.PoolVault, 'firstoBatchPurchaseVersion', [], block), read(p, a.timelock, 'isOperationDone', [cached.operationId], block)]);
    need(same(current, cached.replacements.PoolVault) && same(factory, a.factory) && version === 1n && batchVersion === 1n && done === true,
      'Cached current beacon, immutable, version or completed operation differs.');
    for (const name of firstoBatchUpgradeDeploymentOrder) need(same(keccak256(await p.getCode(cached.replacements[name], block.number)), cached.codehash[name]),
      `Cached current candidate codehash differs: ${name}.`);
    await canonical(p, { block, finalized: context.finalized }, catalog.reviewCatalog.anchor);
    const activationAgain = await p.getBlock(catalog.verification.blockNumber);
    need(same(activationAgain?.hash, anchor.hash), 'Cached activation anchor changed.');
    return cached;
  }
  const proof = await validateFirstoBatchUpgradePreflight(p, input, { phase: 'done', deployments: catalog.deployments,
    scheduleTxHash: catalog.operation.scheduleTxHash, executeTxHash: catalog.operation.executeTxHash, snapshot: block });
  const again = await p.getBlock(catalog.verification.blockNumber);
  need(again?.number === anchor.number && same(again.hash, anchor.hash), 'Activation anchor changed during proof.');
  const result = freeze({ ...proof, catalogDigest: approved.catalogDigest }); completed.add(result); providers.set(p, result); return result;
}

export function firstoBatchVerifiedUpgrade(proof) { need(completed.has(proof), 'Unverified Firsto batch completion.'); return proof; }
