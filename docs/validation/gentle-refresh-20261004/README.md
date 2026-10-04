# Gentle formal display refresh — 2026-10-04

Source baseline: `38aa441c8a85579b14fc86d955aedf994db186f4`, restored from the exact deployed `catalog-detail-38aa441c8a85` source bundle. This change does not replace the deployed contract graph, administrator flow or catalog-detail fixes.

Formal browser cache reads and the visible price card use a 30-second interval. Timer/focus and index SSE share the same page/account budget. Hidden pages stop polling, concurrent reads defer refresh, and unsuccessful page reads retain the existing 120-second backoff. The backend price worker remains at 15 seconds; only browser reads use the new price display constant.

A same-identity automatic read preserves displayed data, detail mounting, form inputs, selections and previews. Independent read tickets prevent another timer, SSE or manual read from overlapping a slow GET, without marking ordinary controls as globally loading. Actual client, wallet account and route changes still retire old action/member work. Actual source reorgs still invalidate old data and action readiness.

Expanded catalog/positions/orders and multi-miner windows retain their cursor and source during automatic ticks, rather than replacing their extra pages with a fresh first page. Later records pages are also deferred. Explicit manual refresh and confirmed-transaction generations still refresh immediately. A normal first page of 100 children continues refreshing; only a window explicitly expanded by the user is deferred. Capacity details retain a stable component identity while actual child/state changes invalidate an old quote without automatically invoking a paid quote API.

Validation:

- The complete frontend/API fixture suite passed: `node --test scripts/*.test.mjs server/live-api.test.mjs` — **1205 passed, 0 failed**.
- Actual-handler and fake-clock tests cover shared timer/SSE/manual budgets, hidden pages, slow reads, timeout retention, cached detail mounting, real identity changes, old-page cursor preservation, later-record pages, expanded child selection and post-transaction updates. Original administrator wallet/signature and governance permission tests continue passing.
- Catalog, price validation, public review policy and contract ABI checks passed. `git diff --check` passed.

Tests use local fixtures and do not submit real wallet transactions or call paid production nodes. Production publication and public-browser verification are separate steps handled by the parent release task.
