import { getAddress } from 'ethers';
import { abi } from './chain-client.mjs';
import { freshIdentityReadable } from './fresh-boot-recovery.mjs';
import { isFreshWalletAction, FRESH_WALLET_ACTIONS } from '../../deploy/shared/fresh-wallet-actions.mjs';

export { isFreshWalletAction, FRESH_WALLET_ACTIONS };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** Member wallet operations use the verified deployment, not worker liveness. */
export function freshWalletActionReady(config, targetType, action) {
  return config?.stage === 'fresh-active' && config.freshFactoryVerified === true
    && freshIdentityReadable(config) && Object.hasOwn(FRESH_WALLET_ACTIONS, targetType)
    && FRESH_WALLET_ACTIONS[targetType].includes(action);
}

/** Classify exact unsigned calldata; the journal still verifies target registration and value. */
export function isFreshWalletActionTransaction(config, transaction, action) {
  try {
    if (config?.stage !== 'fresh-active' || BigInt(transaction.chainId) !== 56n) return false;
    const target = getAddress(transaction.to), value = BigInt(transaction.value ?? 0);
    const budget = typeof action === 'object' && ['portfolio', 'portfolioMarket', 'portfolioFactory'].includes(action?.targetType);
    const factory = budget ? config.portfolioFactory : config.factory;
    const market = budget ? config.portfolioMarket : config.shareMarket;
    const targetType = same(target, factory) ? (budget ? 'portfolioFactory' : 'factory')
      : same(target, market) ? (budget ? 'portfolioMarket' : 'market') : budget ? 'portfolio' : 'pool';
    if (typeof action === 'object' && action.targetType && action.targetType !== targetType) return false;
    const contract = targetType === 'pool' ? abi.PoolVault : targetType === 'portfolio' ? abi.BudgetPortfolioVault
      : ['market', 'portfolioMarket'].includes(targetType) ? abi.ShareMarket : null;
    const parsed = contract?.parseTransaction({ data: transaction.data, value });
    const kind = typeof action === 'string' ? action : action?.kind;
    return !!parsed && freshWalletActionReady(config, targetType, parsed.name)
      && (kind === parsed.name || kind === 'withdraw' && parsed.name === 'withdrawBnb')
      && same(contract.encodeFunctionData(parsed.fragment, parsed.args), transaction.data)
      && isFreshWalletAction(targetType, parsed.name, value);
  } catch { return false; }
}
