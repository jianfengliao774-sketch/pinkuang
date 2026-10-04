# Gentle formal display refresh — 2026-10-04

Source baseline: `38aa441c8a85579b14fc86d955aedf994db186f4`, restored from the exact deployed `catalog-detail-38aa441c8a85` source bundle. This change does not replace the deployed contract graph, administrator flow or catalog-detail fixes.

Formal browser cache reads and the visible price card use a 30-second interval. Timer/focus and index SSE share the same page/account budget. Hidden pages stop polling, concurrent reads defer refresh, and unsuccessful page reads retain the existing 120-second backoff. The backend price worker remains at 15 seconds; only browser reads use the new price display constant.

A same-identity automatic read preserves displayed data, detail mounting, form inputs, selections and previews. Independent read tickets prevent another timer, SSE or manual read from overlapping a slow GET, without marking ordinary controls as globally loading. Actual client, wallet account and route changes still retire old action/member work. Actual source reorgs still invalidate old data and action readiness.

Expanded catalog/positions/orders and multi-miner windows retain their cursor and source during automatic ticks, rather than replacing their extra pages with a fresh first page. Later records pages are also deferred. Explicit manual refresh and confirmed-transaction generations still refresh immediately. A normal first page of 100 children continues refreshing; only a window explicitly expanded by the user is deferred. Capacity details retain a stable component identity while actual child/state changes invalidate an old quote without automatically invoking a paid quote API.

Validation:

- The complete frontend/API fixture suite passed: `node --test scripts/*.test.mjs server/live-api.test.mjs` — **1205 passed, 0 failed**.
- Actual-handler and fake-clock tests cover shared timer/SSE/manual budgets, hidden pages, slow reads, timeout retention, cached detail mounting, real identity changes, old-page cursor preservation, later-record pages, expanded child selection and post-transaction updates. Original administrator wallet/signature and governance permission tests continue passing.
- Catalog, price validation, public review policy and contract ABI checks passed. `git diff --check` passed.

Tests use local fixtures and do not submit real wallet transactions or call paid production nodes.

## Publication and browser audit

The parent release task published the frozen runtime source `b61a835a50ba876ddcd3f046ad2160d3041ec266` at **2026-10-04 16:20:41 CST**. The current static release is `gentle-refresh-b61a835a50ba`; the exact prior release was `catalog-detail-38aa441c8a85`. The atomic publication retained 543 previous immutable chunks. Runtime services, nginx, backend files and the contract upgrade console remained unchanged. Publication inventory and seven HTTP checks (all 200) are recorded in [publication.json](./publication.json). Later documentation-only commits do not change the running frontend source.

The parent task then checked the public formal `#pools` route in the browser. With the search field set to `16735`, a **62.858-second** observation preserved its value, focus and `scrollY=99`, while the displayed index block advanced **125643614 → 125643749**. Explicit manual refresh advanced to **125645181** successfully; the test search was cleared afterward. These observations are recorded separately in [browser-validation.json](./browser-validation.json). No wallet transaction was submitted during validation.

This browser check proves real data advancement without disturbing the tested search and scroll position. The broader selection, pagination, wallet identity and transaction-generation cases are covered by the fixture tests described above.
