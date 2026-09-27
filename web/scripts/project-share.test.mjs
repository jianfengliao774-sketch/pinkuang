import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PUBLIC_SHARE_BASE, validatePublicBaseUrl, buildProjectShareUrl, isConfirmedDeposit, createProjectShare } from '../lib/project-share.mjs';
import { SHARE_MOTTO_COUNT, shareMotto } from '../lib/share-copy.mjs';
import { SHARE_ARTWORKS } from '../lib/share-artwork.mjs';
import { makeArtworkShareUrl } from '../lib/share-landing.mjs';

const pool = `0x${'a1'.repeat(20)}`;
const other = `0x${'b2'.repeat(20)}`;
const hash = `0x${'c3'.repeat(32)}`;
const project = { poolAddress: pool, name: 'TapeOut', circuitId: '16210', state: 'Funding', remainingShares: 24 };
const confirmed = { action: 'deposit', status: 'confirmed', poolAddress: pool, transactionHash: hash, finalized: true,
  receipt: { status: 1, to: pool, transactionHash: hash } };
const model = (overrides = {}) => createProjectShare({ publicBaseUrl: DEFAULT_PUBLIC_SHARE_BASE, project, confirmation: confirmed, ...overrides });

test('only the explicitly trusted HTTPS deployment base is shareable', () => {
  assert.equal(validatePublicBaseUrl(DEFAULT_PUBLIC_SHARE_BASE), DEFAULT_PUBLIC_SHARE_BASE);
  assert.equal(validatePublicBaseUrl('https://tapeout.cc.cd/bemine'), DEFAULT_PUBLIC_SHARE_BASE);
  for (const url of [undefined, '', 'http://tapeout.cc.cd/bemine/', 'https://localhost/bemine/', 'https://127.0.0.1/bemine/',
    'https://10.0.0.1/bemine/', 'https://[::1]/bemine/', 'https://192.168.1.1/bemine/', 'https://example.com/bemine/',
    'https://tapeout.cc.cd.evil.example/bemine/', 'https://user:secret@tapeout.cc.cd/bemine/',
    'https://tapeout.cc.cd:8443/bemine/', 'https://tapeout.cc.cd/redirect/',
    `${DEFAULT_PUBLIC_SHARE_BASE}?factory=${other}`, `${DEFAULT_PUBLIC_SHARE_BASE}#detail/${other}`, ` ${DEFAULT_PUBLIC_SHARE_BASE}`,
    'https://tapeout.cc.cd\\@evil.example/bemine/']) assert.equal(validatePublicBaseUrl(url), null, String(url));
});

test('project links use only the pool address and an allowlisted attribution source', () => {
  const url = new URL(buildProjectShareUrl(DEFAULT_PUBLIC_SHARE_BASE, pool, 'tg'));
  assert.equal(url.hash, `#detail/${pool}`);
  assert.deepEqual([...url.searchParams], [['source', 'tg']]);
  assert.equal(buildProjectShareUrl(DEFAULT_PUBLIC_SHARE_BASE, '16210'), null);
  assert.equal(buildProjectShareUrl(DEFAULT_PUBLIC_SHARE_BASE, `0x${'0'.repeat(40)}`), null);
  assert.equal(buildProjectShareUrl(DEFAULT_PUBLIC_SHARE_BASE, `${pool}?factory=${other}`), null);
  assert.equal(buildProjectShareUrl(DEFAULT_PUBLIC_SHARE_BASE, pool, `tg&wallet=${other}`), null);
});

