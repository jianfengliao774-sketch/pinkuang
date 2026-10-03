import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, TypedDataEncoder, Wallet, ZeroAddress, id, keccak256, verifyTypedData } from 'ethers';
import { AUTHORITY_TYPES, authorityTypedAction } from './authority-typed.mjs';

const authority = '0x0000000000000000000000000000000000000011';
const factory = '0x0000000000000000000000000000000000000022';
const poolTuple = '(address circuits,uint256 circuitId,uint256 targetRaise,uint256 priceCap,address directSeller,uint256 directPrice,uint64 fundingDeadline,uint64 purchaseDeadline)';
const designatedTuple = '(address referenceSeller,uint256 referencePriceWei,uint256 referenceCostWei,uint256 referenceDailyOutputAtomic,uint64 referenceObservedAt,uint64 referenceBlock,bytes32 referenceDigest)';
const flexibleTuple = '(uint128 minVerifiedWeight,uint256 referencePriceWei,uint256 targetDailyYieldAtomic,uint16 extraBps,uint64 referenceObservedAt,uint64 referenceBlock,bytes32 referenceDigest)';
const core = new Interface([
  `function createDesignatedPoolChecked(${poolTuple},${designatedTuple},uint32,uint128)`,
  `function createPool(${poolTuple})`,
  `function createPoolWithExpiry(${poolTuple},bool)`,
  `function createBudgetChildPool(${poolTuple},address)`,
  `function createFlexiblePool(${poolTuple},${flexibleTuple})`,
  `function createFlexiblePoolChecked(${poolTuple},${flexibleTuple},uint32,uint128)`,
]);
const params = { circuits: '0x0000000000000000000000000000000000000033', circuitId: 123n,
  targetRaise: 100000n, priceCap: 90000n, directSeller: '0x0000000000000000000000000000000000000044',
  directPrice: 80000n, fundingDeadline: 1800001000n, purchaseDeadline: 1800002000n };
const config = { referenceSeller: '0x0000000000000000000000000000000000000066', referencePriceWei: 80000n,
  referenceCostWei: 80800n, referenceDailyOutputAtomic: 4579200n, referenceObservedAt: 1800000000n,
  referenceBlock: 125523136n, referenceDigest: '0x' + 'ab'.repeat(32) };
const zeroFlexible = [0n, 0n, 0n, 0n, 0n, 0n, '0x' + '00'.repeat(32)];
const nonce = 2n, deadline = 9999999999n;
const action = (data, target = factory, n = nonce, end = deadline) =>
  authorityTypedAction(authority, 'executeApprovedOperation', { target, data }, n, end);
const data = () => core.encodeFunctionData('createDesignatedPoolChecked', [params, config, 20, 10]);
const structHash = typed => TypedDataEncoder.hashStruct(typed.primaryType, typed.types, typed.message);

test('designated creation has a distinct exact type and matches independent Solidity ABI hashing', () => {
  const typed = action(data());
  assert.equal(typed.primaryType, 'CreateDesignatedPool');
  assert.deepEqual(typed.domain, { name: 'BEMine Platform Authority', version: '1', chainId: 56,
    verifyingContract: authority });
  assert.deepEqual(Object.keys(typed.types).sort(), ['CreateDesignatedPool', 'DesignatedConfig', 'PoolParams']);
  assert.deepEqual(typed.message.config, Object.fromEntries(Object.entries(config)
    .map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value])));
  assert.equal(typed.message.expectedTaskId, '20');
  assert.equal(typed.message.expectedReferenceWeight, '10');
  assert.equal('operation' in typed.message, false);
  const abi = AbiCoder.defaultAbiCoder();
  const paramsHash = keccak256(abi.encode(['bytes32', 'address', 'uint256', 'uint256', 'uint256', 'address', 'uint256', 'uint64', 'uint64'],
    [id('PoolParams(address circuits,uint256 circuitId,uint256 targetRaise,uint256 priceCap,address directSeller,uint256 directPrice,uint64 fundingDeadline,uint64 purchaseDeadline)'), ...Object.values(params)]));
  const configHash = keccak256(abi.encode(['bytes32', 'address', 'uint256', 'uint256', 'uint256', 'uint64', 'uint64', 'bytes32'],
    [id('DesignatedConfig(address referenceSeller,uint256 referencePriceWei,uint256 referenceCostWei,uint256 referenceDailyOutputAtomic,uint64 referenceObservedAt,uint64 referenceBlock,bytes32 referenceDigest)'), ...Object.values(config)]));
  const independent = keccak256(abi.encode(['bytes32', 'address', 'bytes32', 'bytes32', 'uint32', 'uint128', 'uint256', 'uint256'],
    [id('CreateDesignatedPool(address factory,PoolParams params,DesignatedConfig config,uint32 expectedTaskId,uint128 expectedReferenceWeight,uint256 nonce,uint256 deadline)DesignatedConfig(address referenceSeller,uint256 referencePriceWei,uint256 referenceCostWei,uint256 referenceDailyOutputAtomic,uint64 referenceObservedAt,uint64 referenceBlock,bytes32 referenceDigest)PoolParams(address circuits,uint256 circuitId,uint256 targetRaise,uint256 priceCap,address directSeller,uint256 directPrice,uint64 fundingDeadline,uint64 purchaseDeadline)'), factory, paramsHash, configHash, 20, 10, nonce, deadline]));
  assert.equal(structHash(typed), independent);
  assert.equal(independent, '0x331adf987b7514870c9509e6d2a9bc8d18375aa9166da8e6b343be13f7d1b94f');
});

