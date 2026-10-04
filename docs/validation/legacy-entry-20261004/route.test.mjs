import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const page = readFileSync(fileURLToPath(new URL('./bemine-paused.html', import.meta.url)), 'utf8');
const code = page.match(/<script>([\s\S]+?)<\/script>/)[1];
function run(search, hash) {
  const link = {};
  const location = { search, hash };
  const listeners = {};
  vm.runInNewContext(code, {
    URL, URLSearchParams, location,
    document: { getElementById: id => { assert.equal(id, 'formal-product-link'); return link; } },
    window: { addEventListener: (name, fn) => { listeners[name] = fn; } },
  });
  return { link, location, listeners };
}
test('no-script entry points to the current formal product, never a console', () => {
  assert.match(page, /id="formal-product-link" href="https:\/\/bemine\.cc\.cd\/"/);
  assert.match(page, /前往 BEMine 正式网站/);
  assert.doesNotMatch(page, /pinkuang-|部署入口/);
  assert.match(page, /旧项目合约和资产保留/);
});
test('the reported market link keeps its language and product route', () => {
  assert.equal(run('?lang=zh', '#market').link.href, 'https://bemine.cc.cd/?lang=zh#market');
});
test('only known whole product routes and supported languages survive', () => {
  for (const route of ['home', 'overview', 'pools', 'market', 'rewards', 'governance', 'records', 'operator', 'notifications']) {
    assert.equal(run('?lang=en&next=https://example.invalid/', '#' + route).link.href, 'https://bemine.cc.cd/?lang=en#' + route);
  }
});
test('old detail addresses are not remapped into a different contract graph', () => {
  assert.equal(run('?lang=zh', '#detail/0x' + 'a'.repeat(40)).link.href, 'https://bemine.cc.cd/?lang=zh');
  assert.equal(run('?lang=xx&next=https://evil.invalid/', '#market/../../deploy').link.href, 'https://bemine.cc.cd/');
  assert.equal(run('?lang=zh', '#https://evil.invalid/').link.href, 'https://bemine.cc.cd/?lang=zh');
});
test('hash navigation updates only the anchor and does not auto-navigate', () => {
  const result = run('?lang=en', '#market');
  result.location.hash = '#overview';
  result.listeners.hashchange();
  assert.equal(result.link.href, 'https://bemine.cc.cd/?lang=en#overview');
  result.location.hash = '#detail/invalid';
  result.listeners.hashchange();
  assert.equal(result.link.href, 'https://bemine.cc.cd/?lang=en');
});
