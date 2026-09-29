import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commonSharePreview } from '../lib/share-preview.mjs';
import { createProjectShare } from '../lib/project-share.mjs';
import { createDemoShare } from '../lib/demo-share.mjs';
import { pools } from '../lib/demo-data.js';
import { SHARE_MOTTO_COUNT } from '../lib/share-copy.mjs';

const weighted = text => [...text].reduce((sum, char) => {
  const cp = char.codePointAt(0);
  return sum + (cp <= 0x10ff || cp >= 0x2000 && cp <= 0x200d || cp >= 0x2010 && cp <= 0x201f || cp >= 0x2032 && cp <= 0x2037 ? 1 : 2);
}, 0);

test('single share preview matches both composers and preserves source, poster and project links', () => {
  for (const locale of ['zh', 'en']) for (let mottoIndex = 0; mottoIndex < SHARE_MOTTO_COUNT; mottoIndex++) {
    const models = [
      createProjectShare({ locale, mottoIndex, publicBaseUrl: 'https://tapeout.cc.cd/bemine-v2/', project: {
        name: 'Behemoth', circuitId: (2n ** 256n - 1n).toString(), poolAddress: `0x${'ab'.repeat(20)}`,
        state: 'Funding', remainingShares: 99,
      }}),
      createDemoShare({ locale, mottoIndex, project: pools[0] }),
    ];
    for (const model of models) {
      const original = JSON.stringify(model);
      const preview = commonSharePreview(model);
      const telegram = new URL(preview.telegramUrl);
      const x = new URL(model.xUrl);
      assert.equal(telegram.searchParams.get('text'), preview.text);
      assert.equal(x.searchParams.get('text'), preview.text);
      assert.equal(preview.copyText, `${preview.text}\n${model.url}`);
      assert.equal(telegram.origin, 'https://t.me');
      assert.equal(telegram.pathname, '/share/url');
      assert.equal(telegram.searchParams.get('url'), new URL(model.telegramUrl).searchParams.get('url'));
      assert.ok(weighted(preview.text) + 24 <= 280, `${locale}/${mottoIndex}`);
      assert.equal(JSON.stringify(model), original);
      if (model.demo) assert.match(preview.text, /演示|\[Demo\]/u);
    }
  }
  assert.equal(commonSharePreview(null), null);
});
