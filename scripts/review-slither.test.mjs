import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reviewSlither } from './review-slither.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = JSON.parse(readFileSync(new URL('../docs/audits/2026-10-04/slither-reviewed-findings.json', import.meta.url), 'utf8'));
const findings = baseline.findings.map(({ fingerprint: f }) => ({ ...f,
  elements: f.elements.map(e => ({ type: e.type, name: e.name, source_mapping: { filename_short: e.path },
    type_specific_fields: { signature: e.signature, parent: { name: e.parent } } })),
}));
const report = items => ({ success: true, error: null, results: { detectors: structuredClone(items) } });
const check = (value, exitCode = 255, options = {}) => reviewSlither(value, { root, exitCode, ...options });

test('review preserves the raw exit and acknowledges only the five exact source-bound findings', () => {
  const reviewed = check(report(findings));
  assert.equal(reviewed.scannerExitCode, 255);
  assert.equal(reviewed.acceptedMediumFindings.length, 5);
  assert.equal(reviewed.unreviewedHighOrMedium, 0);
});
test('any additional medium finding still fails', () => {
  const extra = { ...findings[0], id: 'a'.repeat(64), description: 'different occurrence' };
  assert.throws(() => check(report([...findings, extra])), /Unreviewed Medium/);
});
test('even a matching reviewed id cannot acknowledge a high finding', () => {
  const high = { ...findings[0], impact: 'High' };
  assert.throws(() => check(report([high])), /Unreviewed High/);
});
test('same detector and function do not acknowledge a different expression or source mapping', () => {
  for (const mutate of [d => { d.description += 'changed'; }, d => { d.elements[1].name += 'changed'; },
    d => { d.elements[0].source_mapping.filename_short = 'src/Unreviewed.sol'; }]) {
    const d = structuredClone(findings[0]); mutate(d);
    assert.throws(() => check(report([d])), /Reviewed finding changed/);
  }
});
test('a source edit invalidates the review even if the scanner id is unchanged', () => {
  assert.throws(() => check(report(findings), 255, { sourceBytes: () => Buffer.from('changed source') }), /Reviewed Slither source changed/);
});
test('tool error, incomplete JSON, unexpected exit and duplicate findings fail closed', () => {
  for (const d of [null, { success: false, error: 'compilation failed' }, { success: true, error: null, results: {} }]) {
    assert.throws(() => check(d));
  }
  assert.throws(() => check(report(findings), 1), /Unexpected Slither exit/);
  assert.throws(() => check(report([{ ...findings[0], impact: 'Unknown' }])), /Unknown Slither impact/);
  assert.throws(() => check(report([findings[0], findings[0]])), /Duplicate/);
  assert.throws(() => check(report([])), /Scanner exit contradicts/);
});
test('known-id severity downgrade and raw successful exit with Medium findings cannot hide inconsistency', () => {
  assert.throws(() => check(report([{ ...findings[0], impact: 'Low' }]), 0), /Reviewed finding changed/);
  assert.throws(() => check(report(findings), 0), /Scanner exit contradicts/);
});
test('a successful scan needs no exception and lower-level findings remain counted', () => {
  const low = { ...findings[0], id: 'b'.repeat(64), impact: 'Low' };
  const reviewed = check(report([low]), 0);
  assert.equal(reviewed.counts.Low, 1);
  assert.equal(reviewed.acceptedMediumFindings.length, 0);
});
