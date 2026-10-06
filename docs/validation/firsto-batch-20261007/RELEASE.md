# Formal Firsto batch single-leaf upgrade review

Prepared 2026-10-07 CST. No mainnet transaction was signed or broadcast by the
agents. The isolated website prepares two deployments, one schedule, then a
separate execute after the full 48-hour Timelock.

The completed Oct6 core upgrade is the independently pinned predecessor. The
successor preserves its core Funds and every other graph node; FirstoSale keeps
the original genesis Funds link. Only FlexiblePurchase and PoolVault are
replaced. The portfolio sale-remainder pending upgrade remains unchanged.

The current chain was independently read after the upgrade-read transport fix:
finalized block 126094747, hash
`0x51b25f5039bf1e5cea1af6e130a8ef954210fabe2aded29e669b482ff8bd51db`.
Full `prepared` proof passed in 34,608 ms through the public read-only route.
`formal-live-preflight.json` is independently pinned at
`0x8028149b33e5bcd51b19b329740e513168e8611d28e7ae0cd84b5015e09065a6`.
This proves the preserved current graph, not deployment or activation of this
new candidate.

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
- 47 actual portal/journal/nonce/receipt/component tests and TypeScript passed.
- 107 isolated read-proxy/server tests passed, including temporary opaque 429
  recovery, persistent refusal, quota, same-chain reproof and forbidden writes.
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