test('success requires matching deposit intent, successful receipt and explicit finality', () => {
  assert.equal(isConfirmedDeposit(confirmed, pool), true);
  for (const change of [undefined, {}, { ...confirmed, action: 'claim' }, { ...confirmed, status: 'pending' },
    { ...confirmed, status: 'submitted' }, { ...confirmed, finalized: false }, { ...confirmed, poolAddress: other },
    { ...confirmed, transactionHash: 'not-a-hash' }, { ...confirmed, receipt: { ...confirmed.receipt, status: 0 } },
    { ...confirmed, receipt: { ...confirmed.receipt, to: other } },
    { ...confirmed, receipt: { ...confirmed.receipt, transactionHash: `0x${'d4'.repeat(32)}` } },
    { ...confirmed, receipt: null }]) {
    assert.equal(isConfirmedDeposit(change, pool), false);
    assert.equal(model({ confirmation: change }).confirmed, false);
    assert.doesNotMatch(model({ confirmation: change }).text, /我已参与|I've joined/u);
  }
});

test('share intents encode bilingual text and the project URL without parameter injection', () => {
  for (const locale of ['zh', 'en']) {
    const share = model({ locale });
    for (const [key, origin, path, source] of [['telegramUrl', 'https://t.me', '/share/url', 'tg'], ['xUrl', 'https://x.com', '/intent/tweet', 'x']]) {
      const intent = new URL(share[key]);
      assert.equal(intent.origin, origin);
      assert.equal(intent.pathname, path);
      assert.equal(intent.searchParams.get('text'), source === 'x' ? share.xText : share.text);
      assert.equal(intent.searchParams.get('url'), makeArtworkShareUrl(buildProjectShareUrl(DEFAULT_PUBLIC_SHARE_BASE, pool, source)));
      assert.equal([...intent.searchParams].length, 2);
    }
    assert.ok(share.text.includes('TapeOut #16210'));
  }
});

test('share slogans stay stable and rotate only through the selected safe variants', () => {
  const expected = ['一份也是矿友，一起才有意思。', '把朋友叫上，把矿机拼上。', '一起拼矿，一起发光。'];
  for (let mottoIndex = 0; mottoIndex < SHARE_MOTTO_COUNT; mottoIndex++) {
    assert.equal(model({ mottoIndex }).motto, shareMotto('zh', mottoIndex, true));
    assert.equal(model({ mottoIndex }).text, model({ mottoIndex }).text);
    assert.notEqual(model({ mottoIndex, locale: 'en' }).motto, shareMotto('zh', mottoIndex, true));
  }
  assert.equal(model({ mottoIndex: SHARE_MOTTO_COUNT }).motto, expected[0]);
  assert.equal(model({ mottoIndex: -1 }).motto, expected[0]);
  assert.doesNotMatch(model().text, /共持 BEM|共享 BEM/u);
  for (const state of ['Funded', 'Active', 'Listed', 'Closed', 'Refunding', 'Unknown']) {
    for (let mottoIndex = 0; mottoIndex < SHARE_MOTTO_COUNT; mottoIndex++) {
      const share = model({ mottoIndex, project: { ...project, state } });
      assert.ok(!expected.includes(share.motto));
      assert.doesNotMatch(share.xText, /剩余|份额可认购|available/u);
    }
  }
  for (const remainingShares of [0, null, undefined]) assert.ok(!expected.includes(model({ project: { ...project, remainingShares } }).motto));
});

test('X copy remains within weighted 280-character limit including its shortened URL', () => {
  // https://docs.x.com/fundamentals/counting-characters (checked 2026-09-27).
  // X default weights: Latin/general punctuation in these ranges count once; CJK counts twice.
  const weighted = text => [...text].reduce((sum, char) => {
    const cp = char.codePointAt(0);
    return sum + (cp <= 0x10ff || cp >= 0x2000 && cp <= 0x200d || cp >= 0x2010 && cp <= 0x201f || cp >= 0x2032 && cp <= 0x2037 ? 1 : 2);
  }, 0);
  for (const locale of ['zh', 'en']) for (const name of ['TapeOut', 'Behemoth']) {
    for (const state of ['Funding', 'Active', 'Unknown']) for (let mottoIndex = 0; mottoIndex < SHARE_MOTTO_COUNT; mottoIndex++) {
      const share = model({ locale, mottoIndex, project: { ...project, name, state, circuitId: (2n ** 256n - 1n).toString() } });
      assert.ok(weighted(share.xText) + 1 + 23 <= 280, `${locale}/${name}/${state}/${mottoIndex}`);
    }
  }
});

test('selected poster matches all share landing URLs while projectUrl remains a direct link', () => {
  for (const artwork of SHARE_ARTWORKS) {
    const share = model({ posterId: artwork.id });
    assert.equal(share.projectUrl, buildProjectShareUrl(DEFAULT_PUBLIC_SHARE_BASE, pool));
    assert.equal(share.url, makeArtworkShareUrl(share.projectUrl, artwork.id));
    assert.equal(new URL(share.url).pathname, `/bemine/share/${artwork.id}.html`);
    for (const key of ['telegramUrl', 'xUrl']) {
      const target = new URL(new URL(share[key]).searchParams.get('url'));
      assert.equal(target.pathname, `/bemine/share/${artwork.id}.html`);
      assert.equal(target.searchParams.get('project'), pool);
      assert.equal(target.searchParams.get('mode'), 'live');
    }
  }
  assert.equal(new URL(model({ posterId: '../evil' }).url).pathname, '/bemine/share/original.html');
});

test('share payload never includes wallet, investment, receipt hash or untrusted optional metadata', () => {
  const share = model({ project: { ...project, wallet: other, investor: other, amount: '123.456789BNB', referral: other,
    factory: other, text: 'guaranteed returns', imageUrl: 'https://evil.example/track' } });
  const all = JSON.stringify(share);
  for (const privateValue of [other, hash, '123.456789', 'guaranteed returns', 'evil.example', 'factory=', 'referral=']) assert.ok(!all.includes(privateValue), privateValue);
  assert.equal(model({ project: { ...project, name: `TapeOut ${other}` } }), null);
  assert.equal(model({ project: { ...project, circuitId: `16210 ${other}` } }), null);
});

test('full, active, sold and refunding projects never solicit new subscriptions', () => {
  const full = model({ project: { ...project, remainingShares: 0 } });
  assert.equal(full.canSubscribe, false);
  assert.match(full.status, /已满/u);
  for (const state of ['Funded', 'Active', 'Listed', 'Closed', 'Refunding', 'Unknown']) {
    for (const locale of ['zh', 'en']) {
      const share = model({ locale, project: { ...project, state } });
      assert.equal(share.canSubscribe, false);
      assert.doesNotMatch(share.text, /募集中|Funding ·|shares remain|可认购/u);
    }
  }
  assert.equal(model().canSubscribe, true);
  assert.match(model().status, /剩余 24 份/u);
  for (const remainingShares of [-1, 101, NaN, 1.5, '24', undefined]) {
    const share = model({ project: { ...project, remainingShares } });
    assert.equal(share.canSubscribe, false);
    assert.doesNotMatch(share.text, /NaN|undefined|-1|101/u);
  }
});

test('missing trusted configuration and demonstration-only identifiers produce no formal share', () => {
  assert.equal(model({ publicBaseUrl: undefined }), null);
  assert.equal(model({ project: { ...project, poolAddress: 'demo-16210' } }), null);
  assert.equal(model({ project: { ...project, circuitId: Number.MAX_SAFE_INTEGER + 1 } }), null);
  assert.equal(model({ project: { ...project, circuitId: 2n ** 256n } }), null);
  assert.equal(model({ project: { ...project, circuitId: 16210n } }).title, 'TapeOut #16210');
});

test('confirmed subscription does not invent live availability when the latest read is unknown', () => {
  for (const locale of ['zh', 'en']) {
    const share = model({ locale, project: { ...project, state: 'Unknown', remainingShares: null } });
    assert.equal(share.confirmed, true);
    assert.equal(share.canSubscribe, false);
    assert.equal(share.stateKnown, false);
    assert.doesNotMatch(share.text, /剩余|募集中|已募满|shares remain|Funding|Fully funded/u);
    assert.equal(share.status, locale === 'en' ? 'View the latest project status.' : '查看项目最新状态。');
  }
});
