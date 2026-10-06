import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, getCreateAddress, keccak256, toUtf8Bytes } from 'ethers';
import { buildDigest, evidenceDigest } from './firsto-upgrade-proof.mjs';
import { createTargetOwnerFixture } from './target-owner-upgrade-test-fixture.mjs';
import { FIRSTO_BATCH_REVIEW_KIND, FIRSTO_BATCH_UPGRADE_KIND, firstoBatchPredecessor,
  firstoBatchUpgradeDeploymentOrder, reviewedFirstoBatchProtocol, buildFirstoBatchUpgradePlan } from './firsto-batch-upgrade-plan.mjs';

const hash = value => keccak256(toUtf8Bytes(value));
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const abi = new Interface([
  'function implementation() view returns(address)', 'function firstoBatchPurchaseVersion() pure returns(uint16)',
  'function hashOperation(address,uint256,bytes,bytes32,bytes32) view returns(bytes32)',
  'function isOperation(bytes32) view returns(bool)', 'function isOperationReady(bytes32) view returns(bool)',
  'function isOperationDone(bytes32) view returns(bool)', 'function getTimestamp(bytes32) view returns(uint256)',
  'event CallScheduled(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data,bytes32 predecessor,uint256 delay)',
  'event CallSalt(bytes32 indexed id,bytes32 salt)',
  'event CallExecuted(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data)',
  'event Upgraded(address indexed implementation)',
]);

/** Synthetic successor linker/provider fixture only. No endpoints, credentials, transactions or deployment approval.
 * The protocol runtime bytes exercise the fixed raw pin; source/fill review flags are independently pinned TEST claims.
 */
