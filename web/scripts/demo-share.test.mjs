import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoShareUrl, createDemoShare, DEMO_SHARE_BASE } from '../lib/demo-share.mjs';
import { createProjectShare, DEFAULT_PUBLIC_SHARE_BASE } from '../lib/project-share.mjs';
import { SHARE_MOTTO_COUNT } from '../lib/share-copy.mjs';
import { SHARE_ARTWORKS } from '../lib/share-artwork.mjs';

const project = { id: '16928', name: 'TapeOut', status: 'Funding', funded: 73 };
const weighted = text => [...text].reduce((sum, char) => {
  const cp = char.codePointAt(0);
  return sum + (cp <= 0x10ff || cp >= 0x2000 && cp <= 0x200d || cp >= 0x2010 && cp <= 0x201f || cp >= 0x2032 && cp <= 0x2037 ? 1 : 2);
}, 0);

test('demo links only point to known preview projects with allowlisted source', () => {
  assert.equal(buildDemoShareUrl('16928'), `${DEMO_SHARE_BASE}#detail/16928`);
  for (const bad of [undefined, 'evil', '999999', '../16928', '16928?wallet=abc', 16928, '0x' + 'a'.repeat(40)]) assert.equal(buildDemoShareUrl(bad), null);
  assert.equal(buildDemoShareUrl('16928', 'x&wallet=secret'), null);
  const tg = new URL(buildDemoShareUrl('16928', 'tg'));
  assert.deepEqual([...tg.searchParams], [['source', 'tg']]);
});

test('both language share payloads carry clear demo notice and safe X length', () => {
  for (const locale of ['zh', 'en']) {
    const model = createDemoShare({ project, locale });
    assert.equal(model.demo, true);
    assert.equal(model.remaining, 27);
    assert.match(model.text, locale === 'zh' ? /演示预览.*\n.*\n.*未发生真实交易/u : /\[Demo\].*\n.*\n.*No real transaction/u);
    assert.ok(weighted(model.xText) + 24 <= 280, `${locale} copy fits X with URL`);
    assert.equal(new URL(model.telegramUrl).searchParams.get('text'), model.text);
    assert.equal(new URL(model.xUrl).searchParams.get('text'), model.xText);
    assert.equal(new URL(model.xUrl).origin, 'https://x.com');
    assert.equal(new URL(model.telegramUrl).origin, 'https://t.me');
    const target = new URL(new URL(model.xUrl).searchParams.get('url'));
    assert.equal(target.pathname, '/bemine/share/original.html');
    assert.equal(target.searchParams.get('mode'), 'demo');
    assert.equal(target.searchParams.get('project'), project.id);
  }
});

test('demo slogans rotate without claiming availability for full or inactive projects', () => {
  for (const locale of ['zh', 'en']) {
    const mottos = Array.from({ length: SHARE_MOTTO_COUNT }, (_, mottoIndex) => createDemoShare({ project, locale, mottoIndex }).motto);
    assert.equal(new Set(mottos).size, 18);
    for (let mottoIndex = 0; mottoIndex < SHARE_MOTTO_COUNT; mottoIndex++) {
      const model = createDemoShare({ project, locale, mottoIndex });
      assert.doesNotMatch(model.text, /共持 BEM|共享 BEM|Co-own BEM/u);
      assert.match(model.xText, locale === 'zh' ? /演示.*\n.*\n.*未发生真实交易/u : /\[Demo\].*\n.*\n.*No real transaction/u);
      assert.ok(weighted(model.xText) + 24 <= 280);
      for (const override of [{ funded: 100 }, { funded: undefined }, { status: 'Active' }, { status: 'Listed' }]) {
        const inactive = createDemoShare({ project: { ...project, ...override }, locale, mottoIndex });
        assert.equal(inactive.canSubscribe, false);
        assert.ok(!mottos.includes(inactive.motto));
      }
    }
  }
});

test('each demo poster has matching social landing URLs and preserves direct project navigation', () => {
  for (const artwork of SHARE_ARTWORKS) {
    const model = createDemoShare({ project, posterId: artwork.id });
    assert.equal(model.projectUrl, `${DEMO_SHARE_BASE}#detail/16928`);
    assert.equal(new URL(model.url).pathname, `/bemine/share/${artwork.id}.html`);
    for (const key of ['telegramUrl', 'xUrl']) {
      const target = new URL(new URL(model[key]).searchParams.get('url'));
      assert.equal(target.pathname, `/bemine/share/${artwork.id}.html`);
      assert.equal(target.searchParams.get('mode'), 'demo');
      assert.equal(target.searchParams.get('project'), '16928');
    }
  }
});

test('demo sharing cannot turn arbitrary metadata into public claims', () => {
  assert.equal(createDemoShare({ project: { ...project, name: 'Behemoth' } }), null);
  const model = createDemoShare({ project: { ...project, wallet: 'privatewallet', amount: '98765', confirmed: true, receipt: 'privatehash', text: 'guaranteed returns' } });
  for (const secret of ['privatewallet', '98765', 'privatehash', 'guaranteed returns']) assert.ok(!JSON.stringify(model).includes(secret));
  assert.equal(createDemoShare({ project: { ...project, status: 'Funded' } }).remaining, null);
  assert.equal(createDemoShare({ project: { ...project, funded: -1 } }).remaining, null);
});

test('real sharing remains closed to preview identifiers and demo URLs', () => {
  assert.equal(createProjectShare({ publicBaseUrl: DEMO_SHARE_BASE, project: { name: 'TapeOut', circuitId: '16928', poolAddress: '0x' + 'a'.repeat(40) } }), null);
  assert.equal(createProjectShare({ publicBaseUrl: DEFAULT_PUBLIC_SHARE_BASE, project: { name: 'TapeOut', circuitId: '16928', poolAddress: '16928' } }), null);
});
