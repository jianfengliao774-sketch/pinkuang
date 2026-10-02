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

## Formal product activation

The v5 journal records all 16 bootstrap and 7 Authority steps confirmed. Public
receipts are in `mainnet-deployment.json`. `live-graph-verification.json` is an
independent mainnet verification at block 125317258 against the deployed Solidity
artifacts. `frontend-manifest.json` and `fresh-activation.json` bind the website,
API, index and workers to this new graph. Whole-miner timing is three days.

The product is rebuilt from this branch's committed source. Historical static
releases labelled d90f5f09cd0a63c9321abcf080f60d5fc8ae9e75 (formal) and
1f3c3809ca442965dba98987478afe91260bc8c1 (test) did not include recoverable Git
source in either accessible remote. This build does not claim byte-for-byte
identity with those old static assets; its exact source commit is included in
both release manifests. The source includes the merged live community UI,
5-row records, server display caches, transaction submission fixes and native
Firsto sale support. Old site binaries and asset recovery evidence remain saved.

`runtime/` contains the isolated v5 systemd/nginx templates. Replace `@RUNTIME@`
with the immutable `/srv/pinkuang-v5/releases/v5-product-<commit>` release and
`@INDEX_SHA@` with that package's index manifest digest. v5 API/index ports are
4227/4224, each with a new database. Internal `fresh-v4` schema labels describe
the existing protocol, not the website namespace or contract identity.

All v5 senders use one new v5 wallet lock domain, after the v2/v4 senders have
stopped and their terminal transactions and pending nonce have been verified.
The signer replaces the paused v4 attestor on its existing protected IPC socket,
which also keeps the separate v5 deployment console functional. Protected Gas
and HMAC credentials are supplied by systemd and never packaged or committed.

The old v4 and test sites remain paused under
[the retirement runbook](../retired-20261002/README.md). Their two NFT assets and
contracts are unchanged. Rollback stops only v5 services, restores the attestor
and removes only the v5 nginx include; it does not reopen any old site.

## Release status - 2026-10-02 23:52 CST

The complete static and runtime packages were built from `dea3a78` and verified.
37 frontend/build tests, 131 runtime/readiness tests, 41 index/relay tests and
6 packaging/layout tests passed (the last group overlaps the frontend run).
All 26 initial HTML asset references resolve inside the v5 static package.
The separate install and read-only nonce verification scripts are ready.

**Not yet published:** SSH and HTTPS connections to the existing server began
failing before the upload. No v5 services, website symlink or nginx routing
were changed. `release-status.json` records the artifact digests and the exact
pending state. Resume by restoring connectivity, copying the prepared upload
directory, installing it, verifying index/worker readiness, then publishing
only the v5 nginx include and root redirect. Do not redeploy contracts.
