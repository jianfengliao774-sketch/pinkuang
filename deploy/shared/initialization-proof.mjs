import { Interface, ZeroAddress, getAddress, getCreateAddress, keccak256 } from 'ethers';

// Kept independent of a downloaded artifact: these are the reviewed coordinator's
// fixed initialization interfaces. Runtime and canonical-chain verification must
// still be performed independently by each consumer.
export const INITIALIZATION_PROOF_ABI = [
  'function deploy((address ownerMultisig,address operator,address treasury,address vaultImplementation,address factoryImplementation,address marketImplementation) config)',
  'function deploySingleOwner((address ownerMultisig,address operator,address treasury,address vaultImplementation,address factoryImplementation,address marketImplementation) config)',
  'event DeploymentCompleted(address indexed factory,address indexed beacon,address indexed shareMarket,address timelock,address ownerMultisig,address operator,address treasury)',
  'event ImplementationsRecorded(address vault,bytes32 vaultCodehash,address factory,bytes32 factoryCodehash,address market,bytes32 marketCodehash)',
  'event SingleOwnerDeployment(address indexed owner,address indexed factory)',
];

const iface = new Interface(INITIALIZATION_PROOF_ABI);
const HASH = /^0x[0-9a-f]{64}$/i;
const DATA = /^0x(?:[0-9a-f]{2})*$/i;
const requireProof = (condition, message) => {
  if (!condition) throw new Error(`Initialization proof: 交易内容校验失败：${message}`);
};
const address = value => {
  try {
    const result = getAddress(value);
    requireProof(result !== ZeroAddress, 'zero address is not allowed.');
    return result;
  } catch { throw new Error('Initialization proof: 交易内容校验失败：invalid or zero address.'); }
};
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * Recognize an already-mined initialization outcome. A wrapped result is NOT an
 * authorization of the envelope or its other calls, and must never relax future
 * signing rules. Callers must additionally verify finalized canonical inclusion,
 * trusted coordinator/implementation runtime, coordinator.deployer, and the
 * entire resulting deployment graph. No network access or record mutation here.
 */
