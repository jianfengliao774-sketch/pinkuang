import { AbiCoder, Interface, ZeroAddress, getAddress, keccak256, verifyTypedData } from 'ethers';

// Official MetaMask Delegation Framework v1.3.0 deployments, BSC chain 56.
// https://github.com/MetaMask/delegation-framework/releases/tag/v1.3.0
// Callers retrieve the three fixed, non-upgradeable runtimes at a canonical
// finalized anchor. The separate wallet-scope assertion checks current support;
// it does NOT attest to historical EIP-7702 account delegation. This module proves
// only the exact protocol result (envelope + unique Factory role event).
// First acceptance additionally needs the historical pre/post Factory prefix;
// finality, receipt canonicality and the complete current graph remain caller
// requirements. A pruned historical query must never be labelled verified.
export const FRESH_DELEGATION_MANAGER = Object.freeze({
  address: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
  codeHash: '0x0029019e237c175ee74871f3d4eab85c196e4ee826c7578bbb4ae054d62d17c6',
});
export const FRESH_DELEGATOR = Object.freeze({
  address: '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B',
  codeHash: '0x2f40923fc79da9330c663341d8a52823ea02372b7da66175a0a9bfc76270d55f',
});
export const FRESH_BALANCE_ENFORCER = Object.freeze({
  address: '0xbD7B277507723490Cd50b12EaaFe87C616be6880',
  codeHash: '0x61f455a893e4dcb39599bfcd8f59000e438c52639b278b933e469610c7761b76',
});
const MANAGER = new Interface(['function redeemDelegations(bytes[] permissionContexts,bytes32[] modes,bytes[] executionCallDatas)']);
const FACTORY = new Interface([
  'function setOperator(address)', 'function setTreasury(address)', 'function transferOwnership(address)',
  'event OperatorChanged(address indexed previousOperator,address indexed newOperator)',
  'event TreasuryChanged(address indexed previousTreasury,address indexed newTreasury)',
  'event OwnershipTransferred(address indexed previousOwner,address indexed newOwner)',
]);
const DELEGATIONS = 'tuple(address delegate,address delegator,bytes32 authority,tuple(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature)[]';
const TYPES = {
  Delegation: [{ name: 'delegate', type: 'address' }, { name: 'delegator', type: 'address' },
    { name: 'authority', type: 'bytes32' }, { name: 'caveats', type: 'Caveat[]' }, { name: 'salt', type: 'uint256' }],
  Caveat: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }],
};
const ABI = AbiCoder.defaultAbiCoder();
const ZERO_MODE = `0x${'00'.repeat(32)}`;
const ROOT = `0x${'ff'.repeat(32)}`;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
function requireThat(ok, reason) { if (!ok) throw new Error(`fresh_activation_execution:${reason}`); }
function address(value, name) {
  requireThat(typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value), name);
  const result = getAddress(value);
  requireThat(result !== ZeroAddress, name);
  return result;
}
function uint(value, name) {
  requireThat(typeof value === 'bigint' || Number.isSafeInteger(value)
    || (typeof value === 'string' && /^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value)), name);
  const result = BigInt(value); requireThat(result >= 0n, name); return result;
}
function safeNumber(value, name) {
  const result = uint(value, name);
  requireThat(result <= BigInt(Number.MAX_SAFE_INTEGER), name);
  return Number(result);
}
function bytes(value, name) { requireThat(typeof value === 'string' && HEX.test(value), name); return value.toLowerCase(); }
function hash(value, name) { requireThat(typeof value === 'string' && HASH.test(value), name); return value.toLowerCase(); }

/** Only the six already-defined Stage 2 role changes. CREATE is intentionally unsupported. */
export function expectedFreshActivationCall(record, step) {
  requireThat(record?.kind === 'fresh-authority' && record.schemaVersion === 1 && record.chainId === 56, 'record');
  const account = address(record.account, 'account');
  const core = address(record.genesis?.factory, 'core_factory');
  const budget = address(record.genesis?.portfolioFactory, 'budget_factory');
  requireThat(!same(core, budget), 'factory_collision');
  const plan = {
    coreOperator: [core, 'setOperator', 'OperatorChanged', record.authorityAddress],
    coreTreasury: [core, 'setTreasury', 'TreasuryChanged', record.authorityAddress],
    budgetOperator: [budget, 'setOperator', 'OperatorChanged', record.authorityAddress],
    budgetTreasury: [budget, 'setTreasury', 'TreasuryChanged', record.authorityAddress],
    coreOwner: [core, 'transferOwnership', 'OwnershipTransferred', record.genesis.timelock],
    budgetOwner: [budget, 'transferOwnership', 'OwnershipTransferred', record.genesis.timelock],
  }[step?.id];
  requireThat(plan, 'unsupported_step');
  const [target, method, eventName, rawNext] = plan;
  const nextAddress = address(rawNext, 'next_address');
  requireThat(!same(account, nextAddress), 'unchanged_role');
  const data = FACTORY.encodeFunctionData(method, [nextAddress]);
  requireThat(same(hash(step.dataHash, 'step_data_hash'), keccak256(data)), 'step_plan');
  return { target, data, previousAddress: account, nextAddress, eventName };
}

