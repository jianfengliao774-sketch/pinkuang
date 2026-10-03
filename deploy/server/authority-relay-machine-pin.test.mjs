import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { authorityRelayConfiguration, createAuthorityRelayService } from './authority-relay-api.mjs';

const invalidPins = ['', null, 42, 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41),
  'g'.repeat(40), ' ' + 'a'.repeat(40), 'a'.repeat(40) + '\n'];

test('signer worker source pin is validated before paths, credentials or RPC are used', () => {
  const enabled = { AUTHORITY_RELAY_ENABLED: '1', AUTHORITY_REQUIRE_FRESH_READINESS: '1' };
  for (const value of invalidPins) {
    assert.throws(() => authorityRelayConfiguration({ ...enabled, BEMINE_FRESH_MACHINE_SOURCE_HEAD: value }),
      /lowercase forty-character/);
    assert.throws(() => createAuthorityRelayService({ machineSourceHead: value }, {
      loadCredential() { assert.fail('Invalid pins must not load a credential.'); },
      createMachineReadiness() { assert.fail('Invalid pins must not start readiness.'); },
    }), /lowercase forty-character/);
  }
  for (const value of [undefined, 'a'.repeat(40)])
    assert.throws(() => authorityRelayConfiguration({ ...enabled, BEMINE_FRESH_MACHINE_SOURCE_HEAD: value }),
      /exact HTTPS journal origin/, 'Valid or absent pins continue through the normal configuration gates.');
});

test('signer passes the exact reviewed worker source pin while leaving graph and default release checks intact', async t => {
  const root = mkdtempSync(join(tmpdir(), 'authority-machine-pin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const gas = Wallet.createRandom(), authority = Wallet.createRandom().address;
  for (const pin of [undefined, '23b48e6adb2a19810eb287a67add5f40b4fb94b9']) {
    let captured, checks = 0, rpcCalls = 0;
    const graph = { freshFactoryVerified: true, freshAuthority: { address: authority,
      codehash: '0x' + '2'.repeat(64) } };
    const service = createAuthorityRelayService({ journal: join(root, 'authority.json'),
      rpcUrl: 'https://example.test/rpc', expectedGasWallet: gas.address,
      requireMachineReadiness: true, machineSourceHead: pin }, {
      trusted: { bundle: { artifacts: { FreshPoolFactory: { abi: [] } } },
        record: { addresses: {} }, freshAuthority: { authority: { address: authority, gasWallet: gas.address } } },
      loadCredential: () => gas.privateKey, store: { close() {} },
      provider: { send: async () => { rpcCalls++; return '0x38'; },
        getBlock: async () => { rpcCalls++; return { number: 1, hash: '0x' + '1'.repeat(64),
          timestamp: Math.floor(Date.now() / 1000) }; }, destroy() {} },
      verifyGraph: async () => { checks++; return graph; },
      createMachineReadiness(options) {
        captured = options;
        return async () => ({ ready: true, sourceHead: options.sourceHead });
      },
    });
    try {
      assert.equal(captured.sourceHead, pin, 'Only the explicit worker pin replaces the default source argument.');
      assert.equal(rpcCalls, 0, 'Constructing the adapter does not poll the chain.');
      assert.deepEqual(await service.readiness(), { ready: true, sourceHead: pin });
      assert.equal(checks, 0, 'The adapter does not eagerly repeat graph verification.');
      assert.equal((await captured.verifyGraph()).freshFactoryVerified, true);
      assert.equal(checks, 1, 'The same fully verified graph closure is supplied to worker readiness.');
      graph.freshFactoryVerified = false;
      await assert.rejects(captured.verifyGraph, /graph is not verified and active/);
    } finally { await service.close(); }
  }
});
