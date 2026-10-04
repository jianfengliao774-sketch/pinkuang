import assert from 'node:assert/strict';
import test from 'node:test';
import { firstoForkSuites, firstoForkTestCount, passedFirstoForkEvidence } from './firsto-fork-evidence.mjs';

const inventory = Object.entries(firstoForkSuites)
  .map(([name, count]) => `Ran ${count} test${count === 1 ? '' : 's'} for test/fork/${name.replace('Test', '')}.t.sol:${name}`)
  .join('\n');
const summary = 'Ran 5 test suites in 16.52s (16.46s CPU time): 18 tests passed, 0 failed, 0 skipped (18 total tests)';
const complete = `${inventory}\n${summary}\n`;

test('accepts precisely all five real Firsto suites and eighteen successful unskipped tests', () => {
  assert.equal(firstoForkTestCount, 18);
  assert.equal(passedFirstoForkEvidence(complete, 0), true);
  assert.equal(passedFirstoForkEvidence(complete.replaceAll('\n', '\r\n'), 0), true);
});

test('rejects unsuccessful process, stale counts, skipped cases and success-shaped partial output', () => {
  for (const [output, exitCode] of [
    [complete, 1], [complete, null], [summary, 0],
    [complete.replace('18 tests passed', '14 tests passed'), 0],
    [complete.replace('0 failed', '1 failed'), 0],
    [complete.replace('0 skipped', '1 skipped'), 0],
    [complete.replace('18 total tests', '19 total tests'), 0],
    [`[SKIP: old fixture]\n${complete}`, 0],
    [complete.replace(summary, `log substring: ${summary}`), 0],
    [`${complete}${summary}\n`, 0],
  ]) assert.equal(passedFirstoForkEvidence(output, exitCode), false, `${exitCode}: ${output}`);
});

test('rejects missing, duplicate, renamed and redistributed suites despite matching total summary', () => {
  for (const output of [
    complete.replace(/^Ran 1 test for[^\n]+\n/, ''),
    complete.replace('BudgetPortfolioForkTest', 'FirstoPoolForkTest'),
    complete.replace('BudgetPortfolioForkTest', 'UnreviewedForkTest'),
    complete.replace('Ran 10 tests for', 'Ran 9 tests for'),
    complete.replace('Ran 5 tests for', 'Ran 6 tests for'),
  ]) assert.equal(passedFirstoForkEvidence(output, 0), false, output);
});
