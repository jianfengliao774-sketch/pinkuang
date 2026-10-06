# Latest branch integration audit · 2026-10-01

## Selected business baseline

The audit queried **all 38 branch heads** of `https://github.com/jianfengliao774-sketch/pinkuang.git`, fetched them into the isolated `refs/remotes/github-version-audit-20261001-a4f9/` namespace, and compared ancestry, divergent commits, changed files, and relevant behavior. No checkout was changed, and no remote deployment or transaction was performed.

The latest business UI branch at audit time was **`codex/operator-review-requests`**, `29cf0d7017c852602ba84a903cc45227b1f81461`, committed **2026-10-01 08:18:14 +08:00**. This is the user-maintained business baseline. `main` still points to the initial repository commit and is not a suitable release baseline.

The performance branch `codex/display-without-rechecks-20261001` at `ee96586571e8b40e048ba21ce0763d5a97209d38` contains that baseline and exactly these three subsequent commits:

| Commit | Time (+08:00) | Increment |
| --- | --- | --- |
| `f7d57b87dad2342727ea88a6b24f44dd709d1727` | 09:24:35 | Cached display API and push updates; remove repeated frontend proof rounds |
| `38b09b3a818bb9be096b7ba606066ee0e6fd2cf4` | 09:28:14 | Restore the project summary together with cached detail |
| `ee96586571e8b40e048ba21ce0763d5a97209d38` | 10:30:16 | Reuse business display caches across BEMine pages |

The audit found no newer, unintegrated business UI branch. Commit ancestry alone was not used as evidence that the UI behavior survived: the files and regression checks below were also compared. Later commits must repeat this check against the selected branch's actual GitHub head.

## Preserved user optimizations

| Existing behavior in `29cf0d7` | File-level evidence in `ee965865` |
| --- | --- |
| Public records and confirmed rewards paginate five at a time | `web/components/LivePlatform.jsx` retains `recordsPageSize = 5`, both `records` and `rewards` in the slicing and pagination controls, and defers background refresh while viewing later pages. |
| Current BEM quote shows two decimal places | `web/components/BemPriceStat.jsx` is byte-for-byte unchanged; it renders `quote.priceUsdt.toFixed(2)`. Monetary balances continue to use the five-place amount helper. |
| Daily-capacity price uses the specific miner's asking price | `web/lib/share-daily-capacity.mjs` retains `minerDailyCapacityPriceWei`, `minerAskPriceWei`, and `poolDailyCapacityPriceWei`. NFT, owner, chain, ask-side and expiry filters remain. The new display path calls the same ask parser rather than substituting a class reference or funding reserve. |
| Wallet transport interruptions recover without losing an unchanged authorized identity | `web/lib/wallet-session.mjs` is byte-for-byte unchanged. `LivePlatform.jsx` still uses `startWalletSession` and its checking, recovered and disconnected callbacks. |
| Exact five-place money display and precise subscription input | `web/lib/amount-display.mjs` and `web/lib/funding-amount.mjs` are byte-for-byte unchanged. Presentation rounding does not change transaction atoms. |
| Combined assets avoid counting a portfolio and its children twice | `web/lib/asset-overview.mjs` is byte-for-byte unchanged; the portfolio display cache additions preserve account-specific rows and exact amounts. |
| Persisted pool details retain named RPC tuple fields | `web/lib/display-snapshot.mjs` retains `POOL_PARAM_FIELDS`, `poolDisplayItem`, and `Object.fromEntries` mapping named values or tuple indices. Its additional change accepts explicit display-only server metadata; it does not remove tuple reconstruction. |
| Independent wallet submission reads overlap without transaction simulation | `web/lib/live-transactions.mjs` retains the initial `settleReadRound` for session, pending journal, nonce, Gas price and balance. `web/lib/read-retry.mjs` is byte-for-byte unchanged. Direct mode removes redundant attestation reads; it does not restore a simulation or gas-estimation round. |
| Member wallet operations are independent of backend worker readiness | Frontend and shared `fresh-wallet-actions.mjs`, `web/lib/fresh-boot-recovery.mjs`, `web/lib/live-config.mjs`, and `deploy/scripts/mining-supervisor.mjs` are byte-for-byte unchanged. Existing operation classification remains; explicit direct mode is handled separately. |
| One-click platform fee collection and independent receipt history | `web/components/FeeCollectionHistory.jsx` is byte-for-byte unchanged and remains mounted by `FeeCollection.jsx`. The fee reader adds bounded display caching. `fee-collection-history.mjs` adds a direct display-log branch while retaining event decoding, separate BNB/BEM amounts, pagination and transaction links. |
| Readiness recovery is separate from immutable deployment-stage identity | `live-transactions.mjs` retains the mutable-worker-readiness separation introduced by `b21869d`; config and boot recovery helpers remain unchanged. The newly authorized direct path bypasses old proof gates without claiming a new verified runtime proof. |
| Automatic loading of additional record pages | `web/components/AutoPageLoader.jsx` is byte-for-byte unchanged. |

