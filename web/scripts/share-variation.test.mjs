import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHARE_ARTWORKS, normalizeSharePoster, shareArtwork } from '../lib/share-artwork.mjs';
import { SHARE_MOTTO_COUNT, shareMotto } from '../lib/share-copy.mjs';
import { SHARE_VARIATION_COUNT, SHARE_VARIATION_STORAGE_KEY, shareRandom, selectShareVariation, createShareVariationSession } from '../lib/share-variation.mjs';

test('poster identities and asset names are an exact nine-item whitelist', () => {
  assert.deepEqual(SHARE_ARTWORKS.map(artwork => artwork.id), ['original', 'anime', 'real', 'finance', 'tech', 'future', 'papercraft', 'space', 'ink']);
  assert.equal(new Set(SHARE_ARTWORKS.map(artwork => artwork.base)).size, 9);
  for (const artwork of SHARE_ARTWORKS) {
    assert.equal(normalizeSharePoster(artwork.id), artwork.id);
    assert.equal(shareArtwork(artwork.id), artwork);
    assert.match(artwork.base, /^bemine-share-v(?:10|11-[a-z]+)$/u);
    assert.ok(artwork.zh && artwork.en);
  }
  for (const id of [undefined, '', '../anime', 'https://tracker.example/a', 'anime?wallet=secret', {}, 1]) {
    assert.equal(normalizeSharePoster(id), 'original');
    assert.equal(shareArtwork(id).id, 'original');
  }
});

test('both languages have eighteen distinct invitations and eighteen distinct safe updates', () => {
  assert.equal(SHARE_MOTTO_COUNT, 18);
  for (const locale of ['zh', 'en']) {
    for (const canSubscribe of [true, false]) {
      const variants = Array.from({ length: SHARE_MOTTO_COUNT }, (_, index) => shareMotto(locale, index, canSubscribe));
      assert.equal(new Set(variants).size, 18);
      assert.ok(variants.every(text => typeof text === 'string' && text.trim().length > 0));
      assert.equal(shareMotto(locale, 18, canSubscribe), variants[0]);
      assert.equal(shareMotto(locale, 35, canSubscribe), variants[17]);
      for (const invalid of [-1, null, NaN, '1', 0.5]) assert.equal(shareMotto(locale, invalid, canSubscribe), variants[0]);
      for (const text of variants) assert.doesNotMatch(text, /保本|稳赚|保证收益|回本|翻倍|guaranteed|risk.free|double your|profit promise/iu);
      if (!canSubscribe) for (const text of variants) assert.doesNotMatch(text, /来认购|购买份额|剩余\s*\d|可认购|join now|buy a share|shares available/iu);
    }
  }
  assert.equal(shareMotto('zh', 0, true), '一份也是矿友，一起才有意思。');
  assert.equal(shareMotto('zh', 1, true), '把朋友叫上，把矿机拼上。');
  assert.equal(shareMotto('zh', 2, true), '一起拼矿，一起发光。');
});

test('all 162 combinations are reachable with injectable randomness', () => {
  assert.equal(SHARE_VARIATION_COUNT, 162);
  const selected = new Set();
  for (let index = 0; index < SHARE_VARIATION_COUNT; index++) {
    const variant = selectShareVariation(null, () => (index + 0.5) / SHARE_VARIATION_COUNT);
    selected.add(`${variant.posterId}/${variant.mottoIndex}`);
  }
  assert.equal(selected.size, SHARE_VARIATION_COUNT);
  assert.deepEqual(selectShareVariation(null, () => 0), { posterId: 'original', mottoIndex: 0 });
  assert.deepEqual(selectShareVariation(null, () => 1), { posterId: 'ink', mottoIndex: 17 });
});

test('changing an open card excludes its current pair for every possible random bucket', () => {
  for (const artwork of SHARE_ARTWORKS) for (let mottoIndex = 0; mottoIndex < SHARE_MOTTO_COUNT; mottoIndex++) {
    const current = { posterId: artwork.id, mottoIndex };
    for (let index = 0; index < SHARE_VARIATION_COUNT - 1; index++) {
      const variant = selectShareVariation(current, () => (index + 0.5) / (SHARE_VARIATION_COUNT - 1));
      assert.notDeepEqual(variant, current);
      assert.ok(SHARE_ARTWORKS.some(item => item.id === variant.posterId));
      assert.ok(variant.mottoIndex >= 0 && variant.mottoIndex < 18);
    }
  }
});

test('reopening excludes the previous pair across sessions and stores no personal data', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const first = createShareVariationSession({ random: () => 0 });
  const a = first.open(storage);
  const b = first.open(storage);
  assert.notDeepEqual(a, b);
  const second = createShareVariationSession({ random: () => 0 });
  const c = second.open(storage);
  assert.notDeepEqual(b, c);
  assert.deepEqual([...values.keys()], [SHARE_VARIATION_STORAGE_KEY]);
  assert.deepEqual(Object.keys(JSON.parse(values.get(SHARE_VARIATION_STORAGE_KEY))).sort(), ['mottoIndex', 'posterId']);
  assert.deepEqual(a, { posterId: 'original', mottoIndex: 0 }, 'later draws do not mutate an open card');
});

test('blocked storage and invalid stored values do not prevent sharing or repeated-open protection', () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const session = createShareVariationSession({ random: () => { throw new Error('rng failed'); } });
  const a = session.open(blocked), b = session.open(blocked);
  assert.notDeepEqual(a, b);
  for (const previous of [null, {}, { posterId: 'tracker', mottoIndex: 2 }, { posterId: 'anime', mottoIndex: 99 }]) {
    assert.deepEqual(selectShareVariation(previous, () => NaN), { posterId: 'original', mottoIndex: 0 });
  }
  const corrupt = { getItem: () => '{not-json', setItem() {} };
  assert.deepEqual(createShareVariationSession({ random: () => 0 }).open(corrupt), { posterId: 'original', mottoIndex: 0 });
});

test('crypto randomness uses a bounded uint32 and falls back if unavailable', () => {
  assert.equal(shareRandom({ getRandomValues(array) { array[0] = 0xffffffff; } }, () => 0.3), 0xffffffff / 0x100000000);
  assert.equal(shareRandom(undefined, () => 0.3) >= 0, true);
  assert.equal(shareRandom(null, () => 0.3), 0.3);
  assert.equal(shareRandom({ getRandomValues() { throw new Error('disabled'); } }, () => 0.6), 0.6);
  assert.equal(shareRandom(null, () => { throw new Error('disabled'); }), 0);
});
