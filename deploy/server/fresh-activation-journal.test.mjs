import assert from 'node:assert/strict';
import test from 'node:test';
import { FRESH_ACTIVATION_STEPS, FRESH_ADMIN_ONE, FRESH_ADMIN_TWO,
  validateFreshActivation, validateFreshActivationProgress } from './fresh-activation-journal.mjs';

const address = digit => `0x${digit.repeat(40)}`;
const hash = digit => `0x${digit.repeat(64)}`;
const hardware = address('1'), gasWallet = address('2'), factory = address('3');
const portfolioFactory = address('4'), timelock = address('5');
const shareMarket=address('6'),portfolioShareMarket=address('7');
const codehash={factory:hash('1'),portfolioFactory:hash('2'),shareMarket:hash('3'),
  portfolioMarket:hash('4'),timelock:hash('5')};
const genesis = { id: 'fresh-graph', status: 'complete', kind: 'integrated-v2', account: hardware,
  artifactDigest: hash('a'), input: { ownerMultisig: hardware, operator: hardware, treasury: hardware },
  addresses: { factory, portfolioFactory, timelock, shareMarket, portfolioShareMarket },
  verification:{code:Object.fromEntries(Object.entries({factory:'factory',portfolioFactory:'portfolioFactory',
    shareMarket:'shareMarket',portfolioMarket:'portfolioShareMarket',timelock:'timelock'})
    .map(([key,name])=>[name,{codehash:codehash[key]}]))}};
const make = () => ({ schemaVersion: 1, kind: 'fresh-authority', chainId: 56,
  account: hardware, deploymentId: genesis.id, genesisArtifactDigest: genesis.artifactDigest,
  genesis: { factory, portfolioFactory, timelock, shareMarket, portfolioMarket:portfolioShareMarket,
    codehash }, administratorOne: FRESH_ADMIN_ONE,
  administratorTwo: FRESH_ADMIN_TWO, gasWallet, createdAt: '2026-09-29T00:00:00Z',
  updatedAt: '2026-09-29T00:00:00Z', maxGasBudgetBnb: '0.05', gasPriceCapGwei: '3',
  spentWei: '0', status: 'ready', steps: FRESH_ACTIVATION_STEPS.map(id => ({ id, status: 'waiting' })) });

test('fresh activation journal is tied to exact complete genesis and configured Gas wallet', () => {
  const record = make();
  assert.equal(validateFreshActivation(record, hardware, genesis, gasWallet), record);
  assert.throws(() => validateFreshActivation(record, hardware, genesis, undefined), /Invalid/);
  assert.throws(() => validateFreshActivation(record, hardware, genesis, address('6')), /Invalid/);
  assert.throws(() => validateFreshActivation(record, hardware, { ...genesis, status: 'aborted' }, gasWallet), /Invalid/);
  assert.throws(() => validateFreshActivation({ ...record, gasWallet: FRESH_ADMIN_ONE }, hardware, genesis, FRESH_ADMIN_ONE), /Invalid/);
});

test('write-ahead nonce and hashes cannot be erased or changed on reload', () => {
  const before = make();
  before.steps[0] = { id: 'deployAuthority', status: 'signing', nonce: 12, dataHash: hash('b'),
    gasLimit:'4000000',gasPriceWei:'1000000000',maxFeeWei:'4000000000000000' };
  const next = structuredClone(before);
  next.steps[0].status = 'submitted'; next.steps[0].txHash = hash('c');
  assert.doesNotThrow(() => validateFreshActivationProgress(before, next));
  const forgedRecovery = structuredClone(before);
  forgedRecovery.steps[0].status = 'rejected';
  forgedRecovery.steps[0].rejectionKind = 'nonce-witnessed';
  assert.throws(() => validateFreshActivationProgress(before, forgedRecovery), /progress changed/);
  const erased = structuredClone(next); delete erased.steps[0].txHash;
  assert.throws(() => validateFreshActivationProgress(next, erased), /progress changed/);
  const rewound = structuredClone(next); rewound.steps[0].status = 'waiting';
  assert.throws(() => validateFreshActivationProgress(next, rewound), /progress changed/);
  const retarget = structuredClone(next); retarget.genesis.factory = address('6');
  assert.throws(() => validateFreshActivationProgress(next, retarget), /progress changed/);
});

test('same-payload acceleration preserves the old hash and finalized receipt', () => {
  const before=make();
  before.steps[0]={id:'deployAuthority',status:'submitted',nonce:12,dataHash:hash('b'),
    txHash:hash('c'),gasLimit:'4000000',gasPriceWei:'1000000000',maxFeeWei:'4000000000000000'};
  const next=structuredClone(before);
  next.steps[0]={...before.steps[0],status:'confirmed',txHash:hash('d'),
    previousTxHashes:[hash('c')],finalizedRecovery:true,
    receipt:{blockNumber:100,blockHash:hash('e'),status:1,gasUsed:'1000000',
      gasPrice:'1000000000',feeWei:'1000000000000000'}};
  next.spentWei=next.steps[0].receipt.feeWei;
  assert.doesNotThrow(()=>validateFreshActivation(next,hardware,genesis,gasWallet));
  assert.doesNotThrow(()=>validateFreshActivationProgress(before,next));
  const erased=structuredClone(next);erased.steps[0].previousTxHashes=[];
  assert.throws(()=>validateFreshActivationProgress(next,erased),/progress changed/);
  const unproven=structuredClone(next);unproven.steps[0].finalizedRecovery=false;
  assert.throws(()=>validateFreshActivationProgress(before,unproven),/progress changed/);
});
