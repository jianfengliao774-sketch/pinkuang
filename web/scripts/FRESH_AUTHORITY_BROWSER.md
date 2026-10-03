# Fresh-v4 product transaction regression

This is a local-only full-page regression. It loads the normal `loadFreshLiveConfig` path, the build-pinned synthetic manifest, HTTP product-graph responses, current graph reads, the ordinary UI, and the wallet/Authority submission code. RPC and journal responses are fixtures. The two private keys in the fixture are public test keys; no external RPC, real wallet, funds or mainnet transaction is used.

From `web/`, build with these environment variables:

```powershell
$env:NEXT_PUBLIC_BASE_PATH='/bemine-v4'
$env:NEXT_PUBLIC_BEMINE_PRODUCT_FAMILY='fresh-v4'
$env:NEXT_PUBLIC_V4_MANIFEST_SHA256='0x5fa15079ede0f6a5e868b16b2a7404dccaa2391862104a770acfd94165b40a4d'
$env:NEXT_PUBLIC_DEPLOY_CONSOLE_URL='https://tapeout.cc.cd/pinkuang-deploy-v4/'
node node_modules/next/dist/bin/next build --webpack
```

Serve `web/out` on localhost, stripping the `/bemine-v4` prefix before resolving files. A threaded static server should use an adequate request queue and silent/access-file logs. Alternatively run `next dev --webpack` with the same environment. Then:

```powershell
$env:BEMINE_TEST_URL='http://127.0.0.1:3214/bemine-v4'
$env:BEMINE_TEST_BROWSER='chrome'
# Optional: file URL of an existing Playwright installation.
# $env:BEMINE_PLAYWRIGHT_MODULE='file:///.../playwright/index.mjs'
$env:BEMINE_BROWSER_OUTPUT='C:/.../fresh-authority-browser-results'
node scripts/fresh-authority-browser-check.mjs
```

The seven assertions cover discovery from the actual fresh loader; one exact creation signature; reload and finalized recovery without re-signing; a separate exact-cost purchase signature; removing administrator UI after switching to an ordinary account; an ordinary holder's populated listing preview; and a direct user-wallet withdrawal with platform services offline. The last case reloads from an HTTP graph with `operationalReady=false`, `transactionReady=false`, `userExitReady=true`; it does not inject a ready configuration into the component. Listing stays disabled, and the withdrawal pays Gas through the user wallet without another Authority call.

The browser fixture models journal CAS and receipts but is not a replacement for the Linux durable-journal, Authority IPC or deployed keeper tests. It exercises the official procurement route; exact Firsto source/order/receipt binding has separate unit tests. Arbitrary cancellation or unrelated replacement hashes do not unlock an Authority queue retry. `setDepositPaused` remains unavailable in fresh mode until an explicit backend action is implemented. Automatic independent-pool purchasing and mining remain keeper operations; only exact reclaim is available as a reviewed administrator relay action.

Targeted unit command (repository root):

```text
node --test --test-skip-pattern="server queue survives" web/scripts/budget-purchase-plan.test.mjs web/scripts/authority-client.test.mjs web/scripts/authority-queue-recovery.test.mjs web/scripts/fresh-product-config.test.mjs web/scripts/fresh-user-exits.test.mjs web/scripts/live-transactions.test.mjs web/scripts/live-portfolios.test.mjs web/scripts/live-view.test.mjs web/scripts/live-config.test.mjs
```

On 2026-09-30: 125 targeted tests passed; catalog, BEM price and review-policy checks passed; contract ABI check matched `0x6007118ac4568be4743a99b44b5259518fcf5a73e091469bfdc4d05a7dc4dd75`; fresh-v4 production compilation generated all 23 pages; the seven browser assertions passed against the resulting static export. The named durable-journal test was excluded on Windows because its POSIX permission requirement is covered by the separate Linux backend run. This does not claim full `pnpm check`, real-wallet latency or mainnet transaction acceptance. These fixture build files must never be packaged as the public production release; the reviewed clean-clone release builder supplies the actual signed-off manifest and origin.
