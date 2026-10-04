# October 5 formal-site fixes

This release addresses five defects reproduced during the October 5 audit. It
changes the frontend and the mining worker, with no contract transaction.

* Reward projections are bound to the account, Factory and canonical block.
  New indexed booked balances cannot be replaced by an older reward snapshot.
  When a harvest changes the booked balance, the old pending estimate becomes
  unknown rather than being counted a second time. Claim availability uses the
  block corresponding to the accepted booked balance.
* Automatic and manual refresh reread the pages already loaded by the user.
  Catalog, positions and orders preserve their expanded window and UI state.
  Pages from different source snapshots, duplicate identities and looping
  cursors are rejected without replacing the visible window. This reads the
  existing materialized display API; it adds no direct browser RPC polling.
* Completed mining follow-ups leave the urgent queue when their pool is no
  longer Active. Signed transaction, receipt and fee evidence remain intact.
  Unresolved nonces retain priority even during an ordinary read cooldown.
* Inactive mining checks read lifecycle state before identity/metadata. Active
  monitoring reuses the same cycle's validated snapshot. Sending still rereads
  state after nonce recovery. The 30-second ordinary read cooldown does not
  replace or refresh readiness evidence, nor suspend transaction recovery.
* Delisted invitations show that subscriptions are closed and participants
  retain withdrawal/refund access. Unknown target evidence does not advertise
  available shares. Formal V5 invitations use `https://bemine.cc.cd/` while
  retaining the internal `/bemine-v5` asset/API namespace.

An additional compatibility fix migrates a saved legacy wallet preference
only when a late EIP-6963 announcement refers to the exact connected provider
object and the same reviewed brand. It never guesses another wallet by brand.
The outdated public-relay readiness fixture now tests the actual public relay
and separate signer boundary, with guaranteed HTTP-server cleanup.

## Verification and publication

The local regressions cover newer booked rewards, account/Factory/fork changes,
two-page refresh, multiple orders in the same pool, wallet announcement timing,
Listed/Closed follow-up recovery, pending nonce priority, inactive read counts,
same-cycle reuse, wait-only heartbeats and signer/relay boundaries.

Results: frontend regressions 178/178; mining/purchase regressions 98/98;
readiness/signer regressions 91/91; share/landing/build regressions 46/46;
publication process provenance regressions 5/5. Some suites overlap, so these
counts are not a combined count of unique tests. The JSX compile and diff
whitespace checks also passed. Unknown pending rewards show a dash with a
booked-only label; they do not prevent a known newer booked balance from being
displayed or claimed.

`deploy/ops/v5/publish-audit-fixes.py` pins the currently installed frontend and
worker baseline, checks the payload inventory and formal manifest, retains old
immutable chunks for already-open tabs, and changes only the static symlink and
mining worker WorkingDirectory. Journals, databases, credentials, nginx, the
index and signer services are preserved. Failure restores the previous frontend
and worker. Its receipt and live browser evidence are saved with the release.

## Contract limitations

Website delisting does not itself add a guard to direct contract calls. The
already deployed PR47 PoolVault candidate is scheduled for the existing
48-hour timelock, with earliest execution at 2026-10-06 18:00:33 Asia/Shanghai;
it was not active at this release's audit. That candidate checks NFT owner
changes, not a same-owner removal of official/Firsto listings. Execution also
requires the corresponding runtime and historical-pool migration preparation.
This release does not describe those protections as already effective.

The small BudgetPortfolioVault final-sale rounding remainder belongs to a
separate contract patch. Neither that patch nor a changed PoolVault bytecode is
inserted into the already scheduled transaction.
