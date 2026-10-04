export const firstoForkSuites = Object.freeze({
  FirstoPoolForkTest: 1,
  PoolSaleForkTest: 10,
  PoolBurnForkTest: 1,
  AuditMiningSettlementForkTest: 5,
  BudgetPortfolioForkTest: 1,
});
export const firstoForkTestCount = Object.values(firstoForkSuites).reduce((sum, count) => sum + count, 0);

// Match the final Forge summary and exact suite inventory, rather than an
// arbitrary success-shaped substring from another run or a skipped fixture.
export function passedFirstoForkEvidence(output, exitCode) {
  if (exitCode !== 0 || /\[SKIP/.test(output)) return false;
  const summaries = [...output.matchAll(/^Ran (\d+) test suites in [^\r\n]+: (\d+) tests passed, (\d+) failed, (\d+) skipped \((\d+) total tests\)\r?$/gm)];
  if (summaries.length !== 1) return false;
  const [, suites, passed, failed, skipped, total] = summaries[0];
  if (+suites !== Object.keys(firstoForkSuites).length || +passed !== firstoForkTestCount
    || +failed !== 0 || +skipped !== 0 || +total !== firstoForkTestCount) return false;
  const inventory = [...output.matchAll(/^Ran (\d+) tests? for test\/fork\/[^:\r\n]+:([^\r\n]+)\r?$/gm)];
  if (inventory.length !== Object.keys(firstoForkSuites).length) return false;
  const seen = new Set();
  for (const [, count, suite] of inventory) {
    if (seen.has(suite) || !Object.hasOwn(firstoForkSuites, suite) || +count !== firstoForkSuites[suite]) return false;
    seen.add(suite);
  }
  return true;
}
