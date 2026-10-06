import { Interface, getAddress, keccak256 } from 'ethers';
import { reviewedAuthorityRuntimeMatches } from './product-graph.mjs';

const HASH = /^0x[0-9a-f]{64}$/i;
const ZERO = `0x${'0'.repeat(40)}`;
const same = (a, b) => getAddress(a) === getAddress(b);
function fail(status, message) { const error = new Error(message); error.status = status; throw error; }

async function readPinnedState(provider, trusted, account, blockNumber) {
  const authority = trusted.freshAuthority.authority.address;
  const iface = new Interface(trusted.bundle.artifacts.PlatformAuthority.abi);
  const tag = `0x${blockNumber.toString(16)}`;
  const call = async (method) => iface.decodeFunctionResult(method, await provider.send('eth_call', [
    { to: authority, data: iface.encodeFunctionData(method) }, tag,
  ]))[0];
  const [core, budget, first, second, gasWallet, code] = await Promise.all([
    call('coreFactory'), call('budgetFactory'), call('administratorOne'),
    call('administratorTwo'), call('gasWallet'), provider.getCode(authority, blockNumber),
  ]);
  return { core, budget, first, second, gasWallet, code };
}

/** A single-admin deployment fills both ABI role slots with the same wallet.
 * Only trusted deployment evidence can enable this; browser input cannot. */
export function reviewedSingleAdministrator(trusted) {
  const role = trusted?.freshAuthority?.authority;
  try {
    return !same(role.administratorOne, ZERO)
      && same(role.administratorOne, role.administratorTwo);
  } catch { return false; }
}

/** Fail closed unless this wallet occupies a current role on a canonical BSC block. */
export async function verifyCurrentAuthorityAdministrator(provider, trusted, account, { readState = null } = {}) {
  if (!trusted?.freshAuthority?.authority || !trusted?.bundle?.artifacts?.PlatformAuthority)
    fail(503, 'Reviewed Authority evidence is unavailable.');
  if (BigInt(await provider.send('eth_chainId', [])) !== 56n) fail(503, 'RPC is not BSC mainnet.');
  const block = await provider.getBlock('latest');
  if (!block || !Number.isSafeInteger(block.number) || !HASH.test(block.hash ?? '')
    || !Number.isSafeInteger(block.timestamp)
    || Math.abs(Math.floor(Date.now() / 1000) - block.timestamp) > 90)
    fail(503, 'Current BSC block is unavailable.');
  const authority = trusted.freshAuthority.authority;
  const state = await (readState ?? ((target, signer, number) =>
    readPinnedState(provider, trusted, signer, number)))(authority.address, account, block.number);
  try {
    const { core, budget, first, second, gasWallet, code } = state;
    const expected = trusted.record.addresses;
    if (!same(core, expected.factory) || !same(budget, expected.portfolioFactory)
      || !same(gasWallet, authority.gasWallet)
      || same(first, ZERO) || same(second, ZERO)
      || same(first, second) && !reviewedSingleAdministrator(trusted)
      || same(first, gasWallet) || same(second, gasWallet)
      || !reviewedAuthorityRuntimeMatches(trusted, code)
      || (authority.codehash && keccak256(code).toLowerCase() !== authority.codehash.toLowerCase()))
      fail(409, 'Reviewed Authority identity or current roles changed.');
    const [canonical, chainId] = await Promise.all([
      provider.getBlock(block.number), provider.send('eth_chainId', []),
    ]);
    if (!canonical || canonical.hash?.toLowerCase() !== block.hash.toLowerCase()
      || BigInt(chainId) !== 56n) fail(503, 'Current BSC block changed during role verification.');
    if (!same(account, first) && !same(account, second)) fail(403, 'Administrator wallet is required.');
    return { blockNumber: block.number, blockHash: block.hash };
  } catch (error) {
    if (Number.isInteger(error.status)) throw error;
    fail(409, 'Reviewed Authority identity or current roles changed.');
  }
}