function checkExpected(plan, expected) {
  requireThat(expected && same(expected.target, plan.target) && same(expected.data, plan.data)
    && same(expected.previousAddress, plan.previousAddress) && same(expected.nextAddress, plan.nextAddress)
    && expected.eventName === plan.eventName, 'expected_plan');
}
/**
 * Call before first acceptance / a new wrapped signing step. Do not call while
 * replaying previously accepted historical executions: changing or revoking a
 * wallet delegation later must not invalidate an already-completed deployment.
 */
export function assertFreshActivationWalletScope(accountCode) {
  requireThat(same(bytes(accountCode, 'account_code'), `0xef0100${FRESH_DELEGATOR.address.slice(2)}`), 'account_delegation');
  return { delegator: FRESH_DELEGATOR.address };
}
function checkRuntime(proof) {
  requireThat(proof, 'missing_runtime_proof');
  for (const [name, fixed] of [['manager', FRESH_DELEGATION_MANAGER], ['delegator', FRESH_DELEGATOR], ['enforcer', FRESH_BALANCE_ENFORCER]]) {
    requireThat(same(keccak256(bytes(proof[`${name}Code`], `${name}_code`)), fixed.codeHash), `${name}_runtime`);
  }
}
function checkContext(context, account) {
  const [delegations] = ABI.decode([DELEGATIONS], context);
  requireThat(same(ABI.encode([DELEGATIONS], [delegations]), context), 'context_noncanonical');
  requireThat(delegations.length === 1, 'delegation_count');
  const delegation = delegations[0];
  requireThat(same(delegation.delegate, account) && same(delegation.delegator, account)
    && same(delegation.authority, ROOT), 'self_root_delegation');
  requireThat(delegation.caveats.length === 1, 'caveat_count');
  const caveat = delegation.caveats[0];
  requireThat(same(caveat.enforcer, FRESH_BALANCE_ENFORCER.address)
    && same(caveat.terms, `0x01${account.slice(2)}${'00'.repeat(32)}`)
    && caveat.args === '0x', 'balance_caveat');
  requireThat(/^0x[0-9a-fA-F]{130}$/.test(delegation.signature), 'delegation_signature_length');
  const signer = verifyTypedData({ name: 'DelegationManager', version: '1', chainId: 56,
    verifyingContract: FRESH_DELEGATION_MANAGER.address }, TYPES, {
    delegate: delegation.delegate, delegator: delegation.delegator, authority: delegation.authority,
    caveats: [{ enforcer: caveat.enforcer, terms: caveat.terms }], salt: delegation.salt,
  }, delegation.signature);
  requireThat(same(signer, account), 'delegation_signature');
}

function checkSingleWrapper({ account, target, data, tx, input, runtimeProof }) {
  requireThat(same(tx.to, FRESH_DELEGATION_MANAGER.address), 'wrapper_target');
  requireThat(tx.type === 2 && (!tx.authorizationList || tx.authorizationList.length === 0), 'wrapper_type');
  checkRuntime(runtimeProof);
  const decoded = MANAGER.decodeFunctionData('redeemDelegations', input);
  requireThat(same(MANAGER.encodeFunctionData('redeemDelegations', decoded), input), 'wrapper_noncanonical');
  const [contexts, modes, executions] = decoded;
  requireThat(contexts.length === 1 && modes.length === 1 && executions.length === 1, 'execution_count');
  requireThat(same(modes[0], ZERO_MODE), 'execution_mode');
  checkContext(contexts[0], account);
  requireThat(same(executions[0], `0x${target.slice(2)}${'00'.repeat(32)}${data.slice(2)}`), 'inner_execution');
  return { kind: 'wrapped', manager: FRESH_DELEGATION_MANAGER.address,
    delegator: FRESH_DELEGATOR.address, contextHash: keccak256(contexts[0]) };
}

/** Exact direct call or the fixed, signed MetaMask single-call envelope. No result is inferred from calldata alone. */
export function decodeFreshSingleCallEnvelope({ account: rawAccount, target: rawTarget, data: rawData, tx, receipt, runtimeProof }) {
  const account = address(rawAccount, 'account'), target = address(rawTarget, 'target'), data = bytes(rawData, 'expected_data');
  requireThat(tx && receipt, 'missing_transaction');
  requireThat(uint(tx.chainId, 'chain') === 56n && same(tx.from, account), 'transaction_identity');
  requireThat(uint(tx.value, 'value') === 0n, 'outer_value');
  const transactionHash = hash(tx.hash, 'tx_hash');
  requireThat(same(transactionHash, hash(receipt.hash ?? receipt.transactionHash, 'receipt_hash')), 'receipt_transaction');
  requireThat(same(receipt.from, tx.from) && same(receipt.to, tx.to), 'receipt_identity');
  requireThat(uint(receipt.blockNumber, 'receipt_block') > 0n
    && uint(tx.blockNumber, 'tx_block') === uint(receipt.blockNumber, 'receipt_block')
    && same(hash(tx.blockHash, 'tx_block_hash'), hash(receipt.blockHash, 'receipt_block_hash')), 'receipt_block_binding');
  requireThat(receipt.status === 0 || receipt.status === 1, 'receipt_status');
  const input = bytes(tx.data, 'transaction_data');
  const base = { transactionHash, target, innerDataHash: keccak256(data),
    nonce: safeNumber(tx.nonce, 'tx_nonce'), blockNumber: safeNumber(receipt.blockNumber, 'receipt_block'),
    blockHash: receipt.blockHash, status: receipt.status };
  if (same(tx.to, target)) {
    requireThat(same(input, data), 'direct_data');
    return { ...base, kind: 'direct' };
  }
  return { ...base, ...checkSingleWrapper({ account, target, data, tx, input, runtimeProof }) };
}