export function verifyInitializationExecution({ record, step, tx, receipt }) {
  requireProof(record && step?.id === 'initialize' && tx && receipt, 'missing initialization record.');
  const mode = record.input?.governanceMode;
  requireProof(mode === 'single' || mode === 'multisig', 'unsupported governance mode.');
  const account = address(record.account);
  const coordinator = address(record.addresses?.AtomicDeployment);
  const config = {
    ownerMultisig: address(record.input.ownerMultisig),
    operator: address(record.input.operator),
    treasury: address(record.input.treasury),
    vaultImplementation: address(record.addresses.PoolVault),
    factoryImplementation: address(record.addresses.PoolFactory),
    marketImplementation: address(record.addresses.ShareMarket),
  };
  if (mode === 'single') requireProof(same(config.ownerMultisig, account), 'single owner differs from deployment account.');
  const plannedData = iface.encodeFunctionData(mode === 'single' ? 'deploySingleOwner' : 'deploy', [config]);
  const plannedDataHash = keccak256(plannedData);
  requireProof(HASH.test(step.dataHash ?? '') && same(step.dataHash, plannedDataHash), 'recorded initialization calldata differs from the reviewed plan.');
  requireProof(tx.chainId === 56n && tx.value === 0n, 'wrong chain or nonzero outer value.');
  requireProof(same(tx.from, account) && same(receipt.from, account)
    && Number.isSafeInteger(step.nonce) && step.nonce >= 0 && tx.nonce === step.nonce,
  'transaction sender or nonce differs.');
  requireProof(HASH.test(tx.hash ?? '') && same(tx.hash, receipt.hash)
    && (!step.txHash || same(step.txHash, tx.hash)), 'transaction hash differs.');
  const outerTo = address(tx.to);
  requireProof(same(outerTo, receipt.to) && receipt.status === 1
    && Number.isSafeInteger(receipt.blockNumber) && receipt.blockNumber >= 0
    && tx.blockNumber === receipt.blockNumber && HASH.test(receipt.blockHash ?? '')
    && same(tx.blockHash, receipt.blockHash), 'receipt identity or successful execution is missing.');
  requireProof(typeof tx.data === 'string' && DATA.test(tx.data), 'invalid outer calldata.');

  // CREATE ordering is fixed in AtomicDeployment._deploy and
  // PoolFactory.initializeDeployment: timelock 1, beacon 2, factory 3;
  // factory creates its lens at nonce 1 and share-market proxy at nonce 2.
  const factory = getCreateAddress({ from: coordinator, nonce: 3 });
  const addresses = {
    timelock: getCreateAddress({ from: coordinator, nonce: 1 }),
    beacon: getCreateAddress({ from: coordinator, nonce: 2 }),
    factory,
    shareMarket: getCreateAddress({ from: factory, nonce: 2 }),
  };
  const base = { coordinator, outerTo, outerDataHash: keccak256(tx.data), plannedDataHash, addresses };
  if (same(outerTo, coordinator) && same(tx.data, plannedData)) return { kind: 'direct', ...base };

  requireProof(mode === 'single', 'wrapped initialization is supported only for single-owner recovery.');
  requireProof(!same(outerTo, coordinator), 'coordinator calldata differs from the planned initialization.');
  requireProof(Array.isArray(record.steps), 'missing confirmed prerequisite steps.');
  const prerequisites = {};
  for (const id of ['AtomicDeployment', 'PoolVault', 'PoolFactory', 'ShareMarket']) {
    const matches = record.steps.filter(item => item.id === id);
    requireProof(matches.length === 1 && matches[0].status === 'confirmed'
      && same(matches[0].address, record.addresses[id]) && HASH.test(matches[0].codehash ?? ''),
    `missing or inconsistent confirmed prerequisite ${id}.`);
    prerequisites[id] = matches[0];
  }

  // Containment is only corroboration. Coordinator-origin events below prove
  // the exact execution result; their code/emitter must be authenticated by the
  // consumer, and full deployment graph validation remains mandatory.
  const outerHex = tx.data.slice(2).toLowerCase();
  const innerHex = plannedData.slice(2).toLowerCase();
  let occurrences = 0;
  for (let index = outerHex.indexOf(innerHex); index !== -1; index = outerHex.indexOf(innerHex, index + 1)) {
    if (index % 2 === 0) occurrences++;
  }
  requireProof(occurrences === 1, 'outer calldata must contain exactly one complete planned initialization.');
  requireProof(Array.isArray(receipt.logs), 'missing initialization events.');
  const logs = receipt.logs.filter(log => same(log.address, coordinator));
  requireProof(logs.length === 3, 'expected exactly three coordinator initialization events.');
  const events = [
    ['DeploymentCompleted', [addresses.factory, addresses.beacon, addresses.shareMarket, addresses.timelock,
      config.ownerMultisig, config.operator, config.treasury]],
    ['ImplementationsRecorded', [config.vaultImplementation, prerequisites.PoolVault.codehash,
      config.factoryImplementation, prerequisites.PoolFactory.codehash,
      config.marketImplementation, prerequisites.ShareMarket.codehash]],
    ['SingleOwnerDeployment', [config.ownerMultisig, addresses.factory]],
  ];
  let lastIndex = -1;
  for (let index = 0; index < events.length; index++) {
    const log = logs[index];
    // ethers 6 formatReceiptLog omits `removed` for receipt-owned logs. Explicit
    // removal is rejected; canonical block membership is checked by the caller.
    requireProof((log.removed === false || log.removed === undefined) && same(log.transactionHash, tx.hash)
      && log.blockNumber === receipt.blockNumber && same(log.blockHash, receipt.blockHash)
      && Number.isSafeInteger(log.index) && log.index > lastIndex,
    'initialization event is removed, unordered, or belongs to a different receipt.');
    lastIndex = log.index;
    const [name, values] = events[index];
    const expected = iface.encodeEventLog(iface.getEvent(name), values);
    requireProof(Array.isArray(log.topics) && log.topics.length === expected.topics.length
      && log.topics.every((topic, topicIndex) => same(topic, expected.topics[topicIndex]))
      && same(log.data, expected.data), `missing or mismatched ${name} event.`);
  }
  return { kind: 'wrapped', ...base };
}