export function createFirstoBatchFixture({ phase = 'done', waiting = false, splitMarkets = false, predecessorFixture } = {}) {
  const core = predecessorFixture ?? createTargetOwnerFixture({ phase: 'done', splitMarkets });
  const input = { ...core.input, priorCoreCatalog: structuredClone(core.finalCatalog), priorCoreBundle: structuredClone(core.input.upgradeBundle),
    trustedPriorCoreCatalogDigest: evidenceDigest(core.finalCatalog), salt: hash('firsto-batch-synthetic-review'), delaySeconds: 172800 };
  const prior = firstoBatchPredecessor(input);
  input.upgradeBundle = structuredClone(core.input.upgradeBundle);
  for (const name of firstoBatchUpgradeDeploymentOrder) {
    // Deliberately distinct synthetic code while preserving exact linker/immutable locations.
    input.upgradeBundle.artifacts[name].bytecode += '6001';
    input.upgradeBundle.artifacts[name].deployedBytecode += '6001';
  }
  input.upgradeBundle.artifacts.PoolVault.abi.push(JSON.parse(abi.getFunction('firstoBatchPurchaseVersion').format('json')));
  input.trustedUpgradeArtifactDigest = buildDigest(input.upgradeBundle);
  input.protocolReview = { kind: 'firsto-batch-exact-source-review-v1', chainId: 56, ...reviewedFirstoBatchProtocol,
    exactRuntimeMatch: true, localFillVerified: true, testFixture: 'synthetic flags, never external provenance' };
  input.trustedProtocolReviewDigest = evidenceDigest(input.protocolReview);
  input.reviewCatalog = { schemaVersion: 1, kind: FIRSTO_BATCH_REVIEW_KIND, chainId: 56, profile: core.finalCatalog.profile,
    priorCoreCatalogDigest: input.trustedPriorCoreCatalogDigest, candidateArtifactDigest: input.trustedUpgradeArtifactDigest,
    protocolReviewDigest: input.trustedProtocolReviewDigest, anchor: { blockNumber: 500, blockHash: hash('batch-block500') },
    nodes: structuredClone(prior.nodes), bindings: structuredClone(prior.baseline.catalog.bindings),
    authority: structuredClone(prior.baseline.catalog.authority), deployer: prior.baseline.catalog.deployer };
  input.trustedReviewCatalogDigest = evidenceDigest(input.reviewCatalog);
  const replacements = Object.fromEntries(firstoBatchUpgradeDeploymentOrder.map((name, index) => [name,
    getCreateAddress({ from: input.reviewCatalog.deployer, nonce: 30 + index })]));
  const plan = buildFirstoBatchUpgradePlan({ ...input, replacements });
  const codes = core.codes, blocks = core.blocks, transactions = core.transactions, receipts = core.receipts, deployments = {};
  for (const row of plan.deployments) codes.set(row.address.toLowerCase(), row.expectedRuntime);
  const protocolRuntime = readFileSync(new URL('../../contracts/test/fixtures/firsto-batch-observed-runtime.hex', import.meta.url), 'utf8').trim();
  assert.equal(keccak256(protocolRuntime), reviewedFirstoBatchProtocol.runtimeCodehash);
  codes.set(reviewedFirstoBatchProtocol.exchange.toLowerCase(), protocolRuntime);
  for (const number of [500, 610, 611, 620, 779, 780, 790, 800]) blocks.set(number, { number, hash: hash(`batch-block${number}`),
    timestamp: number === 620 ? 400000 : number === 780 ? 572800 : number === 800 ? waiting ? 450000 : 600000
      : number < 620 ? 350000 : 580000, transactions: [] });
  const addTx = (label, number, from, to, data, contractAddress = null, nonce = 0) => {
    const txHash = hash(`batch-${label}`), block = blocks.get(number);
    const tx = { hash: txHash, chainId: 56n, from, to, value: 0n, data, nonce, blockNumber: number, blockHash: block.hash, index: 0 };
    const receipt = { hash: txHash, from, to, status: 1, contractAddress, blockNumber: number, blockHash: block.hash, index: 0, logs: [] };
    block.transactions = [txHash]; transactions.set(txHash, tx); receipts.set(txHash, receipt); return txHash;
  };
  for (const [index, name] of firstoBatchUpgradeDeploymentOrder.entries()) {
    const row = plan.deployments[index], txHash = addTx(name, 610 + index, input.reviewCatalog.deployer, null, row.data, row.address, 30 + index);
    deployments[name] = { address: row.address, txHash };
  }
  const scheduleTxHash = addTx('schedule', 620, input.reviewCatalog.bindings.proposer, plan.timelock, plan.scheduleData);
  const executeTxHash = addTx('execute', 780, '0x0000000000000000000000000000000000004444', plan.timelock, plan.executeData);
  const event = (txHash, to, name, values, index) => {
    const receipt = receipts.get(txHash), encoded = abi.encodeEventLog(abi.getEvent(name), values);
    receipt.logs.push({ ...encoded, address: to, transactionHash: txHash, blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber, index, transactionIndex: receipt.index, removed: false });
  };
  event(scheduleTxHash, plan.timelock, 'CallScheduled', [plan.operationId, 0n, plan.target, 0n, plan.data, plan.predecessor, 172800n], 0);
  event(scheduleTxHash, plan.timelock, 'CallSalt', [plan.operationId, plan.salt], 1);
  event(executeTxHash, plan.timelock, 'CallExecuted', [plan.operationId, 0n, plan.target, 0n, plan.data], 0);
  event(executeTxHash, plan.target, 'Upgraded', [replacements.PoolVault], 1);
  const state = { phase, waiting, batchVersion: 1n }, originalSend = core.provider.send, originalGetBlock = core.provider.getBlock;
  const provider = { ...core.provider,
    async getBlock(tag) { core.calls.push(['batchGetBlock', tag]); return tag === 'finalized' ? structuredClone(blocks.get(800)) : originalGetBlock(tag); },
    async send(method, args) {
      if (method !== 'eth_call') return originalSend(method, args);
      const parsed = abi.parseTransaction({ data: args[0].data });
      const block = Number(BigInt(args[1]));
      if (parsed?.name === 'implementation' && same(args[0].to, plan.target)) {
        core.calls.push(['batchImplementation', block]);
        return abi.encodeFunctionResult('implementation', [state.phase === 'done' && block >= 780 ? replacements.PoolVault
          : block >= 380 ? core.replacements.PoolVault : core.input.reviewCatalog.nodes.PoolVault.address]);
      }
      if (parsed?.name === 'firstoBatchPurchaseVersion') return abi.encodeFunctionResult(parsed.name, [state.batchVersion]);
      if (parsed?.name === 'hashOperation' && same(parsed.args[4], plan.salt)) return abi.encodeFunctionResult(parsed.name, [plan.operationId]);
      if (['isOperation', 'isOperationReady', 'isOperationDone', 'getTimestamp'].includes(parsed?.name) && same(parsed.args[0], plan.operationId)) {
        const value = parsed.name === 'isOperation' ? state.phase !== 'unscheduled' : parsed.name === 'isOperationReady' ? state.phase === 'scheduled' && !state.waiting
          : parsed.name === 'isOperationDone' ? state.phase === 'done' : state.phase === 'done' ? 1n : state.phase === 'unscheduled' ? 0n : 572800n;
        return abi.encodeFunctionResult(parsed.name, [value]);
      }
      return originalSend(method, args);
    },
  };
  const options = { phase, deployments, plan, scheduleTxHash, executeTxHash };
  const finalCatalog = { schemaVersion: 1, kind: FIRSTO_BATCH_UPGRADE_KIND, chainId: 56, profile: 'full-test', reviewCatalog: input.reviewCatalog,
    reviewCatalogDigest: input.trustedReviewCatalogDigest, candidateArtifactDigest: input.trustedUpgradeArtifactDigest, deployments,
    salt: input.salt, delaySeconds: input.delaySeconds, operation: { scheduleTxHash, executeTxHash },
    verification: { blockNumber: 790, blockHash: hash('batch-block790') } };
  return { input, provider, state, options, plan, codes, blocks, transactions, receipts, deployments, replacements, finalCatalog,
    core, calls: core.calls, scheduleTxHash, executeTxHash };
}
