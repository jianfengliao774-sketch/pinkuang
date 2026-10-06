# Firsto batch single-leaf purchase upgrade

Formal signing entry: `https://bemine.cc.cd/pinkuang-firsto-batch-upgrade/`.

The deployed target-owner version handles signed single asks. This successor adds
purchase of the specified miner leaf from the reviewed Firsto batch ask exchange.
It is not a batch portfolio procurement upgrade.

The page requests two CREATE transactions (`FlexiblePurchase`, `PoolVault`) and
one Timelock schedule transaction. The deployment wallet confirms each request.
After the full on-chain 48-hour delay, the page requests a separate execute
transaction. Opening the page never sends a transaction. Its journal has a
separate kind and storage key; old core and portfolio records are retained.

The existing Factory, Beacon, Timelock, Authority, core Funds, pool storage and
assets are preserved. FirstoSale retains its original genesis Funds link. The
pending portfolio sale-remainder upgrade is neither executed nor cancelled by
this entry. Mainnet transactions were not submitted during preparation.

Evidence is in `docs/validation/firsto-batch-20261007/`. Protocol source was
recompiled with solc 0.8.24 and matched the deployed runtime byte for byte after
only compiler-declared immutable filling. A real currently listed miner was
purchased through the real exchange and new pool on a local BSC fork.

The reviewed successor deploys only two components. After execution, publish a
new independently pinned activation catalog and candidate bundle to the product
graph before enabling `firstoBatchPurchase`. The frontend and keeper adapters in
this branch default to disabled until that complete graph proof passes. Existing
purchase routes remain available during the waiting period.

## Reproducible preparation

Use the pinned Node 24 runtime and repository-pinned toolchain. Generate the
candidate with the normal deployment artifact compiler, assemble the approved
predecessor and current review, run the read-only preflight, then invoke:

```sh
node deploy/scripts/prepare-firsto-batch-static.mjs --input /absolute/input.json \
  --live-review /absolute/live.json --live-review-digest 0x...
cd deploy
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build --config vite.firsto-batch.config.ts
node scripts/package-firsto-batch-static.mjs
```

The preparer independently pins the genesis, completed predecessor, candidate,
protocol review, mixed graph and measured CREATE gas evidence. The packager
rejects symlinks, unknown public files, changed JSON and changed source hashes.
The isolated signing entry uses a read-only RPC route; wallet writes stay in the
user's selected provider.

The upgrade-read service fixes temporary archive 429 refusals by retrying the
same archive node once, with existing pacing and a fresh chain proof. Persistent
refusals remain errors. It never substitutes a latest block for a pinned historic
proof. Its code is isolated in `deploy/server/upgrade-read/` so the product signer
and keeper services are not changed by this transport deployment.