/**
 * Exact envelope identity, including reverted transactions. A reverted envelope
 * does not prove execution: callers must verify unchanged pre/post permission
 * prefix before allowing a retry. Candidate hash can differ from the original
 * step.txHash (same-nonce speed-up), but must match the fetched receipt exactly.
 */
export function decodeFreshActivationEnvelope({ record, step, tx, receipt, expected, runtimeProof }) {
  const plan = expectedFreshActivationCall(record, step);
  checkExpected(plan, expected);
  requireThat(tx && receipt, 'missing_transaction');
  requireThat(uint(tx.chainId, 'chain') === 56n && same(tx.from, record.account), 'transaction_identity');
  requireThat(uint(tx.nonce, 'tx_nonce') === uint(step.nonce, 'step_nonce'), 'nonce');
  requireThat(uint(tx.value, 'value') === 0n, 'outer_value');
  const transactionHash = hash(tx.hash, 'tx_hash');
  requireThat(same(transactionHash, hash(receipt.hash ?? receipt.transactionHash, 'receipt_hash')), 'receipt_transaction');
  requireThat(same(receipt.from, tx.from) && same(receipt.to, tx.to), 'receipt_identity');
  requireThat(uint(receipt.blockNumber, 'receipt_block') > 0n
    && uint(tx.blockNumber, 'tx_block') === uint(receipt.blockNumber, 'receipt_block')
    && same(hash(tx.blockHash, 'tx_block_hash'), hash(receipt.blockHash, 'receipt_block_hash')), 'receipt_block_binding');
  requireThat(receipt.status === 0 || receipt.status === 1, 'receipt_status');
  const input = bytes(tx.data, 'transaction_data');
  const base = { transactionHash, target: plan.target, innerDataHash: keccak256(plan.data),
    nonce: safeNumber(step.nonce, 'step_nonce'), blockNumber: safeNumber(receipt.blockNumber, 'receipt_block'),
    blockHash: receipt.blockHash, status: receipt.status };
  if (same(tx.to, plan.target)) {
    requireThat(same(input, plan.data), 'direct_data');
    return { ...base, kind: 'direct' };
  }
  // The observed wallet sends type 2 after installing its delegation. Supporting
  // type 4 would also require proving every authorization; fail closed here.
  return { ...base, ...checkSingleWrapper({ account: record.account, target: plan.target, data: plan.data, tx, input, runtimeProof }) };
}

/** Successful execution additionally needs one exact Factory role change event. */
export function verifyFreshActivationExecution(input) {
  const result = decodeFreshActivationEnvelope(input);
  const { record, receipt } = input;
  const expected = expectedFreshActivationCall(record, input.step);
  requireThat(receipt.status === 1, 'execution_reverted');
  requireThat(Array.isArray(receipt.logs), 'receipt_logs');
  const roleTopics = ['OperatorChanged', 'TreasuryChanged', 'OwnershipTransferred']
    .map(name => FACTORY.getEvent(name).topicHash.toLowerCase());
  const logs = receipt.logs.filter(log => [record.genesis.factory, record.genesis.portfolioFactory]
    .some(factory => same(log.address, factory)) && roleTopics.includes(log.topics?.[0]?.toLowerCase()));
  requireThat(logs.length === 1, 'role_event_count');
  const log = logs[0];
  const encoded = FACTORY.encodeEventLog(FACTORY.getEvent(expected.eventName), [expected.previousAddress, expected.nextAddress]);
  requireThat(same(log.address, expected.target) && log.removed !== true
    && same(log.transactionHash, result.transactionHash) && same(log.blockHash, receipt.blockHash)
    && uint(log.blockNumber, 'log_block') === uint(receipt.blockNumber, 'receipt_block'), 'event_binding');
  requireThat(log.topics.length === encoded.topics.length && log.topics.every((topic, i) => same(topic, encoded.topics[i]))
    && same(log.data, encoded.data), 'role_event');
  return { ...result, eventName: expected.eventName, previousAddress: expected.previousAddress,
    nextAddress: expected.nextAddress };
}
