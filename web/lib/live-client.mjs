import { BrowserProvider, getAddress, toQuantity } from 'ethers';
import { ARTIFACT_DIGEST, CHAIN_ID, personalPoolAction, readPoolSnapshot } from './chain-client.mjs';
import { prepareGovernanceAction } from './live-governance.mjs';
import { prepareMarketAction } from './live-market.mjs';

const ROOT = `${process.env.NEXT_PUBLIC_BASE_PATH || ''}/api/live`;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const same = (left, right) => getAddress(left) === getAddress(right);

async function assertSelectedWallet(wallet, account) {
  const selected = await wallet.request({ method: 'eth_accounts' });
  if (!Array.isArray(selected) || !selected[0] || !same(selected[0], account) ||
      BigInt(await wallet.request({ method: 'eth_chainId' })) !== CHAIN_ID) {
    throw new Error('Wallet account or chain changed; reconnect before sending.');
  }
}

async function request(path, { method = 'GET', account, body, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${ROOT}${path}`, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(account ? { 'X-Bemine-Account': getAddress(account) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || `Live server unavailable (HTTP ${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return result;
}

export async function liveConfig(fetchImpl) {
  let result;
  try { result = await request('/config', { fetchImpl }); }
  catch (error) {
    if (error.status === 404) throw new Error('服务器尚未启用真实交易服务，请先完成 BSC 部署验收。');
    throw error;
  }
  if (result.chainId !== 56 || !result.journal || !result.factory || !result.lens || !result.market ||
      result.artifactDigest?.toLowerCase() !== ARTIFACT_DIGEST.toLowerCase()) {
    throw new Error('Live deployment configuration is incomplete.');
  }
  for (const field of ['factory', 'lens', 'market']) getAddress(result[field]);
  return Object.freeze(result);
}

export async function indexPage(config, path, fetchImpl) {
  if (!/^\/v1\/(pools|orders|activity|stats|accounts\/0x[0-9a-fA-F]{40}\/pools)(\?|$)/.test(path)) throw new Error('Unsupported index page.');
  const result = await request(`/index${path}`, { fetchImpl });
  if (!result.source?.complete || result.source.chainId !== 56 ||
      !same(result.source.factory, config.factory) || !same(result.source.market, config.market)) {
    throw new Error('Server index identity or completeness changed.');
  }
  return result;
}

export async function connectLiveWallet(wallet) {
  if (!wallet?.request) throw new Error('Install or open a wallet that supports BSC.');
  const accounts = await wallet.request({ method: 'eth_requestAccounts' });
  if (!Array.isArray(accounts) || !accounts[0]) throw new Error('Wallet did not return an account.');
  const account = getAddress(accounts[0]);
  let chain = BigInt(await wallet.request({ method: 'eth_chainId' }));
  if (chain !== CHAIN_ID) {
    await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] });
    chain = BigInt(await wallet.request({ method: 'eth_chainId' }));
    if (chain !== CHAIN_ID) throw new Error('Switch your wallet to BSC mainnet (chain 56).');
  }
  return account;
}

export async function liveSession(wallet, account, fetchImpl) {
  try {
    const current = await request('/session', { account, fetchImpl });
    if (same(current.account, account)) return current;
  } catch (error) { if (error.status !== 401 && error.status !== 403) throw error; }
  const challenge = await request('/challenge', { method: 'POST', body: { account }, fetchImpl });
  if (typeof challenge.message !== 'string' || typeof challenge.nonce !== 'string') throw new Error('Invalid wallet challenge.');
  const signature = await new BrowserProvider(wallet, 'any').getSigner(account).then(signer => signer.signMessage(challenge.message));
  const session = await request('/session', { method: 'POST', body: { account, nonce: challenge.nonce, signature }, fetchImpl });
  if (!same(session.account, account)) throw new Error('Wallet session belongs to another account.');
  return session;
}

export async function liveIntent(account, fetchImpl) {
  return request('/intent', { account, fetchImpl });
}

export async function recoverLiveHash(account, id, hash, fetchImpl) {
  if (!hashPattern.test(hash)) throw new Error('Enter the full BSC transaction hash.');
  return request('/hash', { method: 'POST', account, body: { id, hash }, fetchImpl });
}

export async function abandonPreparedIntent(account, intent, fetchImpl) {
  if (!intent?.active || intent.status !== 'prepared' || !intent.id || !same(intent.account, account)) {
    throw new Error('Only a never-armed server intent can be abandoned without a wallet transaction.');
  }
  return request('/abandon', { method: 'POST', account, body: { id: intent.id }, fetchImpl });
}

/** A wallet-signed same-nonce self-transfer can safely retire an ambiguous intent after finality. */
export async function cancelLiveIntent({ wallet, account, intent, fetchImpl }) {
  if (!intent?.active || !['armed', 'submitted'].includes(intent.status) ||
      !Number.isSafeInteger(intent.nonce) || intent.nonce < 0 || !intent.id ||
      !same(intent.account, account)) throw new Error('No matching pending transaction to cancel.');
  await assertSelectedWallet(wallet, account);
  const saved = (await liveIntent(account, fetchImpl)).intent;
  if (!saved?.active || saved.id !== intent.id || saved.nonce !== intent.nonce) throw new Error('Server pending transaction changed; refresh before cancelling.');
  await assertSelectedWallet(wallet, account);
  let hash;
  try {
    hash = await wallet.request({ method: 'eth_sendTransaction', params: [{ from: account, to: account,
      value: '0x0', data: '0x', nonce: toQuantity(intent.nonce), gas: '0x5208', chainId: '0x38' }] });
  } catch (error) {
    throw new Error(`Cancellation did not return a hash. The original intent remains pending; inspect the wallet before retrying. ${error.message || ''}`);
  }
  if (typeof hash !== 'string' || !hashPattern.test(hash)) throw new Error('Wallet returned no valid cancellation hash; original intent remains pending.');
  try { return (await recoverLiveHash(account, intent.id, hash, fetchImpl)).intent; }
  catch (error) { throw new Error(`Cancellation hash ${hash} may have broadcast, but the server could not save it. Recover this hash; do not send again. ${error.message}`); }
}

