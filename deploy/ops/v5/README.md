# New formal deployment (v5)

User selected a new independent formal graph on BNB mainnet. Existing v4 assets and the full-test graph stay in their original contracts. This branch does not upgrade, migrate, or overwrite either live product.

## Existing public roles

Verified against the current formal Authority and original deployment receipt on 2026-10-02:

| Role | Address |
| --- | --- |
| Administrator one | `0x7674fa446D42b1f7f150DC5e678cc525d275Ea53` |
| Administrator two | `0xeD2FCBe59EBe1754a3676aeb9CcfBA20f193FcbB` |
| Gas payer | `0xA285d1933e32b5990625aC1F5BEa205Cf2606619` |
| Deployment wallet | `0x042B23288E2316DFb6503488292FD0Ad2F811Ae7` |

These are the existing `shared/fresh-roles.mjs` values; no new private key is required for this console. The deployment wallet signs the 16 bootstrap and 7 Authority configuration transactions. The Gas signer supplies only its possession attestation at this stage; the console has no private-key credential and its public relay is disabled.

## Timing and local verification

- Miner holding period, proposal interval and sale-round cooldown: **3 days**.
- Voting: 24 hours. Listing expiry: 7 days. Upgrade timelock: 48 hours.
- Stateless creation/custody checks were moved to the already linked `PurchaseValidation` library to keep all deployment runtimes within EIP-170. Storage and checks are unchanged.
- Contract unit suite passed. Voting invariants and market/sale tests passed.
- `scripts/formal-v5/verify-graph.mjs` deployed the complete graph on a disposable local Anvil chain, exercised the exact 3-day boundary, sale settlement, member withdrawals and 48-hour timelock. Its evidence and measured fixed Gas plan are in `deploy/public/formal-v5/`. These addresses and receipts are **local fixtures, not mainnet deployments**.
- The real browser deployment engine passed its 16+7 integration test with fixed Gas limits and no app-side transaction simulation/estimation.

## Isolated console

`https://tapeout.cc.cd/pinkuang-deploy-v5/` uses a new service, port 4217, release root and SQLite journal. It uses the existing signed wallet login and designated-deployer check, with no extra HTTP password prompt. It reuses the protected read-RPC configuration. A separate index destination (4224) avoids mixing old project data. No v5 index or product is activated by installing this console. The older console's HTTP authentication is unchanged.

Build and package from committed source using `deploy/scripts/package-fresh-console.mjs`. Install the adjacent unit and nginx snippet; add the snippet inside the existing tapeout HTTPS server, validate nginx, then reload. The older snippets and services stay unchanged. Rollback removes only the v5 include and stops `pinkuang-deploy-v5`.

## Remaining product activation requirements

2026-10-02 update: the live v5 journal now records all 16 bootstrap and 7 Authority
steps confirmed. Public receipts and addresses are in `mainnet-deployment.json`.
The new website/index are not active yet. At the user's request, old/test sites
(including v4) were temporarily paused; their assets and recovery records are
preserved under [the retirement runbook](../retired-20261002/README.md).

1. Obtain the actual latest website sources: live formal static release identifies `d90f5f09cd0a63c9321abcf080f60d5fc8ae9e75`, test identifies `1f3c3809ca442965dba98987478afe91260bc8c1`. Neither commit was present in either Git remote or available checkouts during preparation. This branch starts from formal `5785c04`; do not describe its website as the exact latest live source.
2. Export and independently verify the completed mainnet graph, then derive its pinned manifest from the confirmed deployment and activation records.
3. Prepare `/bemine-v5/`, its separate cache/index and backend from that manifest, using the recovered latest website source. Old v4 remains temporarily closed until the user requests recovery; do not reopen it as part of v5 activation.
4. Coordinate the shared Gas wallet through one nonce journal before enabling new background senders. Never run two independent nonce managers for this account. The pre-genesis console installed here does not send Gas-wallet transactions.

No v5 mainnet receipts or final product manifest are asserted by the local evidence.
