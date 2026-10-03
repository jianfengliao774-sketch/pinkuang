# Formal miner order lookup fix — 2026-10-02

## Problem and change

TapeOut #16736 had an open Firsto signed ask, but its netlist enrichment
classification was still `unknown`. The quote proxy and frontend required
`classification=official_mining` even though the collection, category and
Mining verification already identified a supported official miner. This
incorrectly removed the order from both list and detail results.

The proxy and pricing parser now accept `unknown` classification only within
the existing official-collection, official-category and verified-Mining
criteria. Foreign collections, other classifications and unknown/unverified
Mining remain excluded. An exact numeric miner ID now resolves the selected
series directly through the existing official-market then Firsto lookup,
instead of relying on a directory page that may lag behind new listings.

## Formal release

- Prior served formal frontend: `630dd88be042ad13a446449f545cbfde8b4ed7d8`.
- Published source: `7ec97cb15a31cab0848f6db72907a69a9a841b5c`.
- Repository branch: `codex/formal-miner-lookup-20261002`.
- Public site: <https://bemine.cc.cd/bemine-v4/>.
- Static release: `/var/www/bemine-v4/releases/v4-display-7ec97cb15a31`.
- Current symlink verified to resolve to that release.
- Linux workflow: <https://github.com/jianfengliao774-sketch/pinkuang/actions/runs/36890404412>, completed successfully.
- Frontend archive SHA-256: `d9f0cd83d34e1c659471868c70fbc5b818b2e7bba1238428d87a8ae8dd0aab77`.
- Content SHA-256: `939e27cd3cb55e0d628d31bbaee1223907c5b1e9ef69e4c5f7b3697adec7e698`, 290 files.
- GitHub artifact attestations verified against the workflow, source commit and branch.

Only the six lookup implementation/test files were changed from the served
formal source. Existing partner frontend updates were retained. The formal
deployment manifest was compared byte-for-byte with the previous formal
release. Test-only contract configuration was not imported.

The formal artifact digest remains
`0x6007118ac4568be4743a99b44b5259518fcf5a73e091469bfdc4d05a7dc4dd75`;
Factory remains `0xd81dBD0E622447D26405B3576F0C3Fd698AF01B8` and
PortfolioFactory remains `0xc72016011AA2E16Ff48f864f35BAd34CB0Bb21Dc`.
No contract deployment, transaction, wallet signing or migration was performed.

## Active backend patch

The same narrowly scoped classification fix was applied to the active product
and protected deployment-console quote proxies. Both original proxies had
SHA-256 `7bec626e83e6759c95b2569303578628d3e45edbae313a883e7b6a0f1e7856dc`;
the patch required the exact preimage. Each runtime file inventory was updated
for that file and records `runtimePatchSourceHead` separately. Original runtime
source heads were retained because worker health checks bind to those heads.
All 130 product and 104 console inventory files matched after patching.

Backups are under
`/srv/pinkuang-deploy-v4/operations/miner-lookup-20261002-7ec97cb/`.
Nginx configuration passed validation; the previous formal static release is
the first asset fallback so existing browser chunks continue to resolve.
The product and deployment-console services were restarted; index, signer,
purchase and mining workers were left running. All six services were verified
active after publication. The full backend CI archive was not installed over
the running worker configuration.

## Verification

- 53 Node tests passed across proxy, operator quotes, Firsto and quote picker.
- 16 pricing tests passed: 69 related tests in total.
- Formal release metadata returns the published source and unchanged graph.
- Formal public quote endpoint queried with `query=16736`, `processorName=TapeOut`,
  `category=official_mining`, `miningStatus=verified` returns one row and zero
  exclusions. Its signed ask is open, seller price is 0.04000 BNB, buyer cost
  including the source fee is 0.04040 BNB, and estimated daily production is
  0.00432 BEM.
- Formal homepage loaded live project statistics successfully after publication.
  Screenshot: `/private/tmp/bemine-formal-lookup-release.png`.
- The browser's connected account during the formal verification was a
  non-administrator (`0x304F…f3a8`), so the formal operator form could not be
  exercised interactively. Exact-ID lookup and draft-form application were
  covered by the tests; live operator lookup and draft fill had also been
  verified on the independent test site before formal publication. Do not
  interpret this as a formal-site wallet transaction test.

