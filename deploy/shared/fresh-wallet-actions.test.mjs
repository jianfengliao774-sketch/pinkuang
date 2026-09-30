import test from 'node:test';
import assert from 'node:assert/strict';
import { FRESH_WALLET_ACTIONS, isFreshWalletAction } from './fresh-wallet-actions.mjs';
import { FRESH_USER_EXIT_ACTIONS, isFreshUserExit } from './fresh-user-exits.mjs';

test('positive member deposits, share purchases and controlled miner purchases are worker-independent', () => {
  for (const [target, action] of [['pool', 'deposit'], ['portfolio', 'deposit'], ['market', 'fill'],
    ['portfolioMarket', 'fill'], ['pool', 'completeFirstoSale']]) {
    for (const value of ['1', 1n, 1, '9007199254740993', (2n ** 256n - 1n)]) assert.equal(isFreshWalletAction(target, action, value), true);
    for (const value of ['0', 0n, -1n, '-1', 2n ** 256n, false, null, undefined, 1.5, NaN, Infinity,
      Number.MAX_SAFE_INTEGER + 1, '1e18', '0x1', '01', ' 1', {}, [], '9'.repeat(79)])
      assert.equal(isFreshWalletAction(target, action, value), false, `${target}/${action}: ${String(value)}`);
  }
});

test('governance, transfers, list/cancel and existing settlement exits require exactly zero BNB', () => {
  for (const [target, actions] of Object.entries(FRESH_WALLET_ACTIONS)) {
    for (const action of actions.filter(name => !['deposit', 'fill', 'completeFirstoSale'].includes(name))) {
      assert.equal(isFreshWalletAction(target, action), true, `${target}/${action}`);
      assert.equal(isFreshWalletAction(target, action, 0n), true);
      assert.equal(isFreshWalletAction(target, action, '1'), false);
      assert.equal(isFreshWalletAction(target, action, '-1'), false);
    }
  }
  for (const [target, actions] of Object.entries(FRESH_USER_EXIT_ACTIONS))
    for (const action of actions) assert.equal(isFreshWalletAction(target, action, 0n), true);
  assert.equal(isFreshUserExit('pool', 'deposit', 1n), false, 'deposits are not disguised as withdrawals');
});

test('factory, Authority, automatic purchases, mining and cross-type names remain excluded', () => {
  for (const target of ['factory', 'portfolioFactory', 'authority', 'FreshAuthority', 'poolFactory', 'toString', '__proto__', '', null])
    for (const action of ['deposit', 'claim', 'withdrawBnb', 'fill', 'createPool', 'claimFees', 'mine'])
      for (const value of [0n, 1n]) assert.equal(isFreshWalletAction(target, action, value), false);
  for (const target of Object.keys(FRESH_WALLET_ACTIONS))
    for (const action of ['mine', 'buyFromMarket', 'buyAlternativeFromMarket', 'buyFromFirsto', 'buyOfficial', 'buyFirsto',
      'reviewSale', 'claimFees', 'createPool', 'createPortfolio', 'upgradeToAndCall', 'approve', 'transferFrom', 'completeSale',
      'constructor', '__proto__', 'DEPOSIT', ' deposit', '', null])
      for (const value of [0n, 1n]) assert.equal(isFreshWalletAction(target, action, value), false);
  for (const [target, action, value] of [['market', 'deposit', 1n], ['pool', 'fill', 1n], ['pool', 'transfer', 0n],
    ['portfolio', 'claim', 0n], ['pool', 'claimBem', 0n], ['portfolio', 'vote', 0n], ['market', 'executeSale', 0n]])
    assert.equal(isFreshWalletAction(target, action, value), false);
});

test('published target-selector allowlist cannot be mutated by consumers', () => {
  assert(Object.isFrozen(FRESH_WALLET_ACTIONS));
  for (const actions of Object.values(FRESH_WALLET_ACTIONS)) assert(Object.isFrozen(actions));
  assert.throws(() => FRESH_WALLET_ACTIONS.pool.push('mine'));
  assert.throws(() => { FRESH_WALLET_ACTIONS.authority = ['claimFees']; });
});
