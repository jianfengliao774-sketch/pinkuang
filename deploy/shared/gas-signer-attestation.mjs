import { getAddress, verifyMessage } from 'ethers';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

/** A fixed EIP-191 domain; the isolated Gas signer never signs caller-supplied text. */
export function gasSignerAttestationMessage(challenge) {
  if (!challenge || typeof challenge !== 'object' || Array.isArray(challenge)
    || Object.keys(challenge).sort().join(',') !== [
      'artifactDigest', 'chainId', 'deploymentAccount', 'deploymentId',
      'expectedGasWallet', 'nonce', 'origin',
    ].join(',')) throw new Error('Invalid Gas signer attestation challenge.');
  const { artifactDigest, chainId, deploymentAccount, deploymentId,
    expectedGasWallet, nonce, origin } = challenge;
  const parsedOrigin = new URL(origin);
  if (chainId !== 56 || typeof origin !== 'string'
    || parsedOrigin.origin !== origin
    || !(parsedOrigin.protocol === 'https:'
      || parsedOrigin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsedOrigin.hostname))
    || !ID.test(deploymentId ?? '')
    || !HASH.test(artifactDigest ?? '') || !HASH.test(nonce ?? '')
    || getAddress(deploymentAccount) !== deploymentAccount
    || getAddress(expectedGasWallet) !== expectedGasWallet)
    throw new Error('Invalid Gas signer attestation challenge.');
  return [
    'BEMine v4 Gas signer attestation v1',
    `chainId: ${chainId}`,
    `origin: ${origin}`,
    `deploymentAccount: ${deploymentAccount}`,
    `deploymentId: ${deploymentId}`,
    `artifactDigest: ${artifactDigest.toLowerCase()}`,
    `expectedGasWallet: ${expectedGasWallet}`,
    `nonce: ${nonce.toLowerCase()}`,
  ].join('\n');
}

export function verifyGasSignerAttestation(challenge, proof) {
  try {
    const message = gasSignerAttestationMessage(challenge);
    if (!proof || typeof proof !== 'object' || Array.isArray(proof)
      || typeof proof.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(proof.signature)
      || getAddress(proof.gasWallet) !== challenge.expectedGasWallet) return false;
    return getAddress(verifyMessage(message, proof.signature)) === challenge.expectedGasWallet;
  } catch { return false; }
}
