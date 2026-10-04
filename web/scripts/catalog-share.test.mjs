import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogShare } from '../lib/catalog-share.mjs';

test('catalog sharing opens the public directory, independent of a wallet or selected miner', () => {
  const model = createCatalogShare({ publicBaseUrl: 'https://tapeout.cc.cd/bemine-v5/', locale: 'zh' });
  assert.equal(model.url, 'https://tapeout.cc.cd/bemine-v5/#pools');
  for (const name of ['telegramUrl', 'xUrl']) {
    const link = new URL(model[name]);
    assert.equal(link.searchParams.get('url'), model.url);
    assert.equal(link.searchParams.get('text'), `${model.title}\n${model.text}`);
  }
  assert.match(createCatalogShare({ publicBaseUrl: 'https://tapeout.cc.cd/bemine-v5/', locale: 'en' }).text, /one share/);
});
test('catalog sharing rejects untrusted origins, private parameters and unrelated paths', () => {
  for (const publicBaseUrl of ['https://example.com/bemine-v5/', 'http://tapeout.cc.cd/bemine-v5/',
    'https://tapeout.cc.cd/bemine-v5/?wallet=0x1234', 'https://tapeout.cc.cd/bemine-v5/#detail/private',
    'https://user:password@tapeout.cc.cd/bemine-v5/', 'https://tapeout.cc.cd/admin/']) {
    assert.equal(createCatalogShare({ publicBaseUrl }), null);
  }
});
