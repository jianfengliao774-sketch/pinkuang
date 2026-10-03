import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, ZeroAddress } from 'ethers';
import { dataFixture, chainFixture, MINING, MARKET, config, seller, blockHash } from './operator-quotes-fixture.mjs';
import { loadOperatorQuote, operatorQuoteDraft } from '../lib/operator-quotes.mjs';
import { checkedDesignatedCreation, designatedFactoryAbi, designatedVaultAbi,
  readDesignatedPurchaseTerms, designatedPurchaseEnabled, DESIGNATED_PURCHASE_MODE } from '../lib/designated-purchase.mjs';
import { authorityAction, approvedOperatorCall } from '../lib/authority-client.mjs';
import { operatorCreateInput } from '../lib/operator-create-input.mjs';

const economics = new Interface(['function currentRate() view returns(uint256)',
  'function totalVerifWeight() view returns(uint256)', 'function UNVERIFIED_BPS() view returns(uint16)']);
const flagged = { ...config, designatedPurchaseFallback: true, displayOnly: true };
const listingProof = new Interface(['function listingView(uint256) view returns(address seller,address circuits,uint256 tokenId,uint96 price,uint16 feeBps,bool valid)']);
const approvals = new Interface(['function getApproved(uint256) view returns(address)', 'function isApprovedForAll(address,address) view returns(bool)']);

function providerFixture({ version = 1n, reorg = false, revoked = false, inconsistentListing = false } = {}) {
  const data = dataFixture(), old = chainFixture(data.quote), requests = [];
  const values = { currentRate: 100n, totalVerifWeight: 100n, UNVERIFIED_BPS: 101n };
  const provider = { async request(input) {
    requests.push(input);
    if (input.method === 'eth_call') {
      assert.equal(input.params[1], '0x64');
      const [tx] = input.params;
      if (tx.to.toLowerCase() === MARKET.toLowerCase() && listingProof.parseTransaction(tx))
        return listingProof.encodeFunctionResult('listingView', [seller, data.quote.collection,
          inconsistentListing ? BigInt(data.quote.tokenId) + 1n : data.quote.tokenId, old.listing.price, 100n, true]);
      if (tx.to.toLowerCase() === data.quote.collection.toLowerCase()) {
        const parsed = approvals.parseTransaction(tx);
        if (parsed?.name === 'getApproved') return approvals.encodeFunctionResult(parsed.fragment, [revoked ? ZeroAddress : MARKET]);
        if (parsed?.name === 'isApprovedForAll') return approvals.encodeFunctionResult(parsed.fragment, [false]);
      }
      if (tx.to.toLowerCase() === MINING.toLowerCase()) {
        const parsed = economics.parseTransaction(tx);
        if (parsed) return economics.encodeFunctionResult(parsed.fragment, [values[parsed.name]]);
      }
      if (tx.to === config.factory && tx.data === designatedFactoryAbi.encodeFunctionData('designatedPurchaseVersion'))
        return designatedFactoryAbi.encodeFunctionResult('designatedPurchaseVersion', [version]);
    }
    const value = await old.provider.request(input);
    if (input.method === 'eth_getBlockByNumber') return { ...value,
      timestamp: `0x${BigInt(Math.floor(Date.now() / 1000)).toString(16)}`,
      ...(reorg && requests.length > 12 ? { hash: `0x${'ff'.repeat(32)}` } : {}) };
    return value;
  } };
  return { data, provider, requests };
}

test('new designated official selection freezes chain-derived daily yield without any Firsto request', async () => {
  const { data, provider, requests } = providerFixture();
  const checked = await loadOperatorQuote({ provider, config: flagged, collection: data.quote.collection,
    tokenId: data.quote.tokenId, mode: DESIGNATED_PURCHASE_MODE, forCreation: true,
    fetcher: () => assert.fail('No paid quote or whole-market API is needed for this official listing') });
  // floor(100 - floor(100*101/10000)) *61/100 = floor(99*61/100) =60 per sec.
  assert.equal(checked.designatedBaseline.dailyOutputAtomic, String(60n * 86400n));
  assert.equal(checked.reference, null);
  assert.equal(checked.designatedBaseline.blockHash, blockHash);
  const draft = operatorQuoteDraft(checked, { mode: DESIGNATED_PURCHASE_MODE });
  assert.equal(draft.designated.referencePriceWei, checked.chain.official.priceWei);
  assert.equal(draft.designated.referenceCostWei, checked.chain.official.priceWei);
  assert.equal(draft.designated.referenceSeller, seller);
  const c0 = BigInt(draft.designated.referenceCostWei), cap = (11n * c0 + 9n) / 10n;
  assert.equal(BigInt(draft.params.priceCapWei), cap);
  assert.equal(BigInt(draft.params.targetRaiseWei), (cap + 99n) / 100n * 100n);
  assert(requests.filter(r => r.method === 'eth_call').every(r => r.params[1] === '0x64'));
});

