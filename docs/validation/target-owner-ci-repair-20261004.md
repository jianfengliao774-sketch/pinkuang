# Target-owner upgrade CI fixture repairs

This follow-up fixes stale fork setup, historical graph fixtures and incomplete
offline packaging closures. It changes no Solidity implementation, Foundry
settings, approved deployment artifact, live runtime or published UI input.
The independently approved Beacon candidate remains `0xc9be5208…496881e5`.
It does not activate the upgrade or authorize a new full-deployment genesis.

The Firsto fork fixtures now publish their attested quote before opening a sale
proposal. The current contracts snapshot that review policy at proposal creation;
publishing a quote afterwards cannot grant approval. A new real-protocol fork
regression proves the latter fails closed until explicit operator review. The
signed discount test checks rejection one second before the three-day activation
boundary, acceptance at the boundary, and the separate seven-day listing period.
The wrapper requires the exact five-suite inventory and final 18/0/0 summary;
partial output, failed processes, missing/duplicate suites and skips are rejected.

The original `d09b25c` graph test now uses its independently preserved v2 record,
bundle and manifest from `8958edd1`, with fixed artifact/source pins. It also
checks that the old runtime rejects the current Fresh graph rather than inventing
a `PoolFactory` alias. The purchase and stage-two attestor packagers include their
reviewed transitive module dependencies. Temporary packaged signer, pricing and
proof imports are exercised, with missing files and unsafe/dynamic imports still
rejected. No shared server module or published source was rewritten.

Local validation on Node 24.19.0:

- Fixed public BSC block `124308679`: 18 passed, zero failed/skipped across five suites.
- Exact workflow release-tooling Node command: 90 passed, zero failed/skipped.
- Product `pnpm run check`: 1078 passed, zero failed/skipped. The local invocation
  disables automatic dependency installation because dependencies are mounted;
  CI's frozen installation and normal command remain unchanged.
- Strict fork-result parser: three positive/negative tests passed.
- Fifteen compatible Python files: 185 passed, with 11 existing macOS platform
  skips. The canonical-directory test passed 26/26 using `TMPDIR=/private/tmp`
  after the original macOS `/var` symlink was correctly rejected. Linux root
  installer/runtime suites remain mandatory in CI and are not reported as
  locally validated.
- Formatting and diff checks pass. Solidity source/settings are unchanged;
  all 40 published inputs still match fingerprint `6ddfbb24…433709e` from
  `9784000`. The production package was not rebuilt.

Small evidence, exact commands, raw-log hashes and local paths are recorded in
[the repair evidence](../evidence/target-owner-ci-repair-20261004.json).
These local results do not claim that the subsequent complete GitHub workflow
has passed. The approved release scopes and their separate validation gates
remain as documented in [the CI scope](../../deploy/ci-target-owner-README.md).
