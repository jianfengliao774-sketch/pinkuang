# Upgrade wallet result recovery — 2026-10-04

This release updates only the standalone formal upgrade website at `https://bemine.cc.cd/pinkuang-target-owner-upgrade/`. It does not deploy or activate contracts and does not migrate historical owners.

Before a new wallet send, the journal now pins the account nonce and a canonical finalized BSC block. The wallet receives that exact nonce. A user-triggered **核对当前交易** action locates the original transaction using bounded historical nonce reads and one full block, then verifies exact sender, destination, value, calldata, CREATE address and finalized inclusion through the public provider. Recovery sends no transaction. No polling loop, mempool scan or historical full-chain scan is added.

The public read proxy deliberately does not expose nonce or full-block methods. Those two read methods use the selected wallet; public block headers and exact transaction/receipt checks remain authoritative. Conflicting wallet state, chain changes and unavailable history stop recovery without clearing the saved intent.

A genuine returned wallet hash can be saved after a local storage failure. Existing-journal import can enrich only the same nonce-bound row with a canonical proven hash, preserving all other progress. Failed finalized receipts are archived, and retries require a later user click. The 48-hour schedule and fresh-click execution requirements remain.

**Legacy limitation:** the user's earlier v1 PoolFunds row saved neither a transaction hash nor nonce. Current nonce, an empty wallet activity list or an unrelated identical deployment cannot prove whether that original request broadcast. That row remains blocked; this release does not invent its nonce or clear it. Private wallet records and salts are not included in this evidence directory.

Validation: 50 core, sequence and actual component tests passed; TypeScript `--noEmit` and `git diff --check` passed. Tests cover lost wallet response, storage recovery, read-only success/failure recovery, exact-intent imports, wrong nonce/payload, canonical reorg and legacy fail-closed behavior. Candidate artifact/catalog pins and all seven reviewed public JSON inputs remain identical.

Published at **2026-10-04 13:05:20 CST**, with UI source commit `3b09f155789c83859de384e3d3d243dc2a561b4d`. The public HTML, all ten manifest files and read-only BSC chain ID were verified. Business site bytes, seven service identities and nginx configuration remained unchanged. No contract transaction was submitted or activated.

`publish.py` checks the exact prior upgrade manifest, reviewed input identities, package hash, complete public file hashes and unchanged business site/service identities. It atomically switches only the upgrade static symlink and rolls back on failed public verification. See `publication-pins.json` and `publication.json` for the release receipt.

A background Codex in-app browser loaded the public page, expanded **技术信息与记录恢复**, and displayed the exact new UI source suffix `3b09f155…561b4d`. `upgrade-public.png` records this public view. No wallet was connected and no send or signing control was used.
