import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeArtworkShareUrl, resolveArtworkShareTarget } from '../lib/share-landing.mjs';
import { SHARE_ARTWORKS } from '../lib/share-artwork.mjs';

const pool = `0x${'a1'.repeat(20)}`;
const origin = 'https://tapeout.cc.cd';

test('every artwork preserves the same verified project and attribution through its static landing', () => {
  for (const art of SHARE_ARTWORKS) for (const source of [undefined, 'tg', 'x']) for (const demo of [true, false]) {
    const path = demo ? '/bemine/preview.html' : '/bemine/';
    const id = demo ? '16928' : pool;
    const direct = `${origin}${path}${source ? `?source=${source}` : ''}#detail/${id}`;
    const invitation = new URL(makeArtworkShareUrl(direct, art.id));
    assert.equal(invitation.origin, origin);
    assert.equal(invitation.pathname, `/bemine/share/${art.id}.html`);
    assert.equal(invitation.searchParams.get('project'), id);
    assert.equal(resolveArtworkShareTarget(invitation.search), direct.slice(origin.length));
    assert.equal(invitation.hash, '');
  }
});

test('landing cannot redirect to an injected URL, wallet, factory or arbitrary project', () => {
  const bad = [
    '', '?mode=live', '?mode=demo&project=999999', '?mode=demo&project=' + pool,
    '?mode=live&project=16928', '?mode=live&project=0x' + '0'.repeat(40),
    `?mode=live&project=${pool}&next=https://evil.example`,
    `?mode=live&project=${pool}&factory=${pool}`, '?mode=demo&project=16928&source=evil',
    '?mode=demo&project=16928&project=16210', '?mode=demo&mode=live&project=16928',
    '?mode=demo&project=16928&source=tg&source=x', '?mode=live&project=//evil.example',
    '?mode=demo&project=16928%23detail/16210', '?mode=unknown&project=16928',
  ];
  for (const input of bad) assert.equal(resolveArtworkShareTarget(input), null, input);
  assert.equal(resolveArtworkShareTarget('?mode=demo&project=16928', '//evil.example'), null);
  assert.equal(resolveArtworkShareTarget('?mode=demo&project=16928', '', false), '/preview#detail/16928');
});

test('invitation builder only wraps trusted direct project links and allowlisted artwork', () => {
  for (const input of [null, undefined, '', 'https://evil.example/bemine/#detail/' + pool,
    'http://tapeout.cc.cd/bemine/#detail/' + pool, 'https://user:pass@tapeout.cc.cd/bemine/#detail/' + pool,
    `${origin}/bemine/#home`, `${origin}/bemine/?factory=${pool}#detail/${pool}`,
    `${origin}/bemine/?source=tg&source=x#detail/${pool}`, `${origin}/bemine/preview.html#detail/99999`,
    `${origin}/bemine/preview.html?source=evil#detail/16928`]) assert.equal(makeArtworkShareUrl(input, 'anime'), null);
  for (const art of ['../../evil', 'https://evil.example', undefined, null]) {
    assert.equal(new URL(makeArtworkShareUrl(`${origin}/bemine/#detail/${pool}`, art)).pathname, '/bemine/share/original.html');
  }
});
