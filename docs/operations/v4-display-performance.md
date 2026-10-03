# BEMine display API and push updates

The formal v4 frontend previously repeated deployment, code, role, storage-slot and block proofs while browsing and before opening or submitting transactions. Route changes also restarted reads after showing a cached value. These waits prevented an already loaded project from being immediately usable.

The formal frontend now starts from its build-pinned public deployment manifest. Ordinary page reads and transaction preparation use the `displayOnly` path, which does not request deployment graphs, code, storage slots, historical receipts or canonical block proofs. The marker is a reading mode, not an on-chain authorization claim: proof flags remain false. Local exact amount/address/calldata parsing, wallet confirmation, journal duplicate-send handling and the result of an actually submitted transaction remain. Contract execution still enforces its business rules. No contract or fee rules change.

## Reading and refreshing

- The existing server pool cache serves pools, positions, orders and statistics. The new portfolio cache serves `GET /v1/display/portfolios` and `GET /v1/display/portfolios/:address`. API responses carry `{source,data}` and exact bigint amounts encoded as `$bemineBigInt`.
- Portfolio pages are bounded to 20 rows. Public fields are shared between accounts; member fields and page keys include the account. Reads are single-flight, limited to eight simultaneous getters, and retained during background refresh. The public directory is warmed every 15 seconds. Recently viewed account pages are refreshed in the same worker.
- Portfolio cache values survive index restarts in `portfolio-display-cache.json` next to the existing independent index database. The cache has bounded entries and expiry; a malformed or missing snapshot is rebuilt.
- `GET /v1/display/events` is an SSE stream. It sends a small `update` event with a revision and affected topics. A revision changes when local indexed business records change, rather than on every block. The worker updates display caches before publishing. Heartbeats and reconnection keep the stream alive; slow connections and connection counts are bounded.
- The frontend coalesces invalidations, pauses while a transaction/preview is open, and refreshes after those operations finish. It keeps the existing polling fallback. The push contains no signing requests or private account data.
- Memory caches are reusable for 120 seconds across routes and detail expansion. A manual refresh, confirmed transaction or new SSE revision invalidates that reuse. Deployment and account remain part of cache identity. A cache miss may read required business getters if the display API is unavailable, without restoring the removed proof rounds.
- Cached values in the direct reading mode keep normal balance, amount and action captions. The UI does not label those values as awaiting a verification round, and the listed-miner purchase preview does not depend on a historical-proof marker.
- The cache covers the home/catalog, assets/rewards, single and portfolio details, project history, governance, market quotes, operator quotes, fee collection and sale-review pages. Assets and rewards share the same account-scoped portfolio directory. History loads yield and activity together; its seven-day and thirty-day windows are cached separately. Portfolio row caches include the push revision so a detail opened after an update cannot revive an earlier revision.
- Governance and administrative pages still read the business fields needed to present proposals, orders and balances on a cache miss. Those reads share pending requests and reuse completed results for 120 seconds. Governance candidates use four workers and preserve order; a failure drains outstanding reads and does not publish partial results. Signing, nonce and transaction-journal state are not stored in the display cache.

The reverse proxy must route the display prefix directly to the loopback index. The transaction journal's JSON proxy cannot stream SSE. The SSE location needs buffering disabled, gzip disabled and an idle timeout longer than its 20-second heartbeat; the journal and signer routes retain their current configuration.

## Measurements and validation

The read-only browser comparison on 2026-10-01 observed Firsto using its own HTTP APIs and an SSE stream, with zero browser JSON-RPC calls. BEMine's previous page emitted 60 browser JSON-RPC requests: 42 calls, five code reads, three storage reads, four chain-ID reads and six block reads. This identifies request amplification; it does not establish how Firsto's private backend is implemented.

The same production JS/CSS set was measured before and after Nginx compression: 1,848,575 decoded bytes and 524,519 transferred bytes, a 71.6% reduction. Hashed static chunks now use immutable caching; HTML revalidates. These values describe that measured release and are not a latency guarantee for all clients.

Regression coverage includes zero-proof RPC paths, exact transaction construction, account-scoped cached portfolio decoding, cache single-flight/expiry, SSE coalescing/backpressure/connection shutdown, existing fee/review actions, and retained display behavior. Windows cannot exercise POSIX 0700 directory checks; those existing tests require the Linux CI run.

Before this update, the remote repository was fetched and compared against the deployed business branch `codex/operator-review-requests` at `29cf0d7017c852602ba84a903cc45227b1f81461`. The performance branch contains that business history; remote `main` is an earlier ancestor, not a newer application release. Release archives are built in Linux CI and their source head and attestation are checked before publication.

Official implementation references: [Next.js fetching](https://nextjs.org/docs/app/getting-started/fetching-data), [Viem multicall](https://viem.sh/docs/contract/multicall), [NodeReal rate limits](https://docs.nodereal.io/docs/cups-rate-limit), [Nginx gzip](https://nginx.org/en/docs/http/ngx_http_gzip_module.html). A faster node may help upstream latency, but shared API caching and fewer repeated requests address the observed amplification first.