async function prepareLiveSend({ wallet, config, account, fetchImpl, onState }) {
  if (!wallet?.request) throw new Error('Wallet is unavailable.');
  if (!config?.journal || config.chainId !== 56 || config.artifactDigest?.toLowerCase() !== ARTIFACT_DIGEST.toLowerCase()) {
    throw new Error('Reviewed live deployment configuration is unavailable or out of date.');
  }
  await assertSelectedWallet(wallet, account);
  const prior = await liveIntent(account, fetchImpl);
  if (prior.intent?.active) throw new Error('A previous transaction needs finality or hash recovery first.');
  onState('reading');
}

/** Save a target-bound intent before requesting the wallet signature; never retry an ambiguous broadcast. */
async function recordAndSend({ wallet, config, account, pool, target, transaction, extra = {}, fetchImpl, onState }) {
  if (!same(transaction.from, account) || !same(transaction.to, target) || transaction.chainId !== '0x38') {
    throw new Error('Prepared transaction no longer matches the reviewed wallet, target or BSC chain.');
  }
  onState('simulating');
  await wallet.request({ method: 'eth_call', params: [transaction, 'latest'] });
  const gas = BigInt(await wallet.request({ method: 'eth_estimateGas', params: [transaction] }));
  const nonce = Number(await wallet.request({ method: 'eth_getTransactionCount', params: [account, 'pending'] }));
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Wallet nonce is unavailable.');
  await assertSelectedWallet(wallet, account);
  const prepared = await request('/intent', { method: 'POST', account, fetchImpl,
    body: { account, chainId: 56, artifactDigest: config.artifactDigest, target, pool, nonce,
      data: transaction.data, value: BigInt(transaction.value).toString(), ...extra } });
  const intent = prepared.intent;
  if (!intent?.id || intent.nonce !== nonce || !same(intent.pool, pool) || !same(intent.target, target) ||
      intent.data !== transaction.data.toLowerCase() ||
      intent.value !== BigInt(transaction.value).toString()) throw new Error('Server did not confirm the exact transaction intent.');
  const armed = await request('/arm', { method: 'POST', account, fetchImpl, body: { id: intent.id } });
  if (armed.intent?.id !== intent.id || armed.intent?.status !== 'armed') throw new Error('Server did not arm the saved intent for wallet signing.');
  await assertSelectedWallet(wallet, account);
  onState('signing');
  let hash;
  try {
    hash = await wallet.request({ method: 'eth_sendTransaction', params: [{ ...transaction, nonce: toQuantity(nonce),
      gas: toQuantity(gas + gas / 5n), chainId: '0x38' }] });
  } catch (error) {
    const wrapped = new Error(`Wallet did not return a hash. The saved intent remains pending at nonce ${nonce}; inspect the wallet and recover its hash before retrying. ${error.message || ''}`);
    wrapped.cause = error;
    throw wrapped;
  }
  onState('recording');
  if (typeof hash !== 'string' || !hashPattern.test(hash)) throw new Error('Wallet returned no valid hash; saved intent remains pending.');
  try { return (await recoverLiveHash(account, intent.id, hash, fetchImpl)).intent; }
  catch (error) { throw new Error(`Transaction hash ${hash} was returned but the server could not save it. Copy this hash and use recovery; do not send again. ${error.message}`); }
}

/** One wallet transaction at a time. Pool state is reread before the server records its exact intent. */
export async function sendLivePoolAction({ wallet, config, account, pool, action, quantity, fetchImpl, onState = () => {} }) {
  await prepareLiveSend({ wallet, config, account, fetchImpl, onState });
  const snapshot = await readPoolSnapshot(wallet, { factory: config.factory, account, pools: [pool] });
  if (!same(snapshot.lens, config.lens)) throw new Error('Configured Lens differs from on-chain Factory.');
  const transaction = personalPoolAction(snapshot, pool, account, action, quantity);
  return recordAndSend({ wallet, config, account, pool, target: pool, transaction, fetchImpl, onState });
}

/** A fresh Market snapshot binds order identity and quote; the server independently rechecks before signing. */
export async function sendLiveMarketAction({ wallet, config, account, action, fetchImpl, onState = () => {} }) {
  await prepareLiveSend({ wallet, config, account, fetchImpl, onState });
  const prepared = await prepareMarketAction(wallet, { factory: config.factory, market: config.market, account, action });
  const pool = prepared.quote.pool ?? config.market;
  const extra = action.kind === 'fill' ? { expected: { seller: action.expectedSeller,
    pricePerUnitWei: action.expectedPricePerUnitWei } } : action.kind === 'list' ? { allowFree: action.allowFree === true } : {};
  return recordAndSend({ wallet, config, account, pool, target: config.market,
    transaction: prepared.transaction, extra, fetchImpl, onState });
}

/** The complete sale payment and candidate ID are re-read before both journal and wallet signing. */
export async function sendLiveGovernanceAction({ wallet, config, account, pool, action, fetchImpl, onState = () => {} }) {
  await prepareLiveSend({ wallet, config, account, fetchImpl, onState });
  const prepared = await prepareGovernanceAction(wallet, { factory: config.factory, pool, account, action });
  return recordAndSend({ wallet, config, account, pool, target: pool,
    transaction: prepared.transaction, fetchImpl, onState });
}
