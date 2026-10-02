# Funded test project procurement and display repair — 2026-10-02

The repair starts from the newest remote branches, test `1c4a4ab` and formal
`6b033da`. Shared changes were committed independently as test `8a572a7` and
formal `3cd3b1b`; formal keeps its own interface, contracts and administrators.

## Causes and changes

- The public API omitted `/v1/display/portfolios` and its detail route from its
  proxy allowlist. The underlying cache returned an empty budget directory,
  but the proxy returned 404. That false partial-read failure hid all directory
  counts, including the successfully loaded single-miner project. Both routes
  now forward validated, bounded read queries to the existing local cache.
- A wallet receipt could appear before the confirmed index and materialized
  display cache. The single immediate refresh returned the pre-transaction
  snapshot and had no receipt-specific follow-up. Successful receipts now
  trigger display GETs every three seconds for at most two minutes, ending when
  the mounted sections include the receipt block. Separate refresh generations
  leave governance, operator and quote RPC reads unchanged. Hidden pages,
  active forms and later record pages pause the display catch-up.
- A failed budget materializer could suppress the healthy single-pool update
  stream. Independent successful caches may now request publication; the
  existing complete-index and materialized-business-event revision gates still
  prevent publishing an older pool generation.
- The Authority sender only reconciled its durable journal when a browser
  polled status. The private signer now tracks the existing receipt every five
  seconds through the same serialized queue. It never signs, rebroadcasts or
  acknowledges another operation. Idle or finalized journals make no RPC call.
- Purchase supervision now treats another journal's wallet reservation as a
  normal wait. It preserves the owning ledger and nonce, skips the signing
  cycle, does not renew readiness, and resumes on a later scan after the owner
  records a finalized receipt. Missing or corrupt ledgers remain errors.

## Live test recovery

NFT TapeOut #16736 belongs to test pool
`0x0d776F099Fe694E07A7509334067b1f92F68Cd0E`. Its funding was already 100/100.
The blocking Authority transaction was a duplicate creation, not procurement:
`0xdf0cc20612587038a9df197645bbe4febd19bbffd273c4baf990cf4fc1d0069f`.
It failed in block 125200207 and consumed Gas-wallet nonce 1.

Receipt-only recovery checked the exact transaction, canonical finalized block,
Authority runtime, nonce and Gas ledger. It recorded the 4,082,550,000,000 wei
fee and archived the reviewed failure without broadcasting a transaction.
The original private journal backup and cumulative Gas accounting were retained.

After the reviewed worker restart, automatic procurement succeeded in block
125203464, transaction
`0xfb84e3c884b579bcb00199d86906eb568293cb6d5fb560fd115dbe61b0882397`.
The purchase journal recorded BSC-finalized success and no unresolved wallet
nonce remained. A subsequent read at block 125203699 confirmed pool state 2,
100 holder shares, NFT ownership by the pool, cost 0.04040 BNB and holder BNB
credit 0.00404. Official Mining reported an active miner, Task 4 and verified
weight 1. The NFT was already mining before acquisition and remained active;
the mining supervisor did not need to send an extra startup transaction.
The public display API subsequently returned these new values with errorMask 0
and indexedThrough 125203656, after the procurement block.

The test receipt RPC intermittently returned HTTP 403. The test index RPC also
returned missing-state errors during deployment reads at the recent safe head.
`DEPLOYMENT_JOURNAL_RPC_URL` and `CHAIN_INDEX_RPC_URL` in the test RPC environment
were changed to the successfully checked `bsc-dataseed1.binance.org`. Other
environment keys, credentials and all formal RPC configuration were preserved.
Formal endpoints were reading successfully. After this change, the test index
advanced normally and its deployment-read errors stopped.

The full-test config can briefly report not ready when its 15-second readiness
sample overlaps an index refresh. This is not an automation stop: procurement
and mining supervisors use their independent RPC and journal heartbeat paths,
and direct member-wallet actions use the display-only bootstrap path.

## Publication and validation

Test publication completed at 01:20 UTC; formal at 01:22 UTC. Runtime modules
and their installed SHA inventories were updated in the current service roots.
Static releases changed atomically. Genesis source identity, active manifests,
contract bundles, administrator/Gas bindings, deployment receipts and database
files were preserved. The test deployment console was copied unchanged.

The live test contract digest remains
`0x3d386ce28a1898546697d1ee715b5276104894f781e68b785306eac9cde5338b`.
No new contracts were deployed for this repair.

Seven isolated Linux regression suites passed 103/103 tests, including real
wallet/journal flock contention and receipt reconciliation. Frontend catch-up,
wallet no-resend, proxy and JSX integration tests passed; both static builds
passed base-path, artifact and manifest-binding checks.

Redacted release, recovery, test and public-read evidence is retained locally
under `outputs/test-project-repair-20261002/`.
