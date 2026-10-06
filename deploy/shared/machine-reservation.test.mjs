import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, ZeroAddress, getAddress } from 'ethers';
import { readMachineReservation, requireMachineAvailable } from './machine-reservation.mjs';

const abi = new Interface(['function machinePool(address,uint256) view returns(address)']);
const factory = getAddress(`0x${'11'.repeat(20)}`);
const collection = getAddress('0xb1024b89886b9a34aa4ff5f31c411d708b20a14c');
const occupied = getAddress('0x1234567890abcdef1234567890abcdef12345678');
const result = pool => abi.encodeFunctionResult('machinePool', [pool]);

test('EIP-1193 reader makes exactly one current Factory call and returns checksummed occupancy', async () => {
  const calls = [], provider = { request: async input => { calls.push(input); return result(occupied); } };
  assert.equal(await readMachineReservation(provider, { factory, collection, tokenId: '7223' }), occupied);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'eth_call');
  assert.equal(calls[0].params[0].to, factory);
  assert.equal(calls[0].params[1], 'latest');
  const decoded = abi.parseTransaction({ data: calls[0].params[0].data });
  assert.equal(decoded.name, 'machinePool');
  assert.equal(decoded.args[0], collection);
  assert.equal(decoded.args[1], 7223n);
});

test('ethers send reader accepts a zero or occupied pool at a caller-selected block', async () => {
  const calls = [], provider = { send: async (...args) => { calls.push(args); return result(ZeroAddress); } };
  assert.equal(await requireMachineAvailable(provider, { factory, collection, tokenId: 7223n, blockTag: '0x10' }), ZeroAddress);
  assert.deepEqual(calls.map(([method, params]) => [method, params[1]]), [['eth_call', '0x10']]);
  const taken = { send: async () => result(occupied) };
  await assert.rejects(requireMachineAvailable(taken, { factory, collection, tokenId: '7223' }), error => {
    assert.equal(error.code, 'MachineAlreadyReserved');
    assert.equal(error.pool, occupied);
    assert.match(error.message, /已有拼矿项目.*不能重复创建/);
    return true;
  });
});

test('missing transport, malformed result, RPC failure and imprecise input fail closed', async () => {
  const input = { factory, collection, tokenId: '7223' };
  await assert.rejects(readMachineReservation({}, input), /读取器不可用/);
  for (const encoded of ['0x', '0x1234', `${result(ZeroAddress)}00`, null, 0])
    await assert.rejects(readMachineReservation({ request: async () => encoded }, input), /返回值无效/);
  await assert.rejects(requireMachineAvailable({ send: async () => { throw new Error('RPC down'); } }, input), /RPC down/);
  await assert.rejects(readMachineReservation({ request: async () => { assert.fail('No RPC for invalid ID'); } },
    { ...input, tokenId: Number.MAX_SAFE_INTEGER + 1 }), /精确整数/);
  await assert.rejects(readMachineReservation({ request: async () => { assert.fail('No RPC for invalid block'); } },
    { ...input, blockTag: 'pending' }), /读取区块无效/);
});
