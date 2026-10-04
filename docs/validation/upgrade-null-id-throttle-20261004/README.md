# Standalone upgrade RPC and receipt-state repair

Published source: `6841bf0132f600870b135e728ecb8ff5e882ee98`.
Public entry: https://bemine.cc.cd/pinkuang-target-owner-upgrade/
This release changes the standalone upgrade read helper and its receipt-recovery UI. It does not replace contract artifacts or submit a chain transaction.

## Findings and behavior

The previous helper remained active without restarts. Its captured `eth_call` refusals were HTTP 429 / JSON-RPC `-32005`, with an object-valued response ID which did not match the request. The old diagnostics did not preserve the exact ID value or throttle-message category, so those historical entries do not prove whether the provider refused a per-second limit or a monthly quota. Four bounded direct read-only probes were healthy during investigation; this is not a monthly allowance/billing measurement.

An explicit per-second refusal with HTTP 429, JSON-RPC 2.0, own `id: null`, error-only `-32005` envelope was rejected before reaching the existing retry path. This release recognizes that narrow refusal only as a signal for one retry against the same archive endpoint. A null ID is never accepted as a successful result or a chain proof. Quota errors, wrong non-null IDs, missing IDs, mixed result/error responses, reverts and ambiguous refusals do not enter this path.

Retries share a cooldown and paced lane. Chain-56 proofs are exact-ID, short-lived and renewed before a delayed retry when necessary. Retry work has a four-second lane-wait cap and the retry-enabled request has one fourteen-second budget, including body read, queue, proof, data and retry. Final data still requires HTTP 200 and a matching result envelope. No fallback chain or write method is enabled. New diagnostics record only a `cups`, `quota` or `other` enum, never an upstream URL or raw provider message.

The UI previously left a transaction labeled pending when its canonical receipt had already passed but component-graph reads failed. It now distinguishes a confirmed chain transaction awaiting component verification. Temporary read failures preserve the original journal/hash for the **核对当前交易** action; they never trigger a resend. Confirmed journal state is persisted only after all component checks pass, and each new recovery attempt re-proves the original receipt. Integrity errors remain explicit. The 48-hour timelock is unchanged.

## Verification

- Related server, shared proof and target-owner script tests: **490 passed, 1 skipped, 0 failed**.
- All target-owner UI test files: **75 passed, 0 failed**.
- TypeScript check, standalone Vite build, pinned static preparation/package verification and diff whitespace checks passed.
- Offline injection cases cover null-ID CUPS, matching-ID CUPS, quota/wrong-ID/mixed-envelope failures, retry-wave concurrency, proof TTL expiry, deadline expiry and canonical/reorg cache rules. Mounted UI tests cover receipt confirmation followed by a 502, recovery without duplicate sending, and integrity failure handling.
- Candidate loopback complete prepared-phase proof: **94 read requests, no failures, 15.5 seconds**. The first proof was also successful; a second was required because the five-minute activation evidence window expired during independent publication reconciliation. One intermediate probe used the wrong local route `/rpc` and returned 404; the actual helper route `/api/rpc` passed. This did not alter the published route.
- Public route check after activation: **8 read requests and 3 static-file hashes**, all successful, 5.5 seconds. A probe's initially incorrect `minDelay()` selector produced a JSON-RPC error; the reviewed `getMinDelay()` getter passed and returned **172800 seconds**. This was a probe-fixture error, not a 502. The checked receipt in that small probe belongs to the historical genesis deployment, not the user's pending upgrade.
- The browser exposed the original pending PoolFunds transaction. A separate public prepared-phase proof using that exact transaction passed **107 read requests without failure in 17.6 seconds**. Its confirmed CREATE address is `0x00eB4BE0695db8d93685C8f04F1676D67318571b`; sender, exact reviewed initcode, canonical receipt/dependency prefix and baseline graph all passed. The proof is in `pending-original-proof.json`. The user's local journal was not edited and no wallet request was issued.
- Browser page loaded source `6841bf01…82ee98`, the original transaction link, MetaMask selector and **核对当前交易** action without a red error. The local journal still awaits that user action; this release does not claim the remaining two deployments or the timelock execution are complete.

Local final validation used Node 24.19.0; the deployed helper uses Node 24.20.0. No live CUPS refusal occurred in the successful final probes; the refusal branch is covered by injected tests.

The broader fresh-product `npm test` run was attempted and was not fully green: unrelated fresh 16+7 deployment fixtures hit reviewed artifact/Gas-plan pin mismatches. A temporarily regenerated tracked artifact was restored to the original bytes. Those fixtures, contracts and pins are unchanged in this repair. Do not describe this evidence as a passing full-repository suite or a new genesis-deployment validation.

## Publication and isolation

The standalone static UI was atomically published at 09:34:45 UTC. The first helper activation stopped at its pre-mutation protected-state check because a separate UI-only formal-site release had changed the formal symlink at 09:33:46 UTC. The original snapshot was preserved. The replacement snapshot was accepted only after verifying the independent formal activation receipt and manifest, the final 899-file tree digest, unchanged data/JSON identities, the approved standalone UI package and all original service/nginx/environment/helper bindings.

`read-baseline-reconciliation.json` records those original and replacement snapshot hashes. `reconcile-read-baseline.py` and `publish-read.py` show the exact gates. Pre-switch, post-switch and rollback checks use the same reconciled snapshot; only the four static path/file-map fields changed. This preserves the newer formal release rather than reverting it.

At 09:43:03 UTC only `pinkuang-target-owner-read` was restarted, bound to the new three-file closure on existing loopback port 4228. The private environment, nginx, eight business services, formal static site and standalone static package were unchanged by that restart. The owned candidate listener on 4229 was stopped and the local SSH tunnel was closed. Final helper health was active/running with zero restarts. Backend and UI publication receipts, immutable source/package maps, public proof and sanitized test tails are alongside this file.

No credentials, signing keys, provider URLs, unknown journal content or full private environment snapshots are included in these public review files. No wallet signature, chain submission, pending-record clearing or contract execution was performed.