test('all designated config, model, amount, identity, nonce and target fields are signed', async () => {
  const signer = new Wallet('0x' + '11'.repeat(32)); // Local fixture only; no provider or transaction.
  const original = action(data());
  const signature = await signer.signTypedData(original.domain, original.types, original.message);
  assert.equal(verifyTypedData(original.domain, original.types, original.message, signature), signer.address);
  const changed = [];
  for (const [key, value] of Object.entries(params)) {
    const replacement = typeof value === 'bigint' ? value + 1n : '0x0000000000000000000000000000000000000077';
    changed.push(core.encodeFunctionData('createDesignatedPoolChecked', [{ ...params, [key]: replacement }, config, 20, 10]));
  }
  for (const [key, value] of Object.entries(config)) {
    const replacement = typeof value === 'bigint' ? value + 1n : key === 'referenceDigest'
      ? '0x' + 'ac'.repeat(32) : '0x0000000000000000000000000000000000000077';
    changed.push(core.encodeFunctionData('createDesignatedPoolChecked', [params, { ...config, [key]: replacement }, 20, 10]));
  }
  changed.push(core.encodeFunctionData('createDesignatedPoolChecked', [params, config, 21, 10]));
  changed.push(core.encodeFunctionData('createDesignatedPoolChecked', [params, config, 20, 11]));
  const variants = [...changed.map(bytes => action(bytes)), action(data(), params.circuits),
    action(data(), factory, nonce + 1n), action(data(), factory, nonce, deadline + 1n),
    { ...original, domain: { ...original.domain, chainId: 57 } },
    { ...original, domain: { ...original.domain, verifyingContract: factory } }];
  for (const typed of variants) {
    assert.notEqual(verifyTypedData(typed.domain, typed.types, typed.message, signature), signer.address);
  }
});

test('noncanonical designated calldata and unknown creation selectors cannot be signed', () => {
  assert.throws(() => action(data() + '00'), /Noncanonical/);
  assert.throws(() => action(data().slice(0, -2)));
  const words = data().slice(10).match(/.{64}/g);
  // Solidity uint32 and uint128 argument padding must be zero, as must address padding.
  for (const index of [0, 8, 15, 16]) {
    const corrupted = [...words];
    corrupted[index] = '01' + corrupted[index].slice(2);
    assert.throws(() => action(data().slice(0, 10) + corrupted.join('')));
  }
  assert.throws(() => action('0x11223344'), /Unsupported signed operation/);
});

test('legacy CreatePool hash vector and all existing creation primary types remain unchanged', () => {
  const typed = action(core.encodeFunctionData('createPool', [params]));
  assert.equal(typed.primaryType, 'CreatePool');
  assert.equal(structHash(typed), '0x2e479e5e053f4ac9b3cc8b317638eed409caa78d2403572a419e26e22516ab4c');
  assert.equal(typed.message.subscriber, ZeroAddress);
  assert.deepEqual(typed.types, { CreatePool: AUTHORITY_TYPES.CreatePool,
    PoolParams: AUTHORITY_TYPES.PoolParams, FlexibleConfig: AUTHORITY_TYPES.FlexibleConfig });
  for (const [operation, args] of [
    ['createPoolWithExpiry', [params, false]], ['createBudgetChildPool', [params, factory]],
    ['createFlexiblePool', [params, zeroFlexible]], ['createFlexiblePoolChecked', [params, zeroFlexible, 20, 10]],
  ]) {
    const legacy = action(core.encodeFunctionData(operation, args));
    assert.equal(legacy.primaryType, 'CreatePool');
    assert.equal(legacy.message.operation, operation);
    assert.equal('DesignatedConfig' in legacy.types, false);
  }
});
