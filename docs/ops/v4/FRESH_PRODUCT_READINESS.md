# Fresh v4 product readiness and user-paid exits

This patch changes no Solidity or deployment artifact. The original Stage 1 record, seven finalized Stage 2 receipts, genesis digest and public manifest remain unchanged. Code tests do not mean the production services are activated.

## User rule, confirmed 2026-09-30

Members pay their own Gas for claiming, refunds and cancellation. These actions go directly from the user's wallet to the registered contract; the public API only verifies and journals them. They never use the platform Gas signer or Authority relay. The platform Gas wallet pays only for the existing allowlisted automation and administrator-authorized backend calls; every transaction it constructs has `value=0`, and any miner purchase principal remains inside the pool contracts. Existing administrator `claimFees` is a separate Authority action and is not a member claim.

`deploy/shared/fresh-user-exits.mjs` is the single browser/server allowlist. It binds `targetType`, exact decoded action and zero value. New investments, new orders, purchase and administrator calls remain subject to full operational readiness. Exits retain current complete graph, account, registration, exact ABI/calldata, value, fee, balance, nonce and canonical-block checks. The existing user-selected fast path does not reintroduce global transaction simulation; existing frontend state previews and final contract execution still enforce deadlines and settlement conditions. A rejected or unknown transaction never becomes a successful withdrawal.

`userExitReady` is true only on the current complete fresh graph in the dedicated product process. Stale display snapshots force it false. `operationalReady` independently reflects real workers, relay, old-sender drain and index health. Existing pending/hash/receipt recovery remains available when operational readiness is false.

## Fixed configuration and isolation

Product: `BEMINE_FRESH_PRODUCT_ENABLED=1`, `HOST=127.0.0.1`, `PORT=4187`, `BEMINE_FRESH_CONSOLE_PRE_GENESIS=0`, `BEMINE_FRESH_STAGE2_HOLD=1`, `AUTHORITY_RELAY_PUBLIC_ENABLED=1`, `AUTHORITY_RELAY_ENABLED=0`. The separate console remains on 4177. Product mode rejects deployment and fresh-activation routes before authentication. Use its own SQLite database and exact product origin.

Set `BEMINE_INDEX_URL=http://127.0.0.1:4184`. `BEMINE_FRESH_PRODUCT_MANIFEST_PATH` must name the canonical `kind=fresh-v4-index` file, not the browser integrated-v2 manifest. `BEMINE_FRESH_PRODUCT_MANIFEST_SHA256` pins its exact canonical file bytes. Both fresh Factories, all graph code hashes, genesis initialization and Authority activation are bound to the preserved records.

The complete product-backend package now includes API, index, signer, purchase and mining entrypoints and their exact static import closure. Every operational role reads the package's real `sourceHead` from `public/fresh-release-manifest.json`. An old attestation-only package is not operational readiness. The signer requires `AUTHORITY_REQUIRE_FRESH_READINESS=1`. `AUTHORITY_ATTESTATION_ORIGIN` may preserve the console's read-only Gas-possession proof independently of the product transaction origin; it does not extend transaction Origin permission.

## Machine proof and old sender drain

The public process receives only the systemd HMAC credential, never the Gas key. A nonce-bound, short-lived, replay-protected request to `/internal/fresh-product-readiness` on the fixed Unix socket asks the signer to recompute readiness. This performs no wallet signature and cannot use an attestation-only signer as proof of send capability.

The fixed worker units are `pinkuang-v4-purchase.service` and `pinkuang-v4-mining.service`. They require `--fresh-graph`, the same graph and credential, separate durable journals and shared `/var/lib/pinkuang-v4-signer/keeper` nonce locks. Mining additionally requires the reviewed Authority target. Their common fresh guard uses the explicit `FRESH_PURCHASE_ENABLED=1` opt-in. Successful scans publish 0600 heartbeats under the fixed 0700 `/var/lib/pinkuang-v4-signer/readiness` directory. Signer checks real systemd PID/InvocationID, source head, graph identity, canonical scan block and maximum 90-second age. Errors/ambiguous scans revoke readiness. A correctly verified empty deployment may report ready without inventing a transaction.

A root-owned non-group/world-writable `/etc/pinkuang-v4/legacy-drain.json` binds the old Gas wallet, reviewed terminal ledger hashes/receipts and the cutover nonce. Every listed old sender must remain stopped and disabled; terminal receipts are rechecked canonical and finalized. Root's reviewed inventory must include all old sender processes. A v4 worker can reopen and reconcile its own existing pending journal, but new signing requires latest nonce equal to pending nonce.

New investment and relay POST require complete live index state for all four addresses, original start block, bounded head age and canonical hashes. A display snapshot cannot authorize them. Relay GET status does not depend on worker readiness. Budget procurement remains two separate administrator approvals: create child, then buy it. The queue's narrow `created -> buying` transition can clear the current transaction hash/nonce only while retaining the confirmed child, creation hash and result.

## Validation and remaining operations

Independent Linux snapshot `/tmp/pinkuang-fresh-product-check-_cs9o3_s` reused exactly matching npm-lock dependencies. The final regression passed 127/127 tests with zero failures or skips, including the shared exit boundary. Exact source and log hashes are recorded in the handoff manifest. Tests cover HTTP process separation, SQLite two-step queue, current identity/index/systemd proof, member transaction validation, relay authorization, worker recovery and package closures. No transaction was signed or broadcast to mainnet, no production service or database was changed, and no new contract fork run was needed for unchanged Solidity.

Production still needs reviewed package installation, root's old-sender shutdown and drain proof, isolated index synchronization, service activation and live acceptance. Administrator `setDepositPaused` remains outside the existing HTTP allowlist; this patch does not silently add an administrative capability.