test('new mode rejects old capability and block changes; it never falls back to API daily estimates', async () => {
  for (const options of [{ version: 0n }, { reorg: true }]) {
    const { data, provider } = providerFixture(options);
    await assert.rejects(loadOperatorQuote({ provider, config: flagged, collection: data.quote.collection,
      tokenId: data.quote.tokenId, mode: DESIGNATED_PURCHASE_MODE, forCreation: true,
      fetcher: () => assert.fail('No paid request after failed chain proof') }));
  }
  await assert.rejects(loadOperatorQuote({ config, mode: DESIGNATED_PURCHASE_MODE,
    provider: { request: () => assert.fail('Old unflagged graph must reject before any read') } }));
  assert.equal(designatedPurchaseEnabled({ ...flagged, manifest: { chainId: 56 }, status: 'ready',
    stage: 'fresh-active', freshFactoryVerified: true }), false,
  'A configuration flag cannot activate the existing production artifact');
});

test('designated original quote requires consistent listing identity and current NFT approval', async () => {
  const bad = providerFixture({ inconsistentListing: true });
  await assert.rejects(loadOperatorQuote({ provider: bad.provider, config: flagged,
    collection: bad.data.quote.collection, tokenId: bad.data.quote.tokenId, mode: DESIGNATED_PURCHASE_MODE,
    fetcher: () => assert.fail('Conflicting chain records must fail before paid discovery') }), /不一致/);
  const revoked = providerFixture({ revoked: true }); let discoveries = 0;
  await assert.rejects(loadOperatorQuote({ provider: revoked.provider, config: flagged,
    collection: revoked.data.quote.collection, tokenId: revoked.data.quote.tokenId, mode: DESIGNATED_PURCHASE_MODE,
    fetcher: async () => { ++discoveries; throw new Error('exact-order-unavailable'); } }), /exact-order-unavailable/);
  assert.equal(discoveries, 1, 'A revoked official order must not become the immutable price basis');
});

test('immutable quote reaches canonical creation and distinct administrator signature without rounding', async () => {
  const { data, provider } = providerFixture();
  const checked = await loadOperatorQuote({ provider, config: flagged, collection: data.quote.collection,
    tokenId: data.quote.tokenId, mode: DESIGNATED_PURCHASE_MODE, forCreation: true });
  const draft = operatorQuoteDraft(checked, { mode: DESIGNATED_PURCHASE_MODE });
  assert.throws(() => operatorQuoteDraft({ ...checked, designatedBaseline: { ...checked.designatedBaseline,
    observedAt: String(Math.floor(Date.now() / 1000) - 301) } }, { mode: DESIGNATED_PURCHASE_MODE }), /过期/);
  const params = { circuits: draft.params.circuits, circuitId: draft.params.circuitId,
    targetRaise: draft.params.targetRaiseWei, priceCap: draft.params.priceCapWei,
    directSeller: ZeroAddress, directPrice: '0', fundingDeadline: '2000000000', purchaseDeadline: '2000003600' };
  const input = { factory: config.factory, from: seller, params, config: draft.designated,
    expectedTaskId: draft.expectedTaskId, expectedReferenceWeight: draft.expectedReferenceWeight };
  const tx = checkedDesignatedCreation(input);
  const active = { ...flagged, stage: 'fresh-active', portfolioFactory: '0x0000000000000000000000000000000000000501' };
  const approved = approvedOperatorCall(active, tx);
  const action = authorityAction('0x0000000000000000000000000000000000000801', 'executeApprovedOperation', approved, '1', '2000000000');
  assert.equal(action.primaryType, 'CreateDesignatedPool');
  assert.equal(action.message.config.referenceDigest, draft.designated.referenceDigest);
  assert.equal(action.message.config.referenceDailyOutputAtomic, draft.designated.referenceDailyOutputAtomic);
  assert.throws(() => checkedDesignatedCreation({ ...input, params: { ...params, priceCap: String(BigInt(params.priceCap) + 1n) } }));
  assert.throws(() => checkedDesignatedCreation({ ...input, config: { ...draft.designated, referencePriceWei: 1.5 } }));
  assert.equal(operatorCreateInput({ form: {}, mode: DESIGNATED_PURCHASE_MODE }).valid, false);
});

test('member subscription preview reads immutable opt-in terms once; unknown terms fail closed', async () => {
  const { data, provider } = providerFixture();
  const checked = await loadOperatorQuote({ provider, config: flagged, collection: data.quote.collection,
    tokenId: data.quote.tokenId, mode: DESIGNATED_PURCHASE_MODE, forCreation: true });
  const draft = operatorQuoteDraft(checked, { mode: DESIGNATED_PURCHASE_MODE });
  let count = 0;
  const reader = { async request({ method, params }) {
    assert.equal(method, 'eth_call'); assert.equal(params[1], 'latest'); ++count;
    return designatedVaultAbi.encodeFunctionResult('designatedPurchase', [true, '16480', '220', '61', draft.designated]);
  } };
  const terms = await readDesignatedPurchaseTerms(reader, flagged, config.factory);
  assert.match(terms.terms, /90%–110%/); assert.match(terms.terms, /到期可退款/); assert.equal(count, 1);
  assert.equal(await readDesignatedPurchaseTerms(reader, config, config.factory), null); assert.equal(count, 1);
  await assert.rejects(readDesignatedPurchaseTerms({ request: async () => '0x' }, flagged, config.factory));
});
