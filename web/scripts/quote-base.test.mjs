import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveQuoteBase } from '../lib/quote-base.mjs';
test('isolated preview routes quotes to its own backend while existing production remains compatible', () => {
  assert.equal(resolveQuoteBase('/bemine-v2'), '/bemine-v2/firsto-api');
  assert.equal(resolveQuoteBase('/bemine'), '/pinkuang-deploy/firsto-api');
  assert.equal(resolveQuoteBase(''), '/pinkuang-deploy/firsto-api');
  for (const path of ['//evil.example', '/../../api', '/bemine?secret=1', 'https://evil.example']) assert.throws(() => resolveQuoteBase(path));
});
