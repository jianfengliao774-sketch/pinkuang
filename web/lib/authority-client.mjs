import { AbiCoder, Interface, ZeroAddress, getAddress, keccak256, toUtf8Bytes, verifyTypedData } from 'ethers';
import { abi } from './chain-client.mjs';

const need = (condition, message) => { if (!condition) throw new Error(message); };
const same = (a, b) => getAddress(a) === getAddress(b);
const coder = AbiCoder.defaultAbiCoder();
const authorityAbi = new Interface([
  'function administratorOne() view returns(address)',
  'function administratorTwo() view returns(address)',
  'function gasWallet() view returns(address)',
  'function coreFactory() view returns(address)',
  'function budgetFactory() view returns(address)',
  'function nonces(address) view returns(uint256)',
]);
const types = { Action: [
  { name: 'kind', type: 'bytes32' }, { name: 'target', type: 'address' },
  { name: 'paramsHash', type: 'bytes32' }, { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
] };
const actionKind = Object.freeze({
  executeApprovedOperation: 'APPROVED_OPERATION',
  reviewSale: 'REVIEW_SALE', reviewChildSale: 'REVIEW_CHILD_SALE',
  setSaleReference: 'SALE_REFERENCE', claimFees: 'CLAIM_FEES',
  buyBudgetOfficial: 'BUY_BUDGET_OFFICIAL', buyBudgetFirsto: 'BUY_BUDGET_FIRSTO',
});
const integer = value => { const n = BigInt(value); need(n >= 0n, '金额、编号或时间不能为负。'); return n; };
const hashKind = name => keccak256(toUtf8Bytes(name));
const hexBytes = value => typeof value === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(value);

/** Build only an action that PlatformAuthority itself can authorize. */
export function authorityAction(authority, kind, args, nonce, deadline) {
  authority = getAddress(authority);
  need(actionKind[kind], '不支持的管理员操作。');
  need(args && typeof args === 'object' && !Array.isArray(args), '管理员操作参数无效。');
  const n = integer(nonce), expires = integer(deadline);
  need(expires > 0n, '签名有效期无效。');
  let target, paramsHash;
  if (kind === 'executeApprovedOperation') {
    target = getAddress(args.target);
    need(hexBytes(args.data) && args.data.length >= 10, '操作数据无效。');
    paramsHash = keccak256(args.data);
  } else if (kind === 'reviewSale') {
    target = getAddress(args.market);
    paramsHash = keccak256(coder.encode(['address','uint256','uint128','bool'],
      [getAddress(args.pool), integer(args.proposalId), integer(args.priceWei), args.approved === true]));
  } else if (kind === 'reviewChildSale') {
    target = getAddress(args.portfolio);
    paramsHash = keccak256(coder.encode(['uint256','bool'], [integer(args.proposalId), args.approved === true]));
  } else if (kind === 'setSaleReference') {
    target = getAddress(args.market);
    paramsHash = keccak256(coder.encode(['address','uint128','uint64','bytes32'],
      [getAddress(args.pool), integer(args.priceWei), integer(args.observedAt), args.digest]));
  } else if (kind === 'claimFees') {
    target = authority;
    need(Array.isArray(args.markets) && Array.isArray(args.pools), '手续费来源必须为列表。');
    paramsHash = keccak256(coder.encode(['address[]','address[]','address'],
      [args.markets.map(getAddress), args.pools.map(getAddress), getAddress(args.recipient)]));
  } else if (kind === 'buyBudgetOfficial') {
    target = getAddress(args.portfolio);
    paramsHash = keccak256(coder.encode(['address','uint256','uint256'],
      [getAddress(args.child), integer(args.listingId), integer(args.maxCost)]));
  } else {
    target = getAddress(args.portfolio);
    need(hexBytes(args.encodedOrder), 'Firsto 订单数据无效。');
    paramsHash = keccak256(coder.encode(['address','bytes32','uint256'],
      [getAddress(args.child), keccak256(args.encodedOrder), integer(args.maxCost)]));
  }
  const domain = { name: 'BEMine Platform Authority', version: '1', chainId: 56, verifyingContract: authority };
  const message = { kind: hashKind(actionKind[kind]), target, paramsHash, nonce: n.toString(), deadline: expires.toString() };
  return { domain, types, message };
}

/** A fresh operator preview already contains exact Factory calldata; bind that byte string. */
export function approvedOperatorCall(config, transaction) {
  need(config?.stage === 'fresh-active', '仅新部署使用管理员签名代付。');
  need(transaction?.value === '0x0' || transaction?.value === '0x', '管理员代付交易不得附带 BNB。');
  const target = getAddress(transaction.to);
  const core = getAddress(config.factory), budget = getAddress(config.portfolioFactory);
  const parsed = target === core ? abi.PoolFactory.parseTransaction({ data: transaction.data })
    : target === budget ? abi.BudgetPortfolioFactory.parseTransaction({ data: transaction.data }) : null;
  need(parsed && (target !== core || ['createPool','createPoolWithExpiry','createBudgetChildPool',
    'createFlexiblePool','createFlexiblePoolChecked'].includes(parsed.name))
    && (target !== budget || parsed.name === 'createPortfolio'), '只有已预览的建池或预算项目能由管理员代付。');
  return { target, data: transaction.data };
}

/** Read a single canonical block before asking the connected admin wallet to sign. */
export async function signAuthorityAction({ provider, config, account, kind, args, validitySeconds = 600 }) {
  need(config?.stage === 'fresh-active' && config?.status === 'ready', '新合约尚未启用。');
  const signer = getAddress(account), authority = getAddress(config.authority ?? config.manifest?.authority);
  need(authority !== ZeroAddress && Number.isInteger(validitySeconds) && validitySeconds > 0 && validitySeconds <= 900,
    '管理员签名有效期无效。');
  const rpc = (method, params = []) => provider.request({ method, params });
  need(BigInt(await rpc('eth_chainId')) === 56n, '请切换到 BSC 主网。');
  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  need(/^0x[0-9a-f]{64}$/i.test(block?.hash ?? ''), '当前链上区块不可用。');
  const tag = block.number;
  const read = async (name, params = []) => authorityAbi.decodeFunctionResult(name,
    await rpc('eth_call', [{ to: authority, data: authorityAbi.encodeFunctionData(name, params) }, tag]))[0];
  const [first, second, gasWallet, core, budget, nonce, code] = await Promise.all([
    read('administratorOne'), read('administratorTwo'), read('gasWallet'), read('coreFactory'),
    read('budgetFactory'), read('nonces', [signer]), rpc('eth_getCode', [authority, tag]),
  ]);
  need(same(signer, first) || same(signer, second), '当前钱包不是链上登记的管理员。');
  need(same(core, config.factory) && same(budget, config.portfolioFactory), '管理员合约绑定的 Factory 不一致。');
  if (config.gasWallet ?? config.manifest?.gasWallet) need(same(gasWallet, config.gasWallet ?? config.manifest.gasWallet), 'Gas 钱包与部署配置不一致。');
  need(code && code !== '0x', '管理员合约代码不可用。');
  const deadline = (BigInt(block.timestamp) + BigInt(validitySeconds)).toString();
  const signed = authorityAction(authority, kind, args, nonce, deadline);
  const payload = { types: { EIP712Domain: [
    { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
  ], ...signed.types }, primaryType: 'Action', domain: signed.domain, message: signed.message };
  const signature = await rpc('eth_signTypedData_v4', [signer, JSON.stringify(payload)]);
  need(same(verifyTypedData(signed.domain, signed.types, signed.message, signature), signer),
    '钱包签名与当前管理员地址不一致。');
  need((await rpc('eth_getBlockByNumber', [tag, false]))?.hash === block.hash,
    '签名期间区块发生重组；请重新核对。');
  return { authority, expectedCodehash: keccak256(code), kind, args,
    nonce: nonce.toString(), deadline, signature };
}

export async function submitAuthorityAction(config, account, command) {
  const base = (config.journalBase ?? '/api/journal').replace(/\/$/, '');
  const response = await fetch(`${base}/authority-relay`, { method: 'POST', credentials: 'same-origin',
    cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Pinkuang-Account': getAddress(account) },
    body: JSON.stringify({ command }) });
  const result = await response.json().catch(() => null);
  need(response.ok && result, result?.error || `管理员代付服务暂不可用（HTTP ${response.status}）。`);
  return result;
}

export async function authorityActionStatus(config, account) {
  const base = (config.journalBase ?? '/api/journal').replace(/\/$/, '');
  const response = await fetch(`${base}/authority-relay/status`, { credentials: 'same-origin', cache: 'no-store',
    headers: { 'X-Pinkuang-Account': getAddress(account) } });
  const result = await response.json().catch(() => null);
  need(response.ok && result, result?.error || `管理员交易状态暂不可用（HTTP ${response.status}）。`);
  return result;
}
