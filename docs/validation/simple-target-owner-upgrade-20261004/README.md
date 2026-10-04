# Simplified standalone upgrade page

The standalone page at `https://bemine.cc.cd/pinkuang-target-owner-upgrade/` now uses one primary action to prepare and advance the reviewed upgrade. The user confirms the wallet requests. Contract code, reviewed artifacts, governance roles, and the existing 48-hour Timelock delay are unchanged.

## Normal sequence

1. Connect the authorized wallet and start or resume the existing browser journal.
2. Deploy PoolFunds, FlexiblePurchase, and PoolVault in the reviewed dependency order. Save each original intent before requesting the wallet, then save its returned hash.
3. Wait within a bounded window for the original receipt to reach the finalized chain. Verify the exact transaction, receipt, code, and graph before advancing.
4. Submit the original Timelock schedule. End this click sequence after confirming that schedule, even if a sleeping tab wakes after the delay has elapsed.
5. After the chain delay, a fresh click on the same primary action checks the original operation and asks the wallet to execute it.

Detailed evidence and journal import/export remain available in a collapsed section. Existing local journals retain their schema and storage key. A hashless uncertain submission requires recovery of its original transaction; it must not be automatically replaced by another send.

## Continuation controls

The cross-tab lock spans the entire user-triggered sequence. Each save checks the currently persisted journal. Wallet, provider, chain, account, storage, cancellation, or unmount changes invalidate the current sequence before another wallet send. A hash returned after a request has already reached the wallet remains valuable evidence and must still be preserved.

A verified finalized failed transaction can be archived, but retrying it requires a new click. Pending, unknown, conflicting, invalid, or timed-out reads stop advancement. The wait checks the original receipt and finalized head; full graph validation is reserved for the verified transition, rather than repeated as a polling loop. No permanent background polling is introduced.

## Publication scope

`publish.py` replaces only the static upgrade page through an atomic release symlink. It checks the previous release, reviewed JSON pins, new archive, public file hashes, the existing RPC chain identity, business page identity, Nginx configuration fingerprint, and service identities. Previous immutable assets are retained for cached HTML. It does not restart services, rewrite product configuration, or perform chain actions.

Publication and focused verification results are recorded alongside this file after execution. Actual wallet signatures and on-chain upgrade completion are outside static publication verification.

## Executed results

50 focused checks passed (29 component/sequence/journal and 21 plan/proof/package), along with TypeScript and whitespace checks. The candidate package was built from `83bd2180fea2ea7cb066004d75fa4339b39222b7` and published at 2026-10-04T03:17:17.713027+00:00. All ten public files matched the package; the seven reviewed JSON inputs retained their previous bytes. The public browser preview verified the new heading, single primary action, and collapsed technical section without connecting a wallet.

`publication.json`, `publication-pins.json`, `static-release-manifest.json`, `verification.json`, and `upgrade-page.png` preserve the scoped publication evidence. Static publication did not deploy contracts, sign wallet requests, or complete the chain upgrade.
