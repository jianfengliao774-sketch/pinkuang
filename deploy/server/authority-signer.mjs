/** Private v4 Authority signer. This process has no public TCP listener. */
import { unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Wallet, getAddress } from 'ethers';
import { authorityRelayConfiguration, createAuthorityRelayService } from './authority-relay-api.mjs';
import { readKeeperPrivateKey } from '../scripts/keeper-credential.mjs';
import { AUTHORITY_SOCKET, createAuthoritySignerServer, listenAuthoritySigner,
  readAuthorityIpcKey } from './authority-ipc.mjs';

export async function startAuthoritySigner(env = process.env, dependencies = {}) {
  const attestOnly = env.AUTHORITY_SIGNER_ATTEST_ONLY === '1';
  if (env.AUTHORITY_RELAY_SOCKET !== AUTHORITY_SOCKET
    || attestOnly && env.AUTHORITY_RELAY_ENABLED !== '0'
    || !attestOnly && env.AUTHORITY_RELAY_ENABLED !== '1'
    || env.AUTHORITY_SIGNER_ATTEST_ONLY && !['0', '1'].includes(env.AUTHORITY_SIGNER_ATTEST_ONLY))
    throw new Error('Independent Authority signer is disabled or has an unreviewed socket.');
  if (!env.CREDENTIALS_DIRECTORY || env.KEEPER_PRIVATE_KEY
    || !env.DEPLOYMENT_JOURNAL_ORIGIN?.startsWith('https://')
    || new URL(env.DEPLOYMENT_JOURNAL_ORIGIN).origin !== env.DEPLOYMENT_JOURNAL_ORIGIN)
    throw new Error('Independent Gas attestation requires a protected credential and exact HTTPS origin.');
  const attestationOrigin = env.AUTHORITY_ATTESTATION_ORIGIN ?? env.DEPLOYMENT_JOURNAL_ORIGIN;
  if (!attestationOrigin?.startsWith('https://') || new URL(attestationOrigin).origin !== attestationOrigin)
    throw new Error('Exact HTTPS attestation origin is required.');
  const key = dependencies.key ?? readAuthorityIpcKey(env);
  const gasWallet = dependencies.wallet ?? new Wallet(readKeeperPrivateKey(env));
  if (getAddress(gasWallet.address) !== getAddress(env.BEMINE_EXPECTED_GAS_WALLET))
    throw new Error('Gas credential public address differs from the reviewed public address.');
  const config = attestOnly ? null : authorityRelayConfiguration(env);
  const relay = attestOnly ? null : createAuthorityRelayService(config, {
    ...dependencies.relayDependencies,
    // The public journal authenticates the cookie before issuing a short-lived
    // HMAC assertion. This process independently verifies that assertion and
    // every administrator signature, live graph, nonce, role and Gas bound.
    store: { close() {} },
    authenticateAccount: req => {
      if (!req.authorityIpcAccount) throw new Error('Authority IPC account is missing.');
      return req.authorityIpcAccount;
    },
  });
  const server = createAuthoritySignerServer(relay, key, {
    attestation: { wallet: gasWallet, origin: attestationOrigin },
    machine: { gasWallet: gasWallet.address, origin: env.DEPLOYMENT_JOURNAL_ORIGIN },
  });
  try { await listenAuthoritySigner(server); }
  catch (error) { await relay?.close(); throw error; }
  const close = async () => {
    await new Promise(resolve => server.close(resolve));
    await relay?.close();
    try { unlinkSync(AUTHORITY_SOCKET); } catch { /* systemd may remove RuntimeDirectory. */ }
  };
  return { server, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const signer = await startAuthoritySigner();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    void signer.close().then(() => process.exit(0));
  });
}
