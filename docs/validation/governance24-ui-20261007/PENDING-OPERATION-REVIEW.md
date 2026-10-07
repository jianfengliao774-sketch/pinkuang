# Read-only review: retained old48 operations and governance24 routing

Reviewed source only on 2026-10-07; no RPC, signing, production, cancellation or contract change. This is a confirmed conditional capability, not a claim that current live pending operations were re-enumerated. Historical evidence from 2026-10-06 proves two direct core-Beacon schedules existed then; their latest live status must come from the new independently reviewed current graph inventory.

## Confirmed conditional risk

The new proof preserves every listed old operation's original timestamp and `isOperationDone == false` in all phases (`deploy/shared/governance24-upgrade-proof.mjs:143-149`, called again at `:220`). After migration the old core and portfolio Beacons remain owned by the old48 timelock (`:194-202`). `PoolBeacon.upgradeTo` permits any implementation with the same `OFFICIAL_FACTORY` (`contracts/src/PoolBeacon.sol:28-30`); the owner cannot be changed (`:33`).

Therefore any retained pending single-Beacon `upgradeTo(oldVault)` can execute after migration once it is ready. It replaces the Dispatcher with the old vault and disconnects that pool fleet from the secondary24 Beacon. The original timelock has an open executor role (`contracts/src/PoolTimelock.sol:33-37`), so the original user need not deliberately click the old UI after migration for an already-ready operation to be executable. The operation already served its original48 delay; this is not a bypass of that delay or an unauthorized new schedule.

The proof detects the changed routing on the next snapshot. It does not prevent a later old operation from changing it. A branded `done` proof correctly states the graph at its finalized snapshot and cannot establish future immutability while the old48 recovery path is deliberately retained.

Historical evidence: `docs/validation/core-wrapper-recovery-20261006/core-timelock-operations-redacted.json` had two core-Beacon `upgradeTo` schedules with distinct operation IDs, the original one already ready and the later one pending. This older evidence does not establish whether those operations remain live today.

## Cases that differ

Factories and Markets switch their timelock storage to the new24 lock (`Governance24FreshPoolFactory.sol:16-20` and equivalent migrations). Their inherited UUPS `_authorizeUpgrade` requires this current storage field (`BudgetPortfolioFactory.sol:178-179`, `ShareMarket.sol:514-515`). Old48 UUPS upgrades therefore normally revert after migration. An old mixed batch containing such a reverting UUPS call reverts atomically, including earlier Beacon calls. A direct old Beacon-only operation does not receive that protection. Unknown or nested batches require explicit payload classification, not an assumption based on their titles.

## Minimum safe handling

1. Independently enumerate all old48 schedule/cancel/execute events from deployment to the fixed review anchor and bind that enumeration evidence; the current plan only validates the supplied `pendingOperations` array (`governance24-upgrade-plan.mjs:136-147`) and does not itself prove its completeness.
2. Derive a per-operation risk ledger from exact payloads and targets. Flag either legacy Beacon target, old timelock role/delay mutation, and unknown or nested control payloads. Verify the ledger and every original timestamp again immediately before migration execution. A previously consumed or canceled operation changes the graph and requires a new independent review; no automatic cancellation is permitted.
3. If the intended product claim is that retained pending operations cannot unexpectedly remove the new24 path, fail closed before release/schedule/execute while a harmful operation remains. Let the user explicitly finish or otherwise resolve it through the existing process before a new independent current-graph review. This review performs no such action.
4. If the user explicitly chooses to retain a ready recovery operation, the UI must display its ID, target, implementation and readiness, and say it can restore the old implementation after migration and disable24 routing for the affected pools. Require specific acknowledgement of this conditional state; do not label it a permanent all-business24 guarantee. That is compatible with preserving original timestamps and the old48 recovery channel, but it is a different UX than silently declaring every pending operation harmless.

Small verification case for the owning contract/proof agent: schedule a legacy core-Beacon `upgradeTo(oldVault)`, migrate all seven calls, obtain a full `done` proof, execute the retained old operation as an arbitrary executor, and assert the legacy Beacon now holds `oldVault`, the secondary24 remains unchanged but unreachable, and a new `done` snapshot refuses to verify. Repeat with a mixed UUPS batch to show atomic revert. No contract or test was modified or executed for this review.
