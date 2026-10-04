import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const reviewedPath = new URL('../docs/audits/2026-10-04/create-failed-recovery-slither/reviewed-findings.json', import.meta.url);
const reviewed = JSON.parse(readFileSync(reviewedPath, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function findingFingerprint(finding) {
  assert(Array.isArray(finding.elements), 'Slither finding has no source elements.');
  return {
    id: finding.id, check: finding.check, impact: finding.impact, confidence: finding.confidence,
    description: finding.description,
    elements: finding.elements.map(element => ({
      type: element.type, name: element.name, path: element.source_mapping?.filename_short,
      signature: element.type_specific_fields?.signature ?? null,
      parent: element.type_specific_fields?.parent?.name ?? null,
    })),
  };
}

/** Review exact occurrences against this branch's source; no detector is excluded. */
export function reviewSlither(document, { root, exitCode, sourceBytes = path => readFileSync(join(root, path)) }) {
  assert(exitCode === 0 || exitCode === 255, `Unexpected Slither exit ${exitCode}.`);
  assert(document?.success === true && document.error === null, 'Slither analysis did not complete successfully.');
  assert(Array.isArray(document.results?.detectors), 'Missing Slither detector report.');
  assert.equal(reviewed.findings.length, 5, 'This source-bound catalog requires exactly five reviewed findings.');
  for (const [path, expected] of Object.entries(reviewed.sourceSha256)) {
    assert.equal(sha256(sourceBytes(path)), expected, `Reviewed Slither source changed: ${path}`);
  }
  const accepted = [], counts = {}, seen = new Set();
  for (const finding of document.results.detectors) {
    assert(['High', 'Medium', 'Low', 'Informational', 'Optimization'].includes(finding.impact), 'Unknown Slither impact.');
    assert.match(finding.id ?? '', /^[0-9a-f]{64}$/);
    assert(!seen.has(finding.id), `Duplicate Slither finding: ${finding.id}`);
    seen.add(finding.id);
    counts[finding.impact] = (counts[finding.impact] ?? 0) + 1;
    assert.notEqual(finding.impact, 'High', `Unreviewed High finding: ${finding.check}`);
    const entry = reviewed.findings.find(item => item.fingerprint.id === finding.id);
    // A severity downgrade cannot hide changed evidence for an acknowledged occurrence.
    if (entry) assert.deepEqual(findingFingerprint(finding), entry.fingerprint, `Reviewed finding changed: ${finding.id}`);
    if (finding.impact !== 'Medium') continue;
    assert(entry, `Unreviewed Medium finding: ${finding.check} ${finding.description}`);
    accepted.push({ id: finding.id, check: finding.check, reason: entry.reason });
  }
  for (const entry of reviewed.findings)
    assert(seen.has(entry.fingerprint.id), `Reviewed Slither finding is missing: ${entry.fingerprint.id}`);
  assert.equal(accepted.length, 5, 'All five reviewed findings must retain Medium severity.');
  assert.equal(counts.Medium, 5, 'This pinned source requires all five reviewed Medium findings.');
  assert.equal(exitCode, counts.Medium ? 255 : 0, 'Scanner exit contradicts the --fail-medium detector report.');
  return { schemaVersion: 1, kind: 'exact-source-bound-slither-review-v1', scannerExitCode: exitCode,
    counts, acceptedMediumFindings: accepted, unreviewedHighOrMedium: 0,
    sourceSha256: reviewed.sourceSha256, review: reviewed.review };
}
