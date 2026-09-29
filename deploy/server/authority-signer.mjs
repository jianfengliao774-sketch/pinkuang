/** Private v4 Authority signer. This process has no public TCP listener. */
import { unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { authorityRelayConfiguration, createAuthorityRelayService } from './authority-relay-api.mjs';
import { AUTHORITY_SOCKET, createAuthoritySignerServer, listenAuthoritySigner,
  readAuthorityIpcKey } from './authority-ipc.mjs';

export async function startAuthoritySigner(env = process.env, dependencies = {}) {
  if (env.AUTHORITY_RELAY_ENABLED !== '1' || env.AUTHORITY_RELAY_SOCKET !== AUTHORITY_SOCKET)
    throw new Error('Independent Authority signer is disabled or has an unreviewed socket.');
  const key = dependencies.key ?? readAuthorityIpcKey(env);
  const config = authorityRelayConfiguration(env);
  const relay = createAuthorityRelayService(config, {
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
  const server = createAuthoritySignerServer(relay, key);
  try { await listenAuthoritySigner(server); }
  catch (error) { await relay.close(); throw error; }
  const close = async () => {
    await new Promise(resolve => server.close(resolve));
    await relay.close();
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
