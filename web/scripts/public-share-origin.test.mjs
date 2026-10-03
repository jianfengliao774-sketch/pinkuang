import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// A separate module graph models the build-time constant and exercises both
// share flows without depending on the importing test runner's module cache.
const probe = String.raw`
  import { PUBLIC_SHARE_ORIGIN } from './lib/public-share-origin.mjs';
  import { createProjectShare, validatePublicBaseUrl, publicShareBaseForPath } from './lib/project-share.mjs';
  import { createPortfolioShare } from './lib/portfolio-share.mjs';
  import { makeArtworkShareUrl } from './lib/share-landing.mjs';
  const pool = '0x' + 'ab'.repeat(20), factory = '0x' + 'cd'.repeat(20);
  const base = PUBLIC_SHARE_ORIGIN + '/bemine-v4/';
  const single = createProjectShare({ publicBaseUrl: base,
    project: { name: 'TapeOut', circuitId: '7', poolAddress: pool, state: 'Funding', remainingShares: 2 } });
  const portfolio = createPortfolioShare({ publicBaseUrl: base, project: { kind: 'portfolio', pool,
    OFFICIAL_FACTORY: factory, blockNumber: 100n, blockHash: '0x' + 'ef'.repeat(32), state: 0n,
    totalSupply: 35n, timestamp: 100n, fundingDeadline: 200n } });
  console.log(JSON.stringify({ origin: PUBLIC_SHARE_ORIGIN, base: publicShareBaseForPath('/bemine-v4'),
    single, portfolio, old: validatePublicBaseUrl('https://tapeout.cc.cd/bemine-v4/'),
    unknown: validatePublicBaseUrl('https://unknown.example/bemine-v4/'),
    injection: validatePublicBaseUrl(base + '?origin=https://unknown.example'),
    badArtwork: makeArtworkShareUrl('https://unknown.example/bemine-v4/#detail/' + pool),
    configuredUrl: validatePublicBaseUrl('https://bemine.cc.cd/bemine-v4/') }));
`;

for (const configured of [undefined, 'https://bemine.cc.cd', 'http://bemine.cc.cd',
  'https://bemine.cc.cd/path', 'https://user@bemine.cc.cd']) {
  test(`single-miner and portfolio shares trust only the canonical build origin: ${configured ?? 'default'}`, () => {
    const env = { ...process.env };
    if (configured === undefined) delete env.NEXT_PUBLIC_BEMINE_PUBLIC_ORIGIN;
    else env.NEXT_PUBLIC_BEMINE_PUBLIC_ORIGIN = configured;
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe],
      { cwd: webRoot, env, encoding: 'utf8' }));
    const origin = configured === 'https://bemine.cc.cd' ? configured : 'https://tapeout.cc.cd';
    assert.equal(result.origin, origin);
    assert.equal(result.base, `${origin}/bemine-v4/`);
    for (const share of [result.single, result.portfolio]) {
      assert.ok(share);
      for (const url of [share.url, share.projectUrl,
        new URL(share.telegramUrl).searchParams.get('url'), new URL(share.xUrl).searchParams.get('url')]) {
        assert.equal(new URL(url).origin, origin);
        assert.ok(new URL(url).pathname.startsWith('/bemine-v4/'));
      }
    }
    assert.equal(result.old, 'https://tapeout.cc.cd/bemine-v4/');
    assert.equal(result.unknown, null);
    assert.equal(result.injection, null);
    assert.equal(result.badArtwork, null);
    assert.equal(result.configuredUrl, configured === 'https://bemine.cc.cd' ? `${origin}/bemine-v4/` : null);
  });
}
