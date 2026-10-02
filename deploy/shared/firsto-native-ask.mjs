import { getAddress, ZeroAddress, TypedDataEncoder } from 'ethers';

export const FIRSTO_NATIVE_ASK_ORIGIN = 'https://api-tapeout.firsto.ai';
export const FIRSTO_NATIVE_ASK_PATH = '/v1/circuit-asks';
export const FIRSTO_NATIVE_EXCHANGE = '0x33423244F9a5bF81b12B1a018aF6F4e079B97f29';
export const FIRSTO_NATIVE_ZERO_SIGNATURE = `0x${'00'.repeat(65)}`;
export const FIRSTO_NATIVE_ASK_FIELDS = Object.freeze([
  ['maker', 'address'], ['collection', 'address'], ['tokenId', 'uint256'], ['nonce', 'uint256'],
  ['price', 'uint128'], ['expiry', 'uint64'], ['payoutRecipient', 'address'], ['feeBps', 'uint16'],
  ['feeEpoch', 'uint256'], ['schemaVersion', 'uint16'],
].map(([name, type]) => Object.freeze({ name, type })));
export const FIRSTO_NATIVE_ASK_DOMAIN = Object.freeze({ name: 'Firsto Circuit Signed Ask', version: '2',
  chainId: 56, verifyingContract: FIRSTO_NATIVE_EXCHANGE });
const types = Object.freeze({ SignedAsk: FIRSTO_NATIVE_ASK_FIELDS });
const official = new Set(['0xb1024b89886b9a34aa4ff5f31c411d708b20a14c',
  '0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c']);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const need = (condition, code, message) => { if (!condition) fail(code, message); };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const address = value => {
  let result;
  try { result = getAddress(value); } catch { fail('invalid-native-ask', 'Firsto 挂单地址无效。'); }
  need(result !== ZeroAddress, 'invalid-native-ask', 'Firsto 挂单地址不能为零。');
  return result;
};
const sameAddress = (left, right) => address(left) === address(right);
const integer = (value, bits = 256) => {
  need(typeof value === 'bigint' && value >= 0n
    || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    || typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value),
  'invalid-native-ask', 'Firsto 挂单金额、时间或编号必须为精确整数。');
  const result = BigInt(value);
  need(result < 1n << BigInt(bits), 'invalid-native-ask', 'Firsto 挂单字段超出合约范围。');
  return result.toString();
};
const hash = value => {
  need(typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value),
    'invalid-native-ask', 'Firsto 挂单摘要必须为 bytes32。');
  return value.toLowerCase();
};

/** Pure envelope adapter. The caller obtains capability/authorization from the approved pool's business getter. */
export function createFirstoNativeAsk(input, { pool, collection, tokenId, nativeAuthorized, nativeVersion,
  signature = FIRSTO_NATIVE_ZERO_SIGNATURE, expectedAskHash } = {}) {
  need(nativeAuthorized === true && integer(nativeVersion, 8) === '1',
    'native-sale-disabled', '矿池原生 Firsto 出售尚未启用或当前挂单未获链上授权。');
  need(input && typeof input === 'object', 'invalid-native-ask', 'Firsto 挂单参数为空。');
  const ask = Object.freeze(Object.fromEntries(FIRSTO_NATIVE_ASK_FIELDS.map(({ name, type }) => [name,
    type === 'address' ? address(input[name]) : integer(input[name], Number(type.slice(4)))])));
  need(sameAddress(ask.maker, pool) && sameAddress(ask.payoutRecipient, pool)
    && sameAddress(ask.collection, collection) && ask.tokenId === integer(tokenId),
  'native-ask-binding-mismatch', 'Firsto 挂单卖方、收款矿池或矿机与批准目标不一致。');
  need(official.has(ask.collection.toLowerCase()) && ask.schemaVersion === '2' && BigInt(ask.price) > 0n
    && BigInt(ask.expiry) > 0n && BigInt(ask.feeEpoch) > 0n && BigInt(ask.feeBps) <= 200n,
  'invalid-native-ask', 'Firsto 挂单矿机、售价、到期时间或手续费条件不受支持。');
  need(signature === '0x' || signature === FIRSTO_NATIVE_ZERO_SIGNATURE,
    'native-ask-binding-mismatch', '合约卖家仅使用链上 ERC-1271 授权，不能代入个人钱包签名。');
  const askHash = TypedDataEncoder.hash(FIRSTO_NATIVE_ASK_DOMAIN, types, ask).toLowerCase();
  if (expectedAskHash !== undefined) need(hash(expectedAskHash) === askHash,
    'native-ask-binding-mismatch', 'Firsto 挂单与矿池返回的授权摘要不一致。');
  const payload = Object.freeze({ domain: FIRSTO_NATIVE_ASK_DOMAIN, primaryType: 'SignedAsk', message: ask, signature });
  const feeWei = BigInt(ask.price) * BigInt(ask.feeBps) / 10_000n;
  return Object.freeze({ chainId: 56, exchange: FIRSTO_NATIVE_EXCHANGE, askHash, ask, signature, payload,
    body: JSON.stringify(payload), priceWei: ask.price, feeWei: feeWei.toString(),
    buyerCostWei: (BigInt(ask.price) + feeWei).toString() });
}

