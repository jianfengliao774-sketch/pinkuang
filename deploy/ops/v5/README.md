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

## Release status — 2026-10-03 07:39 CST

**Published:** `https://bemine.cc.cd/` and `https://bemine.cc.cd/bemine-v5/` both serve the same v5 homepage directly. Verified 2026-10-03 by comparing the two HTTP response bodies (SHA-256 `7ac16fe9100938cbf7711722bf21dbbb0e51c2e3b2bb00201ae66cd2f6ddcd4b`).
The website and backend use `dea3a78b51352df45771ce6d54043b874e70383e`;
this activation adds operational scripts and evidence without replacing the
reviewed business build or redeploying any contract.

The 6 isolated runtime units are installed, enabled and active. The separate v5
deployment console remains available. The live graph was checked at block
125380223; all old Gas transactions at nonces 0–7 are canonical and finalized,
with latest/pending nonce 8 at cutover. The old v4 signer was then disabled.
The index caught up at block 125381838 before routing was enabled; the API
reported `fresh-active` and `operationalReady: true`.

`publication-receipt.json` records the switch, source/artifact identity and
HTTP checks. `live-activation-proof.json` records the read-only graph and drain
checks. Public website, statistics, pools, orders, price and initial assets
were checked after publication; browser home and project-list data loaded.
No financial wallet flow or end-to-end purchase/sale was performed on mainnet.
Old v4 and full-test entry points still return 503, preserving their contracts,
files and recovery records. The new graph has no projects yet.

The setup scripts parse quoted environment values using Node's `parseEnv`;
credentials are never printed. Publication allows a bounded graceful nginx
worker transition and rolls back routing if its HTTP checks fail. The index's
public-node header concurrency override is `runtime/20-read-throughput.conf`;
event reads continue to use the existing dedicated endpoint. Install that file
as `/etc/systemd/system/pinkuang-index-v5.service.d/20-read-throughput.conf`.

37 frontend/build tests, 131 runtime/readiness tests and 41 index/relay tests
passed during packaging; the 6 packaging/layout checks overlap the frontend
run. Current activation evidence does not imply independent audit approval.

## Contract-upgrade review entry — 2026-10-03 18:40 CST

The isolated, same-origin upgrade review and wallet-signing entry is published
at [bemine.cc.cd/pinkuang-upgrade-v5](https://bemine.cc.cd/pinkuang-upgrade-v5/).
It is served from the existing BEMine host; the homepage and current v5 app
were left in place. The deployed static release was built from source commit
`d57184739859ac7249ab2bd2dd6a542612fc4507`; its candidate bundle digest is
`0xbe37228e94095440e9cde68ae7b5e605b75154a5c7453d58b796ddb2925ec927` and its
genesis digest is
`0x9523dd920e91dcab4358eceddff660d65357bfe1fe3bf6f3e7823cbc94af2502`.
The public route returned HTTP 200 and all six served-file hashes matched the
release manifest on verification.

**The contract upgrade has not been signed, scheduled, or executed.** This
release only provides the review/signing page; an administrator must review
and sign with the authorized wallet, then the on-chain 48-hour timelock must
complete. The production app must not be switched to the new implementation
before that process is complete.

## Public security-review handoff - 2026-10-03

The complete source snapshot and mainnet evidence are available in the dedicated
[public review repository](https://github.com/jianfengliao774-sketch/bemine-v5-security-review/tree/a4d1767208356fb6330103eb06ac420cca649955),
tag `v5-review-2026-10-03`. All 1813 tracked files from `05d4803` were exported and
SHA-256 verified; only the original README was relocated to preserve a current
review entry point. A fresh lockfile install and artifact recompilation matched
the mainnet deployment artifact content and digest. The repository includes the
scope, permission model, build instructions, limitations and report template.
GitHub Actions is disabled there; no runtime credentials or server state were
copied. This is an independent review input, not an audit certification.

The initial review tag records the earlier pending deployment state and stays
immutable. The review repository now also includes `audit/activation/` with
the live publication evidence and additional installation scripts; reviewers
should use its current branch for that supplement. The original 1813 source
files remain byte-for-byte verifiable.
