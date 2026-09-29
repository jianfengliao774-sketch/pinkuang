import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorityAdministrators, stageTwoAddresses } from './upgrade-stage2';

const address = (n: number) => `0x${n.toString(16).padStart(40,'0')}`;
const existing = {timelock:address(1),factory:address(2),portfolioFactory:address(3),oldOwner:address(4)};

test('stage-two public wallet candidates distinguish hardware owner, relayer and administrators', () => {
  const value = stageTwoAddresses(address(5), address(6), existing);
  assert.equal(value.hardwareWallet,address(5));
  assert.equal(value.gasWallet,address(6));
  assert.equal(value.administratorOne,authorityAdministrators[0]);
  assert.equal(value.administratorTwo,authorityAdministrators[1]);
});

test('stage-two configuration rejects a private key, reused privileged address and missing public wallet', () => {
  assert.throws(() => stageTwoAddresses('0x'+'a'.repeat(64),address(6),existing));
  assert.throws(() => stageTwoAddresses('',address(6),existing),/公开地址/);
  assert.throws(() => stageTwoAddresses(address(4),address(6),existing),/硬件钱包/);
  assert.throws(() => stageTwoAddresses(address(5),address(4),existing),/Gas 钱包/);
  assert.throws(() => stageTwoAddresses(address(5),authorityAdministrators[1],existing),/Gas 钱包/);
});
