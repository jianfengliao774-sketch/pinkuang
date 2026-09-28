import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTIFICATION_BOT, notificationBase, notificationHistoryKey, notificationMessage, notificationPromptKind,
  notificationRequest, notificationTarget, ownsPurchasedMiner, readNotificationHistory, sameNotificationAccount,
  telegramBindingUrl } from '../lib/notifications.mjs';

const account = `0x${'a'.repeat(40)}`, other = `0x${'b'.repeat(40)}`, factory = `0x${'c'.repeat(40)}`;
test('purchase prompts require verified ownership after actual purchase, including escrowed shares', () => {
  for (const status of ['Funding', 'Funded', 'Closed', 'Refunding', 'Unknown'])
    assert.equal(ownsPurchasedMiner([{ trusted: true, status, shares: 10n }]), false, status);
  assert.equal(ownsPurchasedMiner([{ trusted: false, status: 'Active', shares: 10n }]), false);
  assert.equal(ownsPurchasedMiner([{ trusted: true, status: 'Active', shares: 0n, lockedShares: 1n }]), true);
  assert.equal(ownsPurchasedMiner([{ trusted: true, status: 'Listed', shares: 1n }]), true);
  assert.equal(ownsPurchasedMiner([{ trusted: true, status: 'Active', shares: 0n, claimableBEM: 100n }]), false);
  assert.equal(ownsPurchasedMiner([{ trusted: true, status: 'Active', shares: 'bad' }]), false);
});
test('skip is wallet-scoped, subscription does not prompt, successful first claim reminds once', () => {
  const input = { eligible: true, route: 'overview', connected: false, account };
  assert.equal(notificationPromptKind(input), 'purchase');
  assert.equal(notificationPromptKind({ ...input, route: 'pools' }), null);
  assert.equal(notificationPromptKind({ ...input, history: { purchasePromptSeen: true } }), null);
  assert.equal(notificationPromptKind({ ...input, connected: true }), null);
  const claim = { status: 'confirmed', finalized: true, action: 'claim', account };
  assert.equal(notificationPromptKind({ ...input, route: 'rewards', history: { purchasePromptSeen: true }, claim }), 'claim');
  for (const change of [{ status: 'pending' }, { finalized: false }, { action: 'deposit' }, { account: other }])
    assert.equal(notificationPromptKind({ ...input, eligible: false, claim: { ...claim, ...change } }), null);
  assert.equal(notificationPromptKind({ ...input, history: { purchasePromptSeen: true, claimReminderSeen: true }, claim }), null);
  assert.notEqual(notificationHistoryKey(account, factory), notificationHistoryKey(other, factory));
  assert.equal(notificationHistoryKey(account, factory), notificationHistoryKey(account.toUpperCase().replace('0X', '0x'), factory));
  assert.equal(notificationHistoryKey('not a wallet', factory), null);
  assert.equal(sameNotificationAccount(account, other), false);
  assert.deepEqual(readNotificationHistory({ getItem() { throw Error('private browsing'); } }, 'key'), {});
});
test('Telegram links cannot navigate to arbitrary sites or bot accounts', () => {
  const valid = `https://t.me/${NOTIFICATION_BOT}?start=abc_DEF-0123`;
  assert.equal(telegramBindingUrl(valid), valid);
  for (const url of ['javascript:alert(1)', 'https://evil.test/bot?start=abc', `https://t.me.evil.test/${NOTIFICATION_BOT}?start=abc`,
    'https://t.me/OtherBot?start=abc', `https://t.me/${NOTIFICATION_BOT}?start=abc&redirect=evil`, `https://user:pass@t.me/${NOTIFICATION_BOT}?start=abc`,
    `https://t.me/${NOTIFICATION_BOT}?start=${'a'.repeat(65)}`, `https://t.me/${NOTIFICATION_BOT}?start=abc#unsafe`])
    assert.equal(telegramBindingUrl(url), null, url);
});
test('API stays same-origin and binds authenticated reads to the selected wallet', async () => {
  assert.equal(notificationBase({ journalBase: '/bemine/api/journal/' }), '/bemine/api/journal/notifications');
  for (const base of ['https://evil.test/api', '//evil.test/api', '/api/../private', '/api?x=y'])
    assert.throws(() => notificationBase({ journalBase: base }));
  const calls = [];
  const fetcher = async (url, options) => { calls.push([url, options]); return { ok: true, json: async () => ({ connected: false }) }; };
  await notificationRequest({ config: { journalBase: '/bemine/api/journal' }, path: 'status', account, fetcher });
  assert.equal(calls[0][0], '/bemine/api/journal/notifications/status');
  assert.equal(calls[0][1].headers['X-Pinkuang-Account'], account);
  assert.equal(calls[0][1].credentials, 'same-origin');
  assert.equal(calls[0][1].method, 'GET');
  await notificationRequest({ path: 'capabilities', fetcher });
  assert.equal(calls[1][1].headers['X-Pinkuang-Account'], undefined);
  await assert.rejects(notificationRequest({ path: 'status', account: 'invalid', fetcher }));
  await assert.rejects(notificationRequest({ path: '../session', account, fetcher }));
  assert.equal(calls.length, 2);
  await assert.rejects(notificationRequest({ path: 'status', account, fetcher: async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }) }), e => e.status === 401);
});
test('inbox links use verified pool-shaped addresses, bilingual copy distinguishes votes, listings and actual sales', () => {
  assert.equal(notificationTarget({ payload: { pool: account } }), `#detail/${account}`);
  assert.equal(notificationTarget({ payload: { pool: account, projectKind: 'portfolio' } }), `#portfolio/${account}`);
  assert.equal(notificationTarget({ payload: { pool: account, projectKind: 'javascript:bad' } }), `#detail/${account}`);
  assert.equal(notificationTarget({ payload: { pool: 'javascript:alert(1)' } }), '#governance');
  const payload = { pool: account, circuitId: '16210', proposalId: '1', priceWei: '6500000000000000000', endsAt: 1801000000 };
  assert.match(notificationMessage({ kind: 'proposal', payload }, 'zh').body, /6\.50000 BNB/);
  assert.match(notificationMessage({ kind: 'listed', payload: { ...payload, priceWei: '75500000000000001' } }, 'en').body, /0\.07550 BNB/);
  assert.match(notificationMessage({ kind: 'listed', payload: { ...payload, priceWei: '1' } }, 'zh').body, /<0\.00001 BNB/);
  assert.equal(payload.priceWei, '6500000000000000000');
  assert.match(notificationMessage({ kind: 'proposal', payload }, 'en').body, /connect your wallet/);
  assert.match(notificationMessage({ kind: 'vote_closed', payload: { ...payload, passed: true } }, 'zh').body, /截止后不能执行/);
  assert.match(notificationMessage({ kind: 'listed', payload }, 'en').body, /not a completed sale/);
  assert.doesNotMatch(notificationMessage({ kind: 'completed', payload }, 'en').body, /6.5/);
});
