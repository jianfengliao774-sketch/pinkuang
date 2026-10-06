# Firsto batch portal cold-read diagnosis (local, read-only)

Measured current root sources in /private/tmp/bemine-firsto-batch-upgrade-20261007. No chain writes or production changes. Synthetic graph has 23 preserved nodes, matching the actual reviewed public catalog's 23 nodes. Counts exclude failed-record recovery, portal's extra operationState reads, and wrapper runtime checks, so actual wrapped historical receipts may add reads.

| Phase | Calls | Naive identical-key unique | chain | headers | code | storage | state | tx | receipts |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| prepared, no deployment | 177 | 142 | 6 | 30 | 52 | 8 | 61 | 10 | 10 |
| prepared, one deployment | 184 | 146 | 6 | 32 | 53 | 8 | 61 | 12 | 12 |
| unscheduled, two deployments | 199 | 158 | 6 | 34 | 54 | 8 | 69 | 14 | 14 |
| scheduled | 205 | 161 | 6 | 36 | 54 | 8 | 69 | 16 | 16 |
| done | 213 | 166 | 6 | 39 | 54 | 8 | 70 | 18 | 18 |

Prepared cold: predecessor verification 114 calls; successor graph/postcheck 60; initial snapshot 3. Same input and same provider second run: 84 calls, proving predecessorCache + completedCache already work within one provider's lifetime. New portal run constructs a new provider and destroys it on exit, so a new click/F5 loses branded provider completion cache. This existing optimization cannot establish fast cold behavior.

The 35 naive prepared duplicates are mostly deliberate independent evidence rereads: 19 header duplicates, 10 transaction/receipt duplicates, 5 chain repeats, and ONLY ONE identical fixed-state call. Code and storage are already unique when block numbers are included. Caching all duplicate responses would weaken canonical postchecks. Inflight dedup only within an active wave is safe; sequential canonical/post receipt rereads must reach upstream again.

With one globally serialized upstream lane and minimum start spacing 1100 ms, cold prepared requires at least 193.6 seconds (excluding transport latency and validation CPU); naive total-key dedup lower bound 155.1 sec is still >60 sec and not an approved security-preserving optimization. Same-provider warm 84 calls still requires >=91.3 sec at this spacing. State-only exact result caching saves just 1 cold call.

Timeout stack:
- deploy/src/FirstoBatchUpgradeStandalone.tsx:44: FetchRequest.timeout = 15000, maxAttempts1/retryFunc false, batchMaxCount1/cacheTimeout-1/staticNetwork true.
- :153 creates a new provider per run; :205 destroys it.
- :166-175 default session.read timeout60000 aborts the whole read operation; :294 places the full preflight inside this boundary.
- :209-219 operationState adds finalized/chain/timestamp/canonical reads for records having both deployments.
- deploy/shared/firsto-batch-upgrade-proof.mjs:175-177 calls full completed prior target-owner proof at the reviewed anchor, then :183-186 launches 23 current-code reads concurrently.
- deploy/shared/target-owner-upgrade-proof.mjs:175-185 reads prior preserved codes/storage sequentially; :339-372 uses branded completion cache, never a JSON claimed proof.

Minimal proposals, not applied:
1. Keep fixed block-number + exact args read caching limited to code/storage/eth_call, bounded per full verification lifecycle. Do not reuse results after the relevant canonical anchor changed. Before and after every complete verification, block headers and chain identity must remain independent uncached reads. Transactions/receipts canonical postchecks must also be independent. Inflight headers for simultaneous same-wave duplicate requests may coalesce but must be deleted after settlement.
2. Cold cache cannot supply speed by itself. Select a measured, bounded transport rate allowing the true cold request volume within a declared overall budget; do not claim success from prewarming. If measured safe rate is below required throughput, explicitly raise the read-only wholeproof budget (not wallet timeout) and show progress rather than silently omitting history. A 1100ms serial plan requires >=300s read budget plus bounded per-request queue handling.
3. Maintain narrow max3 pure-read retries for recoverable429/502, cancellation checks before and after backoff, bounded total deadline and queue drain. Retry the same method/params only; no wallet-send retry. With server retries, avoid browser retry multiplicative amplification.
4. If preserving one provider for a page lifetime to retain existing branded predecessor cache, keep input identity pins and cache's current header/runtime checks; destroy only at unmount, stop each aborted verification, and do not reuse an aborted provider. This helps later clicks, but first cold run still must be solved.

Independent real loopback HTTP test: actual ethers FetchRequest + complete proof, HTTP429 at request27 after26 successful reads. No retry -> bounded reject at27. Pure-read max3 -> succeeds178 requests,177 success +1 rate limit +1 retry. Same retry then a late finalized header reorg -> CANONICAL_REJECT. Persistent429 -> reject at29requests after3 limits/2retries. All cases reject non-read methods and wrote0 chain transactions.

Files: preflight-count.mjs, preflight-waves.mjs, preflight-breakdown.mjs, cold-partial-429.mjs in this directory. These diagnostics contain no RPC credentials or real wallet salts/signatures; scripts generate their own synthetic fixtures.
