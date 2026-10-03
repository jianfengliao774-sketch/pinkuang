import assert from 'node:assert/strict';
import test from 'node:test';
import { Wallet } from 'ethers';
import { gasSignerAttestationMessage, verifyGasSignerAttestation } from '../shared/gas-signer-attestation.mjs';

test('only the isolated Gas key can prove one exact v4 deployment challenge', async () => {
  const gas = Wallet.createRandom(), deployment = Wallet.createRandom();
  const challenge = {
    chainId: 56, origin: 'https://tapeout.cc.cd', deploymentAccount: deployment.address,
    deploymentId: `1780000000000-${deployment.address}`,
    artifactDigest: `0x${'a'.repeat(64)}`, expectedGasWallet: gas.address,
    nonce: `0x${'b'.repeat(64)}`,
  };
  const signature = await gas.signMessage(gasSignerAttestationMessage(challenge));
  assert.equal(verifyGasSignerAttestation(challenge, { gasWallet: gas.address, signature }), true);
  for (const patch of [
    { nonce: `0x${'c'.repeat(64)}` }, { artifactDigest: `0x${'d'.repeat(64)}` },
    { deploymentId: `1780000000001-${deployment.address}` },
    { deploymentAccount: Wallet.createRandom().address }, { origin: 'https://example.org' },
  ]) assert.equal(verifyGasSignerAttestation({ ...challenge, ...patch },
    { gasWallet: gas.address, signature }), false);
  const forged = await deployment.signMessage(gasSignerAttestationMessage(challenge));
  assert.equal(verifyGasSignerAttestation(challenge, { gasWallet: gas.address, signature: forged }), false);
});
