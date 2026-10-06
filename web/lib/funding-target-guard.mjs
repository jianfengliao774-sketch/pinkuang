import { Interface, ZeroAddress, getAddress } from 'ethers';
import { abi } from './chain-client.mjs';
import { fetchLiveJson } from './live-config.mjs';
import { confirmedMissingTargetListing, confirmedAvailableTargetListing } from './live-view.mjs';
import { assertTargetOwnerConfigured } from './target-owner-funding.mjs';

const nft = new Interface(['function ownerOf(uint256) view returns(address)']);
const same = (a, b) => getAddress(a) === getAddress(b);
const requireValue = (value, message) => { if (!value) throw new Error(message); };
const decode = (_key, value) => value && typeof value === 'object' && Object.keys(value).length === 1
  && /^(0|[1-9]\d*)$/.test(value.$bemineBigInt ?? '') ? BigInt(value.$bemineBigInt) : value;
const unavailable = '指定矿机已转移，当前项目已停止开放认购，请查看退款入口。';
const unlisted = '指定矿机当前无有效卖单，本项目已下架并停止开放认购，请查看退款入口。';
const unknown = '指定矿机的可购状态尚未确认，请刷新后重试；现有认购和退款权益保留。';

/** Display checks cannot stop a direct contract call. The upgraded Vault must enforce this atomically. */
export const fundingTargetGuardEnabled = config => config?.fundingTargetGuard === true;

/** Only one selected fixed target is read; the server supplies a shared historical owner proof. */
export async function assertFundingTargetAvailable({ provider, config, pool, params,
  fetcher = globalThis.fetch, blockTag = 'latest' }) {
  await assertTargetOwnerConfigured({ provider, config, pool, blockTag });
  if (!fundingTargetGuardEnabled(config)) return null;
  const target = getAddress(pool);
  const call = async (to, contract, method, args = []) => contract.decodeFunctionResult(method,
    await provider.request({ method: 'eth_call', params: [{ to, data: contract.encodeFunctionData(method, args) }, blockTag] }));
  // Alternative-purchase consent is on chain, never inferred from a reference price or cached flag.
  const [flexible] = await call(target, abi.PoolVault, 'flexiblePurchase');
  if (flexible === true) return Object.freeze({ status: 'not_applicable', purchaseMode: 'flexible' });
  requireValue(flexible === false, unknown);
  requireValue(config.indexBaseUrl && config.origin, unknown);
  const base = new URL(config.indexBaseUrl);
  requireValue(base.origin === config.origin && !base.search && !base.hash && !base.username && !base.password,
    '项目可购状态服务来源无效。');
  const url = `${base.href.replace(/\/$/, '')}/v1/display/pools/${target}`;
  const [response, currentParams] = await Promise.all([
    fetchLiveJson(url, { fetcher, maxBytes: 65536, timeoutMs: 8000 }),
    params ? Promise.resolve(params) : call(target, abi.PoolVault, 'params').then(values => values[0]),
  ]);
  const payload = JSON.parse(JSON.stringify(response), decode), source = payload?.source;
  const row = payload?.data?.item, proof = row?.targetAvailability;
  requireValue(source?.chainId === 56 && same(source.factory, config.factory ?? config.manifest?.factory)
    && same(source.market, config.shareMarket ?? config.manifest?.shareMarket)
    && source.cacheOrigin === 'server' && source.readMode === 'verified_snapshot'
    && row?.trusted === true && same(row.pool, target) && row.params
    && same(row.params.circuits, currentParams.circuits)
    && BigInt(row.params.circuitId) === BigInt(currentParams.circuitId), '项目可购状态与当前合约不一致。');
  requireValue(proof?.purchaseMode === 'fixed' && ['available', 'unavailable'].includes(proof.status)
    && proof.creationOwnerProof === 'block_end_owner_and_ordered_transfers'
    && Number.isSafeInteger(proof.creationBlock) && proof.creationBlock >= 0
    && /^0x[\da-f]{64}$/i.test(proof.creationBlockHash ?? '')
    && Number.isSafeInteger(proof.observedBlock) && proof.observedBlock >= proof.creationBlock, unknown);
  const originalOwner = getAddress(proof.originalOwner);
  requireValue(originalOwner !== ZeroAddress && !same(originalOwner, target), unknown);
  // Never authorize a new subscription from an old ownerOf result in a display snapshot.
  const [currentOwner] = await call(currentParams.circuits, nft, 'ownerOf', [currentParams.circuitId]);
  requireValue(currentOwner !== ZeroAddress && !same(currentOwner, target) && same(currentOwner, originalOwner), unavailable);
  if (proof.status === 'unavailable') {
    requireValue(proof.reason === 'target_listing_unavailable' && confirmedMissingTargetListing(proof), unknown);
    throw new Error(unlisted);
  }
  if (proof.reason === 'target_listing_available') requireValue(confirmedAvailableTargetListing(proof), unknown);
  return Object.freeze({ ...proof, currentOwner, status: 'available', rechecked: true });
}
