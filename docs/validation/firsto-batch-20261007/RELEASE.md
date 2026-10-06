# Formal Firsto batch single-leaf upgrade review

Prepared 2026-10-07 CST. No mainnet transaction was signed or broadcast by the
agents. The isolated website prepares two deployments, one schedule, then a
separate execute after the full 48-hour Timelock.

The completed Oct6 core upgrade is the independently pinned predecessor. The
successor preserves its core Funds and every other graph node; FirstoSale keeps
the original genesis Funds link. Only FlexiblePurchase and PoolVault are
replaced. The portfolio sale-remainder pending upgrade remains unchanged.

The current chain was independently read during preparation:
finalized block 126094747, hash
`0x51b25f5039bf1e5cea1af6e130a8ef954210fabe2aded29e669b482ff8bd51db`.
Full `prepared` proof passed in 34,608 ms through the public read-only route.
`formal-live-preflight.json` is independently pinned at
`0x8028149b33e5bcd51b19b329740e513168e8611d28e7ae0cd84b5015e09065a6`.
This proves the preserved current graph, not deployment or activation of this
new candidate.

Deployment chronology: this successful proof preceded the effective read-unit
switch. An earlier drop-in was overridden by `nonce-proof.conf`; the effective
`zz-firsto-batch-read.conf` switch occurred at 2026-10-07 00:56:42 CST. A later
full cold read still encountered an archive throttle. The earlier success is
graph evidence, not evidence that the transport change eliminated the 502s.

Protocol source: [BscScan verified code](https://bscscan.com/address/0x3F58C9cbce933c76158B2A29B0d612c46546Dc43#code).
The compilation with solc 0.8.24 matches the deployed 11,524-byte runtime after
filling only 11 compiler-declared immutable locations. The advertised template
hash is the hash before immutable filling. Full protocol, source archive,
metadata and actual local fill proofs are alongside this report.

Validation:

- 625/625 complete non-fork Forge tests, including existing invariants; no failed
  or skipped tests. Runtime sizes: FlexiblePurchase 18,864 B, PoolVault 24,316 B.
- 26 storage compatibility checks; existing pool storage unchanged.
- Actual current public-order #6128 fill through the real exchange and new pool
  on local BSC fork block 126092616: 1/1 passed. NFT custody, price, fee, reward
  settlement, remaining funds, refunds and consumed leaf all checked.
- 42 integrated plan/proof/native/target-owner graph tests and 3 additional batch
  native compatibility tests passed. Independent source receipt includes the
  earlier 35-test review, contract source comparison and full Forge log hashes.
- 64 keeper/journal/client backend regression tests and 20 focused web regressions
  passed after integration. The client agent also ran its broader 112 backend
  and 141 web test sets before integration.
- 63 actual portal/journal/nonce/receipt/component/HTTP transport tests and
  TypeScript passed. Four strict static packaging regressions passed.
- 124 final isolated read-proxy/server tests passed, including temporary opaque
  429 recovery, persistent refusal, quota, same-chain reproof, concurrent proof
  invalidation, strict fallback epochs and forbidden writes.
- CREATE gas ceilings 5,010,000 and 6,460,000 were measured and tested on a
  disposable local chain with no estimateGas calls and a 20% + 50,000 margin.

The historical strict fork test was not counted as passing: available RPC nodes
could not provide that older state. Current real exchange and pool fills were
separately tested and their source blocks explicitly recorded.

The standalone package has ten independently hashed public JSON inputs and one
HTML, one local JS module, one local stylesheet. Credential-like keys and private
RPC URLs were absent from those JSON files. Existing core and portfolio journals
are isolated from the new journal. Capability remains disabled until a completed,
canonical upgrade catalog is pinned and the full product graph verifies it.

Production change during preparation: only the read-only upgrade RPC unit was
restarted onto a separate three-file reviewed closure. A temporary archive 429
now retries the same archive node once before any strict fallback. No pinned
block was changed to latest. Product signer, keeper, mining services and protected
env/credential files were not modified.

## Final isolated read transport

The separately reviewed transport source is peer commit `93c77656`, integrated
as root commit `80e318a`. The final namespace has 124/124 passing proxy/server
HTTP tests, including eight extra concurrent identity/fork cases and four
header-throttle regression cases. The archive lane starts at most four requests
concurrently with a minimum 100 ms spacing; successful exact numeric-block state
results retain their existing canonical invalidation guards for a 15-minute TTL.
Headers, transaction/receipt postchecks, errors and fallback data do not acquire
that longer result cache.

A second archive refusal during retry identity proof admits only a narrowly
recorded refusal epoch transition. The alternate read must independently prove
chain 56, exact numeric block, unchanged pre/post header and known anchors. The
same captured epoch/fork tuple must remain stable before, during and after that
proof. Wrong identity, malformed identity, another failure or a fork change is
still rejected. A legal sibling read invalidated by that refusal can require a
fresh pure read; it is never treated as a wallet-send retry.

The effective production entry is
`/srv/pinkuang-target-owner-read/releases/firsto-batch-paced-778557adb9e6-20261007/deploy/server/upgrade-read/target-owner-read-server.mjs`,
PID 1152887. After that process started with cold caches and without a readiness
prewarm, the public new entry passed its complete prepared proof in 43,964 ms:
181 logical reads, zero failed reads, finalized block 126099164,
`0xf3b5c879dc98aa5600048c4a06bb97ee9fe24d558af5d5c534c7fbd263a75ca2`.
The report digest is
`0xf17fed1f81d888c3347f825b94a20c88c300daf23375075de9811c49a839d4b4`;
see `formal-live-preflight-post-transport.json` and
`production-cold-read-receipt.json`. The prior failed cold experiment remains
recorded, so an isolated earlier success is not presented as universal upstream
availability. Mainnet transactions performed during all these checks: zero.

## Final portal read retry

Root commits `a0bb55f` and `fed44e6` integrate the independently reviewed portal
read transport. A pure public read retries at most once on HTTP 429/502/503,
with the exact original JSON method, ID and body, within one shared 15-second
deadline. Abort, destroy and backoff cancellation stop pending requests. The
full sequence keeps its existing 60-second read deadline. RPC-shaped errors or
results, malformed JSON-RPC responses, contract reverts and other HTTP errors
do not retry. The wallet provider and wallet transaction path are unchanged.

The final root integration passed 63 focused tests, with 16 actual loopback HTTP
cases. Independent review also passed those 16 final cases plus three additional
contract-error status cases. See `portal-read-review-receipt.json` and
`portal-final-tests.log`. This publication does not deploy or activate a contract.