**193 regression tests passed, with 0 failures or skips**, using Node's test runner against these files:

```text
web/scripts/wallet-session.test.mjs
web/scripts/amount-display.test.mjs
web/scripts/asset-overview.test.mjs
web/scripts/funding-amount.test.mjs
web/scripts/share-daily-capacity.test.mjs
web/scripts/display-snapshot.test.mjs
web/scripts/fresh-wallet-actions.test.mjs
web/scripts/fee-collection-history.test.mjs
web/scripts/fee-collection-history-ui.test.mjs
web/scripts/portfolio-display-cache.test.mjs
web/scripts/operator-quotes.test.mjs
web/scripts/direct-product-transactions.test.mjs
web/scripts/live-transactions.test.mjs
web/scripts/fresh-boot-recovery.test.mjs
```

This audit verifies source preservation and focused regressions. It does not replace release CI, browser acceptance, or verification of the actually served release.

## Other branch candidates

| Branch head | Commit time (+08:00) | Relationship and treatment |
| --- | --- | --- |
| `codex/operator-review-requests` · `29cf0d7` | 10/01 08:18 | Latest business baseline; ancestor of `ee965865` |
| `codex/v4-product-launch` · `0d99fd9` | 09/30 19:31 | Wallet, cache, unified assets and pagination release; ancestor of the business baseline |
| `codex/atomic-refunds-20260930` · `1f187ee` | 09/30 18:56 | One genuinely unintegrated, **undeployed contract-upgrade candidate**; no UI changes |
| `codex/v4-stage2-wallet-recovery` · `bf97d4c` | 09/30 09:36 | Ancestor; second-stage block-read fixes retained |
| `codex/independent-fresh-deploy` · `5a765de` | 09/30 07:19 | Ancestor; earlier fresh deployment behavior |
| `codex/v2-genesis-compat-r3` and `codex/v2-index-503-r3` · `8f75efb` | 09/29 20:11 | Divergent old-v2 compatibility work; excluded from the independent v4 product |
| `codex/operator-preview-hotfix` · `738840f` | 09/28 17:45 | Divergent commit ID but patch-equivalent change is already integrated (`git cherry` reports `-`) |
| `codex/formal-market-test` · `c2ab168` | 09/27 21:31 | Older isolated read-only test-page history; current code already has the market board and later miner-specific asking-price fix |

Of the 38 branch heads, 33 are ancestors of or equal to `ee965865`; the five non-ancestor heads are precisely the atomic candidate, the two identical old-v2 heads, the patch-equivalent operator hotfix, and the isolated older market-test head.

### Atomic refund candidate isolation

`1f187ee` changes eight Solidity/test/document files and no frontend files. `docs/atomic-refund-candidate-20260930.md` explicitly records **not deployed, no mainnet upgrade scheduled, no transfer**, and separation from the current frontend release. It adds same-transaction withdrawal/refund entry points that existing deployed implementations do not acquire by updating the website.

Do not merge this candidate into the source used to create formal contract artifacts or advertise its ABI as a deployed capability. It requires its own reviewed upgrade, CI and deployment evidence before activation.

## Local mirror and release discipline

At audit time:

- Release checkout: `C:/Users/Administrator/AppData/Local/Temp/pinkuang-deploy-release-20260927`, branch `codex/display-without-rechecks-20261001`, HEAD `ee965865`; no tracked business modifications were pending.
- Its `origin` is the local mirror `C:/Users/Administrator/Documents/流片上链条/tapeout-pool`, not GitHub.
- The local mirror's checked-out branch remains `codex/t1e-voting-sale`, HEAD `7954c7750b80c206670b41b28cfac8b39c3b938e` from **2026-09-25**. Its worktree is clean, while its performance branch ref already points to `ee965865`.

**Never package the mirror's current working files simply because a newer branch ref exists there.** Before each release, query every relevant actual GitHub branch, record the chosen business head and subsequent reviewed changes, and build from that exact selected source commit.

Publication must consume the **exact source-bound CI artifact**: the expected commit SHA, build summary, bundle/content digest and manifest identity must agree. Preserve the exact deployed contract manifest bytes; a frontend release must not quietly alter contract addresses, capabilities or backend artifact identity. Confirm the served release marker and hashed chunks after an atomic publication, and retain the previous generation's chunks for already-open browser tabs.
