import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, ZeroAddress, getAddress, keccak256 } from 'ethers';
import { validateFreshSalePolicyCatalog, verifyFreshSalePolicy, freshSalePolicyOperation } from './fresh-sale-policy-proof.mjs';

const catalog = JSON.parse(readFileSync(new URL('../../web/public/data/sale-policy-upgrade.full-test.json', import.meta.url)));
// A self-contained approved bundle fixture preserves the catalog's complete-artifact digest.
import { buildDigest } from './firsto-upgrade-proof.mjs';
const artifactBundle = { sourceCommit: 'a'.repeat(40), artifacts: catalog.artifacts };
const approved = { ...catalog, candidateArtifactDigest: buildDigest(artifactBundle) };
import { freshSalePolicySalt } from './fresh-sale-policy-proof.mjs';
approved.salt = freshSalePolicySalt(approved.bindings.factory, approved.candidateArtifactDigest);
const address = n => getAddress('0x' + n.toString(16).padStart(40, '0'));
const hash = n => '0x' + n.toString(16).padStart(64, '0');
const block = { number: 100, hash: hash(100) };
const view = new Interface(['function implementation() view returns(address)', 'function OFFICIAL_FACTORY() view returns(address)',
  'function saleReviewThresholdBps() view returns(uint16)', 'function automaticSaleReferenceVersion() view returns(uint8)',
  'function saleReferencePublisher() view returns(address)', 'function hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32) view returns(bytes32)',
  'function isOperationDone(bytes32) view returns(bool)']);

function fixture() {
  const addresses = { ...approved.bindings, ...approved.libraries, ...approved.expectedImplementations };
  const trusted = { record: { addresses, artifactDigest: approved.genesisArtifactDigest,
    input: { ownerMultisig: approved.bindings.proposer } }, bundle: { artifacts: { FreshPoolFactory: {} } },
    freshAuthority: { authority: { address: approved.bindings.authority, gasWallet: approved.bindings.gasWallet } } };
  trusted.freshSalePolicy = validateFreshSalePolicyCatalog(approved, artifactBundle, trusted);
  const replacements = { SaleGovernance: address(91), PoolVault: address(92), BudgetPortfolioVault: address(93), ShareMarket: address(94) };
  const operation = freshSalePolicyOperation(approved, replacements);
  const linked = { ...addresses, ...replacements }, codes = {};
  for (const [name, artifact] of Object.entries(approved.artifacts)) {
    let code = artifact.deployedBytecode.slice(2);
    for (const links of Object.values(artifact.deployedLinkReferences ?? {})) for (const [library, locations] of Object.entries(links))
      for (const { start, length } of locations) code = code.slice(0, start * 2) + linked[library].slice(2) + code.slice((start + length) * 2);
    if (name === 'SaleGovernance' && code.startsWith('73' + '0'.repeat(40))) code = '73' + replacements[name].slice(2) + code.slice(42);
    codes[name] = '0x' + code;
  }
  const state = { genesis: false, mixed: false, badCode: false, badFactory: false, badPublisher: false,
    threshold: 8000n, version: 1n, done: true, badOperation: false, reorg: false, codeCalls: 0 };
  const provider = {
    getStorage: async () => '0x' + (state.genesis ? addresses.ShareMarket : replacements.ShareMarket).slice(2).padStart(64, '0'),
    getBlock: async number => ({ number, hash: state.reorg ? hash(101) : hash(number) }),
    getCode: async to => { state.codeCalls++; const name = Object.keys(replacements).find(key => replacements[key] === to);
      return codes[name] + (state.badCode && name === 'PoolVault' ? '00' : ''); },
    send: async (method, [tx, tag]) => {
      assert.equal(method, 'eth_call'); assert.equal(tag, '0x64');
      const parsed = view.parseTransaction(tx); let value;
      if (parsed.name === 'implementation') value = tx.to === addresses.beacon
        ? state.genesis || state.mixed ? addresses.PoolVault : replacements.PoolVault
        : state.genesis ? addresses.BudgetPortfolioVault : replacements.BudgetPortfolioVault;
      if (parsed.name === 'OFFICIAL_FACTORY') value = state.badFactory ? ZeroAddress
        : tx.to === replacements.PoolVault ? addresses.factory : addresses.portfolioFactory;
      if (parsed.name === 'saleReviewThresholdBps') value = state.threshold;
      if (parsed.name === 'automaticSaleReferenceVersion') value = state.version;
      if (parsed.name === 'saleReferencePublisher') value = state.badPublisher ? ZeroAddress : approved.bindings.gasWallet;
      if (parsed.name === 'hashOperationBatch') value = state.badOperation ? hash(99) : operation.operationId;
      if (parsed.name === 'isOperationDone') value = state.done;
      assert.notEqual(value, undefined); return view.encodeFunctionResult(parsed.name, [value]);
    },
  };
  return { trusted, replacements, codes, state, provider, operation };
}

test('catalog pins preserved graph, full candidate bytes, library addresses and deterministic salt', () => {
  const f = fixture();
  for (const change of [c => c.bindings.factory = address(9), c => c.expectedImplementations.ShareMarket = address(9),
    c => c.libraries.FirstoSale = address(9), c => c.salt = hash(9), c => c.artifacts.ShareMarket.deployedBytecode += '00']) {
    const altered = structuredClone(approved); change(altered);
    assert.throws(() => validateFreshSalePolicyCatalog(altered, artifactBundle, f.trusted));
  }
  assert.throws(() => validateFreshSalePolicyCatalog(approved, artifactBundle, { ...f.trusted, freshAuthority: null }), /preserved/);
});

test('old graph stays on genesis; mixed graph cannot become an approved policy', async () => {
  const f = fixture(); f.state.genesis = true;
  assert.equal(await verifyFreshSalePolicy(f.provider, f.trusted, block), null); assert.equal(f.state.codeCalls, 0);
  f.state.genesis = false; f.state.mixed = true;
  await assert.rejects(verifyFreshSalePolicy(f.provider, f.trusted, block), /incomplete/); assert.equal(f.state.codeCalls, 0);
});

test('only complete exact candidates with the fixed executed batch and business bindings activate', async () => {
  const f = fixture(), result = await verifyFreshSalePolicy(f.provider, f.trusted, block);
  assert.deepEqual(result.replacements, f.replacements); assert.equal(result.operationId, f.operation.operationId);
  assert.equal(result.saleReviewThresholdBps, 8000); assert.equal(result.codehash.PoolVault, keccak256(f.codes.PoolVault));
  assert.equal(f.state.codeCalls, 4);
  assert.equal(await verifyFreshSalePolicy(f.provider, f.trusted, block), result); assert.equal(f.state.codeCalls, 4);
  f.state.reorg = true; await assert.rejects(verifyFreshSalePolicy(f.provider, f.trusted, block), /anchor changed/);
  for (const change of [s => s.badCode = true, s => s.badFactory = true, s => s.badPublisher = true,
    s => s.threshold = 10000n, s => s.version = 0n, s => s.done = false, s => s.badOperation = true]) {
    const wrong = fixture(); change(wrong.state); await assert.rejects(verifyFreshSalePolicy(wrong.provider, wrong.trusted, block));
  }
});
