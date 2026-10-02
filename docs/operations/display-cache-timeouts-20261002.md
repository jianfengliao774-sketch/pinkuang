# Display cache timeout repair — test and formal

The homepage cache/config requests used a 2.5 second deadline. A slow connection
became `network_unavailable` immediately, and simultaneous catalog/stat failures
rendered the same alert twice. Budget display failure could also fall through to
more expensive per-contract reads.

Public cache GETs now allow 10 seconds, retry a dropped connection once after
500 ms, and retain existing page snapshots during revalidation. Identity/JSON
failures are not retried by this transport. Display-only clients do not fall
through to raw chain/index readers on cache failure. Identical homepage alerts
render once. Wallet and transaction transports are unchanged.

User subsequently authorized the same confirmed bug to be fixed in formal.
The branches remain separate; no merge to main and no test graph import into
formal. Only static pages were switched. No contracts, signer credentials,
runtime modules, worker services or chain transactions were changed.

| Scope | Branch | Built source | Static release |
| --- | --- | --- | --- |
| Test | codex/full-test-gas-repair-20261001 | 4c2251f1a0476fb7012a2de95c980ae84588626f | /var/www/bemine-full-test/releases/cache-timeout-4c2251f |
| Formal | codex/formal-miner-lookup-20261002 | 163a33512de83be44f91e46508b4c19c353ccbbf | /var/www/bemine-v4/releases/cache-timeout-163a335 |

Validation: test 108 passing tests, formal 101. A real 2.7 second delayed response
passes the new transport; persistent disconnect stops after two requests;
cache failures issue zero RPC calls or legacy-index fallback requests.
Both Next exports built successfully; test console TypeScript/Vite passed.

Live read-only verification used each branch's actual data-client modules and
its own ABI/artifact pin against the public HTTPS cache endpoints. Test config,
pools and statistics returned HTTP 200 in 482/751/752 ms; formal pools/statistics
in 803/453 ms. Zero browser-display RPC calls in both runs. Test graph reports
0 registered projects; formal reports 1. These timings are samples, not a SLA.

Publication compared contract digests, formal manifest/roles/deployment and test
console artifacts against each previous release before atomically switching its
own current symlink. Old hashed chunks were copied only when absent to support
already-open pages. Previous releases remain available for rollback. The built
candidate metadata describes the original build; compatibility-only old assets
are additional files. Formal canonical public origin remains bemine.cc.cd.

This verification does not claim a live wallet transaction or a new full browser
UI test. Public HTML and referenced assets are checked against the exact build.
