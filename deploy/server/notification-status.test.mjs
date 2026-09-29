import assert from 'node:assert/strict';
import test from 'node:test';
import { logNotificationStatus } from './index.mjs';

test('production logs show community failures using only fixed, non-sensitive text', () => {
  const messages = [];
  const log = value => messages.push(value);
  for (const status of ['community_configuration_unavailable', 'community_source_or_delivery_unavailable',
    'community_delivery_blocked', 'community_outcome_unknown', 'community_degraded', 'outcome_unknown']) {
    logNotificationStatus({ status, token: 'secret-token', chatId: '-100123', error: 'secret-error' }, log);
  }
  logNotificationStatus({ status: 'secret-token', error: 'secret-error' }, log);
  assert.equal(messages.length, 6);
  assert(messages.every(message => !/secret|100123/.test(message)));
  assert(messages.some(message => message.includes('Community announcement outcome unknown')));
});
