import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Interface } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import genesisContracts from '../lib/contracts.genesis.json' with { type: 'json' };
import genesisManifest from '../public/data/frontend-manifest.json' with { type: 'json' };

test('genesis ABI is extracted from independently pinned original deployment artifacts', () => {
  const path = new URL('../../deploy/public/upgrade-genesis/genesis-artifacts.json', import.meta.url);
  const bytes = readFileSync(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    '22e4fb90b537c3f2bfb864ee43e7be5005dfa864640be641a476adb7681b867b');
  const bundle = JSON.parse(bytes.toString('utf8'));
  assert.equal(genesisContracts.artifactDigest, genesisManifest.artifactDigest);
  // The fresh Factory ABI must not retain constants for unrelated old deployments.
  for (const selector of ['FIRST_MAINNET_FACTORY()', 'PREVIOUS_MAINNET_FACTORY()', 'PREVIOUS_POOL_13043()'])
    assert.equal(abi.PoolFactory.getFunction(selector), null, `${selector} belongs only to an obsolete deployment`);
  for (const [name, fragments] of Object.entries(genesisContracts.abis)) {
    assert.deepEqual(fragments, bundle.artifacts[name].abi, `${name} old ABI drifted`);
    const original = new Interface(fragments);
    for (const fragment of original.fragments.filter(item => item.type === 'function')) {
      const current = abi[name].getFunction(fragment.format('sighash'));
      assert.equal(current?.format('sighash'), fragment.format('sighash'),
        `${name}.${fragment.name} cannot be called by the transitional frontend`);
      assert.deepEqual(current?.outputs.map(output => output.format('sighash')),
        fragment.outputs.map(output => output.format('sighash')),
        `${name}.${fragment.name} return values cannot be decoded by the transitional frontend`);
    }
  }
});
