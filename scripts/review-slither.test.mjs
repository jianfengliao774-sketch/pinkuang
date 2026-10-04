import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reviewSlither } from './review-slither.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = JSON.parse(readFileSync(new URL('../docs/audits/2026-10-04/create-failed-recovery-slither/reviewed-findings.json', import.meta.url), 'utf8'));
const findings = baseline.findings.map(({ fingerprint: f }) => ({ ...f,
  elements: f.elements.map(e => ({ type: e.type, name: e.name, source_mapping: { filename_short: e.path },
    type_specific_fields: { signature: e.signature, parent: { name: e.parent } } })),
}));
const report = items => ({ success: true, error: null, results: { detectors: structuredClone(items) } });
const check = (value, exitCode = 255, options = {}) => reviewSlither(value, { root, exitCode, ...options });

test('review retains raw 255 and acknowledges only five exact current-branch occurrences', () => {
  const reviewed = check(report(findings));
  assert.equal(reviewed.scannerExitCode, 255);
  assert.equal(reviewed.acceptedMediumFindings.length, 5);
  assert.equal(reviewed.unreviewedHighOrMedium, 0);
  assert.equal(baseline.sourceCommit, 'c1c5b3a5cf318c1464c2bc4af99c2beea2588d94');
  assert.equal(baseline.sourceSha256['contracts/src/PoolVault.sol'], '39295d0e63de70749cf7e359b80648b0f58d16a8d4d2674539575471076a6306');
  assert.equal(baseline.sourceSha256['contracts/src/libraries/PoolFunds.sol'], '9840d881d7bf096b4faee54cac3aade90a7f4cb90dce6202d94cfbc288afd44f');
});
test('any additional Medium or High finding rejects the review', () => {
  const extra = { ...findings[0], id: 'a'.repeat(64), description: 'different occurrence' };
  assert.throws(() => check(report([...findings, extra])), /Unreviewed Medium/);
  assert.throws(() => check(report([{ ...findings[0], impact: 'High' }])), /Unreviewed High/);
});
test('same ID cannot hide changed description, expression, source path, signature or parent', () => {
  for (const mutate of [d => { d.description += 'changed'; }, d => { d.elements[1].name += 'changed'; },
    d => { d.elements[0].source_mapping.filename_short = 'src/Unreviewed.sol'; },
    d => { d.elements[0].type_specific_fields.signature += 'changed'; },
    d => { d.elements[0].type_specific_fields.parent.name += 'changed'; }]) {
    const d = structuredClone(findings[0]); mutate(d);
    assert.throws(() => check(report([d])), /Reviewed finding changed/);
  }
});
test('each source pin rejects an edit independently, including the older branch Vault and Funds', () => {
  for (const path of Object.keys(baseline.sourceSha256)) {
    assert.throws(() => check(report(findings), 255, {
      sourceBytes: name => name === path ? Buffer.from('changed source') : readFileSync(new URL(name, new URL('../', import.meta.url))),
    }), /Reviewed Slither source changed/);
  }
});
test('tool failure, incomplete report, unexpected exit, unknown impact and duplicate IDs reject', () => {
  for (const d of [null, { success: false, error: 'compilation failed' }, { success: true, error: null, results: {} }])
    assert.throws(() => check(d));
  assert.throws(() => check(report(findings), 1), /Unexpected Slither exit/);
  assert.throws(() => check(report([{ ...findings[0], impact: 'Unknown' }])), /Unknown Slither impact/);
  assert.throws(() => check(report([findings[0], findings[0]])), /Duplicate/);
  assert.throws(() => check(report([])), /Reviewed Slither finding is missing/);
});
test('each missing catalog occurrence and an empty successful report reject incomplete analysis', () => {
  for (const finding of findings)
    assert.throws(() => check(report(findings.filter(item => item.id !== finding.id))), /Reviewed Slither finding is missing/);
  for (const exitCode of [0, 255])
    assert.throws(() => check(report([]), exitCode), /Reviewed Slither finding is missing/);
});
test('known-ID severity downgrade and exit zero with Medium findings reject inconsistent evidence', () => {
  assert.throws(() => check(report([{ ...findings[0], impact: 'Low' }]), 0), /Reviewed finding changed/);
  assert.throws(() => check(report(findings), 0), /Scanner exit contradicts/);
});
test('lower-level findings remain visible alongside all five required Medium occurrences', () => {
  const low = { ...findings[0], id: 'b'.repeat(64), impact: 'Low' };
  const reviewed = check(report([...findings, low]));
  assert.equal(reviewed.counts.Low, 1);
  assert.equal(reviewed.acceptedMediumFindings.length, 5);
});
