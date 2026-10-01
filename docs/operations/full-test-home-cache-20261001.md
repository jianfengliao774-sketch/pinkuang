# Independent test homepage data repair — 2026-10-01

The prior full-test frontend was built at fee92d34c454. Partner UI branch
codex/ui-capacity-review had an additional commit ade49ea9f46fd1dff94eb4379698bdb2dae46bad.
Release 50b14f4bcd6ba3758fa70d9bfb12ff8f1e325118 merges that branch while retaining
later user-requested simplifications, current contract governance, five-row
pagination, and a two-decimal coin price without an approximation prefix.
Conflicting older UI behavior was not restored.

The independent Factory and Authority graph remains unchanged. The newly
activated Factory currently contains zero projects; old production pools,
orders and balances are intentionally not imported. Missing display data must
remain unavailable rather than being invented as zero.

## Findings and changes

- Public index /v1/display/stats was healthy and materialized empty-graph totals
  as exact zero strings. Initial configuration/read failures could leave the
  homepage without a client until manual reload. Configuration bootstrap now
  retries automatically and restores a previously validated, origin/build
  scoped public display config for up to 30 minutes while fetching live data.
  Restored configuration always disables transaction/automation readiness.
  Existing page/statistics caches can then paint without waiting on RPC reads.
- Every static test export included an unavailable coin-price placeholder.
  The live nginx exact URL now serves the existing public PancakeSwap V3 quote
  cache. This is token market data, independent of every project graph.
  web/ops/bemine-price.md documents that read-only worker and quote identity.
  Offline exports continue to show unavailable until connected to a real feed.
- The separately managed test index used the formal proxy's default port 4187
  for per-miner output quotes. Its installed module and future runtime builds
  now use the isolated proxy on 4207. No formal service configuration changed.

## Published and checked

- Static release: /var/www/bemine-full-test/releases/home-cache-50b14f4bcd6b
- Public source metadata: https://tapeout.cc.cd/bemine-full-test/full-test-site.json
  sourceBound=true, sourceHead=50b14f4bcd6ba3758fa70d9bfb12ff8f1e325118.
- Runtime artifact remains
  0x3d386ce28a1898546697d1ee715b5276104894f781e68b785306eac9cde5338b.
  Both source inventories agree and all 67 installed module hashes match;
  runtimePatchSourceHead points to this release's source commit.
- 81 targeted tests pass, covering live display data, exact amount formatting,
  config cache expiry/origin/build mismatch, cache retirement, and the isolated
  miner quote proxy. Next/Vite builds and deployment TypeScript checks pass.
- Nginx configuration validates; test API/index/purchase/mining and public price
  service were active at verification. No transaction was simulated or sent.
- Public stats and coin-price endpoints returned HTTP 200 in approximately
  0.70 and 0.81 seconds respectively from this client's one-shot checks. These
  are sample request timings, not a latency guarantee.
- Browser reload shows 0 projects, 0 participants, 0 miners, 0.00000 BEM and a
  live two-decimal USDT quote. The quote timestamp advanced during browser
  verification. Screenshot: /private/tmp/bemine-home-data-fixed.png.

Public homepage data verification does not certify privileged automation
readiness or any complete purchase/sale workflow; those remain separate tests.
