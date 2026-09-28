import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDeployConsoleUrl } from '../lib/deploy-console-url.mjs';

test('deployment console link requires HTTPS except local development', () => {
  assert.equal(resolveDeployConsoleUrl('https://deploy.example.com/console'), 'https://deploy.example.com/console');
  assert.equal(resolveDeployConsoleUrl('http://localhost:4173/'), 'http://localhost:4173/');
  assert.equal(resolveDeployConsoleUrl('http://127.0.0.1:4173/'), 'http://127.0.0.1:4173/');
  assert.equal(resolveDeployConsoleUrl('http://[::1]:4173/'), 'http://[::1]:4173/');
  for (const invalid of [undefined, '', '/deploy', 'http://deploy.example.com/', 'javascript:alert(1)', 'https://user:pass@deploy.example.com/']) {
    assert.equal(resolveDeployConsoleUrl(invalid), null);
  }
});
