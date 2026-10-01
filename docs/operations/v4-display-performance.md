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

The reverse proxy must route the display prefix directly to the loopback index. The transaction journal's JSON proxy cannot stream SSE. The SSE location needs buffering disabled, gzip disabled and an idle timeout longer than its 20-second heartbeat; the journal and signer routes retain their current configuration.

## Measurements and validation

The read-only browser comparison on 2026-10-01 observed Firsto using its own HTTP APIs and an SSE stream, with zero browser JSON-RPC calls. BEMine's previous page emitted 60 browser JSON-RPC requests: 42 calls, five code reads, three storage reads, four chain-ID reads and six block reads. This identifies request amplification; it does not establish how Firsto's private backend is implemented.

The same production JS/CSS set was measured before and after Nginx compression: 1,848,575 decoded bytes and 524,519 transferred bytes, a 71.6% reduction. Hashed static chunks now use immutable caching; HTML revalidates. These values describe that measured release and are not a latency guarantee for all clients.

Regression coverage includes zero-proof RPC paths, exact transaction construction, account-scoped cached portfolio decoding, cache single-flight/expiry, SSE coalescing/backpressure/connection shutdown, existing fee/review actions, and retained display behavior. Windows cannot exercise POSIX 0700 directory checks; those existing tests require the Linux CI run.

Official implementation references: [Next.js fetching](https://nextjs.org/docs/app/getting-started/fetching-data), [Viem multicall](https://viem.sh/docs/contract/multicall), [NodeReal rate limits](https://docs.nodereal.io/docs/cups-rate-limit), [Nginx gzip](https://nginx.org/en/docs/http/ngx_http_gzip_module.html). A faster node may help upstream latency, but shared API caching and fewer repeated requests address the observed amplification first.
