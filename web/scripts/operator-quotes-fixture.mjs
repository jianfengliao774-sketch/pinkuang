/** Local quotation fixtures only. Never import into production UI. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, ZeroAddress, getAddress } from 'ethers';
import { OFFICIAL_COLLECTIONS, parseQuotePage, parseCapacityReference, verifyQuoteDetail } from '../../deploy/src/pricing.ts';
import { QUOTE_BASE, machineRegistryAbi } from '../lib/operator-quotes.mjs';
const config = { factory: getAddress('0x0000000000000000000000000000000000000201') };
const MARKET = getAddress('0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f');
const MINING = getAddress('0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46');
const seller = getAddress('0x1111111111111111111111111111111111111111');
const other = getAddress('0x2222222222222222222222222222222222222222');
const exchange = '0x33423244f9a5bf81b12b1a018af6f4e079b97f29';
const askId = `0x${'aa'.repeat(32)}`, key = `0x${'bb'.repeat(32)}`, blockHash = `0x${'cc'.repeat(32)}`;

// Build the fixture decoder from the verified Solidity interfaces, independently of operator-quotes.mjs.
const marketSource = readFileSync(new URL('../../contracts/src/interfaces/ICircuitMarket.sol', import.meta.url), 'utf8');
const listingSignature = /function listingFor\([\s\S]*?returns\s*\([^;]+\)/.exec(marketSource)[0].replace(/\bexternal\b/, '');
const marketAbi = new Interface([listingSignature]);
const miningSource = readFileSync(new URL('../../contracts/src/interfaces/ITapeoutMining.sol', import.meta.url), 'utf8');
const minerFields = [.../struct Miner\s*\{([^}]+)\}/.exec(miningSource)[1].matchAll(/(address|uint\d+|bool)\s+(\w+)\s*;/g)].map(([, type, name]) => ({ type, name }));
const miningAbi = new Interface(['function minerKey(address,uint256) view returns(bytes32)',
  `function getMiner(bytes32) view returns(tuple(${minerFields.map(({ type, name }) => `${type} ${name}`).join(',')}))`]);
const nftAbi = new Interface(['function ownerOf(uint256) view returns(address)']);

function dataFixture({ series = 'TapeOut', now = Date.now() } = {}) {
  const collection = OFFICIAL_COLLECTIONS[series];
  const row = { collection, tokenId: '16480', processorName: series, owner: seller,
    category: 'official_mining', classification: 'official_mining',
    bestAsk: { id: askId, account: seller, venue: 'firsto', priceWei: '2355000000000000001', buyerCostWei: '2378550000000000002',
      expiresAt: new Date(now + 86400000).toISOString(), status: 'open', execution: { kind: 'signed_ask', chainId: 56,
        exchange, maker: seller, feeBps: 100, schemaVersion: '2', collection, tokenId: '16480', priceWei: '2355000000000000001' } },
    mining: { status: 'verified', taskId: '220', verifiedWeight: '61', unverifiedWeight: '0', estimated24hAtomic: '123456789', tokenSymbol: 'BEM', tokenDecimals: 8 } };
  const page = { rows: [row], page: 1, totalPages: 1, total: 1, viewId: 'test-view', sourceBlock: '100', sourceFreshness: {
    'circuit_collections:official': now - 1000, 'official_circuit_mining:official': now - 2000,
    'blockfeed:bsc-tapeout-markets-shadow-v1:circuit-orders': now - 500,
    [`circuit_signed_ask_exchange:${exchange}`]: now - 2000 } };
  const detail = { asset: structuredClone(row), orders: { asksAndOnchainBids: [], signedAsks: [{ askHash: askId,
    maker: seller, status: 'open', priceWei: row.bestAsk.priceWei, buyerCostWei: row.bestAsk.buyerCostWei }] } };
  const referenceRaw = { tokenSymbol: 'BEM', tokenDecimals: 8, marketStats: { dailyCapacityPriceWei: '3000000000000000001' },
    asOf: new Date(now - 1000).toISOString(), sourceBlock: '100', viewId: 'reference-view' };
  const quote = verifyQuoteDetail(parseQuotePage(page, now).rows[0], detail);
  return { now, row, page, detail, quote, referenceRaw, reference: parseCapacityReference(referenceRaw, now) };
}

function chainFixture(quote, changes = {}) {
  const requests = [], calls = [];
  let headers = 0, chains = 0;
  const miner = { ...Object.fromEntries(minerFields.map(({ type, name }) => [name, type === 'address' ? ZeroAddress : type === 'bool' ? false : 0n])),
    circuits: quote.collection, circuitId: BigInt(quote.tokenId), taskId: BigInt(quote.taskId), status: 1n, verifWeight: BigInt(quote.verifiedWeight), ...changes.miner };
  const listing = { id: 45n, seller, price: 2000000000000000001n, valid: true, ...changes.listing };
  const provider = { async request(input) {
    requests.push(input); const { method, params = [] } = input;
    assert(['eth_chainId', 'eth_getBlockByNumber', 'eth_call'].includes(method), `Non-read RPC refused: ${method}`);
    if (method === 'eth_chainId') return ++chains === 1 ? changes.chain ?? '0x38' : changes.finalChain ?? '0x38';
    if (method === 'eth_getBlockByNumber') {
      headers++; return { number: headers === 1 ? '0x64' : changes.finalNumber ?? '0x64', timestamp: headers === 1 ? '0x6b49d200' : changes.finalTimestamp ?? '0x6b49d200',
        hash: headers > 1 && changes.reorg ? `0x${'dd'.repeat(32)}` : blockHash };
    }
    assert.equal(params[1], '0x64', 'every call is pinned');
    const [tx] = params, target = getAddress(tx.to);
    assert(!Object.hasOwn(tx, 'from'), 'no transaction simulation or send in quote reads');
    if (target === config.factory) {
      const parsed = machineRegistryAbi.parseTransaction(tx);
      if (parsed.name === 'machineRegistryStatus') return changes.registryUnsupported ? '0x'
        : machineRegistryAbi.encodeFunctionResult(parsed.fragment, [true, changes.registryReady ?? true, 0n, changes.registryReady === false ? 1n : 0n]);
      return machineRegistryAbi.encodeFunctionResult(parsed.fragment, [changes.registryPool ?? ZeroAddress]);
    }
    const iface = target === MARKET ? marketAbi : target === MINING ? miningAbi : nftAbi;
    const parsed = iface.parseTransaction(tx); calls.push(parsed.name);
    if (parsed.name === 'ownerOf') { assert.equal(parsed.args[0], BigInt(quote.tokenId)); return iface.encodeFunctionResult(parsed.fragment, [changes.owner ?? seller]); }
    if (parsed.name === 'listingFor') {
      assert.equal(getAddress(parsed.args[0]), getAddress(quote.collection)); assert.equal(parsed.args[1], BigInt(quote.tokenId));
      return iface.encodeFunctionResult(parsed.fragment, [listing.id, listing.seller, listing.price, listing.valid]);
    }
    if (parsed.name === 'minerKey') return iface.encodeFunctionResult(parsed.fragment, [key]);
    assert.equal(parsed.name, 'getMiner'); assert.equal(parsed.args[0], key);
    return iface.encodeFunctionResult(parsed.fragment, [miner]);
  } };
  return { provider, requests, calls, listing };
}

function apiFixture(data, { referenceFails = false, invalidJson = false } = {}) {
  const requests = [];
  return { requests, fetcher: async (input, init) => {
    requests.push({ input, init }); assert.equal(init.method, 'GET'); assert.equal(init.credentials, 'omit');
    const path = new URL(input, 'https://local.example').pathname;
    assert(path.startsWith(QUOTE_BASE + '/v1/'));
    if (path.endsWith('/circuit-holders') && referenceFails) return new Response('Unavailable', { status: 503 });
    const value = path.endsWith('/circuits') ? data.page : path.endsWith('/circuit-holders') ? data.referenceRaw : data.detail;
    return new Response(invalidJson && path.endsWith('/circuits') ? '{"rows":' : JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  } };
}


export { dataFixture, chainFixture, apiFixture, MARKET, MINING, seller, other, blockHash, config };