/** Only an acknowledgement of this exact order is accepted; pending approval is not an open listing. */
export function parseFirstoNativeAskPublication(value, expected) {
  need(record(value) && hash(value.askHash) === hash(expected?.askHash)
    && ['open', 'pending_approval'].includes(value.status),
  'native-publication-mismatch', 'Firsto 未确认本次精确挂单，不能显示为已上架。');
  return Object.freeze({ askHash: hash(value.askHash), status: value.status, published: value.status === 'open' });
}

const statuses = new Set(['open', 'pending_approval', 'filled', 'cancelled', 'expired',
  'asset_transferred', 'approval_revoked', 'invalid']);

function verifyRow(row, expected) {
  const ask = expected.ask;
  need(record(row), 'native-record-mismatch', 'Firsto 挂单记录格式无效。');
  const sources = [row];
  if (row.execution != null) {
    need(record(row.execution) && row.execution.kind === 'signed_ask',
      'native-record-mismatch', 'Firsto 挂单执行类型不一致。');
    sources.push(row.execution);
  }
  for (const source of sources) {
    if (source.askHash !== undefined) need(hash(source.askHash) === expected.askHash,
      'native-record-mismatch', 'Firsto 记录的挂单摘要不一致。');
    for (const { name, type } of FIRSTO_NATIVE_ASK_FIELDS) {
      const value = name === 'price' ? source.priceWei ?? source.price : source[name];
      if (value === undefined) continue;
      const actual = type === 'address' ? address(value) : integer(value, Number(type.slice(4)));
      need(actual === ask[name], 'native-record-mismatch', 'Firsto 记录的矿机、卖方或订单条款不一致。');
      if (name === 'price' && source.price !== undefined && source.priceWei !== undefined)
        need(integer(source.price, 128) === integer(source.priceWei, 128),
          'native-record-mismatch', 'Firsto 记录的两个价格字段不一致。');
    }
    if (source.chainId !== undefined) need(integer(source.chainId) === '56',
      'native-record-mismatch', 'Firsto 记录网络不一致。');
    for (const key of ['exchange', 'verifyingContract']) if (source[key] !== undefined)
      need(sameAddress(source[key], FIRSTO_NATIVE_EXCHANGE), 'native-record-mismatch', 'Firsto 记录市场不一致。');
  }
  // Complete terms must be present in at least one source per field. A matching hash alone is not an indexed listing.
  for (const { name } of FIRSTO_NATIVE_ASK_FIELDS) need(sources.some(source =>
    name === 'price' ? source.priceWei !== undefined || source.price !== undefined : source[name] !== undefined),
  'native-record-mismatch', 'Firsto 记录缺少精确挂单条款。');
  need(statuses.has(row.status), 'native-record-mismatch', 'Firsto 挂单状态不受支持。');
  return Object.freeze({ askHash: expected.askHash, status: row.status, published: row.status === 'open', row });
}

/** Read-only reconciliation of official detail/account JSON. Unrelated miners, makers or nonces are never acknowledgement. */
export function findFirstoNativeAskRecord(value, expected, { kind = 'account' } = {}) {
  need(expected?.ask && hash(expected.askHash) === TypedDataEncoder.hash(FIRSTO_NATIVE_ASK_DOMAIN, types, expected.ask).toLowerCase(),
    'native-record-mismatch', '待查 Firsto 挂单参数与摘要不一致。');
  let rows;
  if (kind === 'account') {
    need(record(value) && value.kind === 'listings' && Array.isArray(value.orders),
      'native-record-mismatch', 'Firsto 账户挂单响应格式无效。');
    if (value.account !== undefined) need(sameAddress(value.account, expected.ask.maker),
      'native-record-mismatch', 'Firsto 账户挂单响应属于其他账户。');
    rows = value.orders;
  } else if (kind === 'detail') {
    need(record(value?.asset) && sameAddress(value.asset.collection, expected.ask.collection)
      && integer(value.asset.tokenId) === expected.ask.tokenId && Array.isArray(value.orders?.signedAsks),
    'native-record-mismatch', 'Firsto 矿机详情与本次挂单目标不一致。');
    rows = value.orders.signedAsks;
  } else fail('native-record-mismatch', '不支持此 Firsto 挂单查询类型。');
  need(rows.length <= 10_000, 'native-record-mismatch', 'Firsto 挂单响应超过读取上限。');
  const matches = rows.filter(row => typeof row?.askHash === 'string' && row.askHash.toLowerCase() === expected.askHash);
  need(matches.length <= 1, 'native-record-mismatch', 'Firsto 返回重复的挂单摘要。');
  return matches.length ? verifyRow(matches[0], expected) : null;
}
