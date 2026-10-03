import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { artifactContentDigest } from '../scripts/build-artifacts.mjs';
import { servedArtifactDigest } from './artifact-digest.mjs';

test('journal binds to the exact artifact JSON served by dev and production pages', () => {
  const dev = fileURLToPath(new URL('../public/deployment-artifacts.json', import.meta.url));
  const production = fileURLToPath(new URL('../dist/deployment-artifacts.json', import.meta.url));
  const expected = artifactContentDigest(JSON.parse(readFileSync(dev, 'utf8')));
  assert.equal(servedArtifactDigest(dev), expected);
  if (existsSync(production)) assert.equal(servedArtifactDigest(production), expected);
});
