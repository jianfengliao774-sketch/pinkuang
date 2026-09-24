# Local RPC retry fault injection

This is a synthetic JSON-RPC server on 127.0.0.1, not BSC execution or mainnet state evidence. The final fixture returns dedicated non-production chainId 13371337 and explicitly passes --no-storage-caching, providing two layers of isolation. No key, credentials, real RPC endpoint or transaction broadcast was used. The test has the reviewed block number solely to exercise the same Forge argument; its block and account responses are fabricated fixtures.

Forge 1.7.1 runs one pure smoke test with no-storage-caching, threads=1, compute-units-per-second=50, fork-retries=10 and fork-retry-backoff=2000. The latter is milliseconds, not seconds or an exponential factor. Foundry passes it into Alloy 2.0.1; provider backoff hints and the compute-budget offset can increase an individual wait. The limit is per request, not per entire Forge invocation.

- recover: only the first request receives HTTP 429. Forge retries it after 2,000+ ms, the smoke test passes, exit 0.
- exhaust: every response is HTTP 429. Completed failing requests reach 11 attempts (initial plus 10 retries); other concurrently pending requests stop when Forge exits 1. There are 47 HTTP requests in total across provider initialization and fork setup, so this is not an 11-request global cap.
- not-retryable: JSON-RPC -32602 invalid params. Each request is made once, exit 1.

`results.json` preserves argument lists, timestamps, request IDs/bodies, per-request counts and process exits. The three case logs preserve Forge stdout/stderr. `probe-output.log` is the script output. `toolchain.log` records the actual executable version. To repeat, copy `retry-probe.mjs` to a fresh ASCII temporary directory and run `node retry-probe.mjs /absolute/path/to/forge`; it generates its own fixture source/config there. These tests do not establish remote GitHub workflow-schema acceptance; the next actual PR check must verify that.

Primary sources checked:

- Foundry CLI forwarding: https://github.com/foundry-rs/foundry/blob/4072e48705af9d93e3c0f6e29e93b5e9a40caed8/crates/evm/core/src/opts.rs
- Foundry provider layer: https://github.com/foundry-rs/foundry/blob/4072e48705af9d93e3c0f6e29e93b5e9a40caed8/crates/common/src/provider/mod.rs
- Alloy 2.0.1 retry limit, milliseconds and wait calculation: https://github.com/alloy-rs/alloy/blob/v2.0.1/crates/transport/src/layers/retry.rs
- GitHub job concurrency: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idconcurrency

GitHub's `queue: max` keeps up to 100 pending jobs in a concurrency group; its default `single` mode replaces the pending job. `queue: max` cannot be combined with `cancel-in-progress: true`. The workflow uses the max queue only for the shared RPC job, with cancel-in-progress:false. Per-event/per-ref workflow cancellation still discards obsolete heads; all PRs and main pushes retain checks, while feature push duplication is removed.
## Superseded exploratory run and cache isolation

The first exploratory fixture used chainId 56 without disabling RPC storage caching. It could have written fabricated smoke-account data to the shared BSC block cache. Its logs/script/results are retained under `prior-cache-enabled/` only for diagnosis; do not rerun that archived script or use it as final acceptance evidence. The first contemporaneous local real-fork result is also superseded, pending a clean-cache rerun.

At 2026-09-24T14:27:25.3062795Z the single cache file `C:\Users\Administrator\.foundry\cache\rpc\bsc\123728000` (83,970 bytes) was moved, without recursion, to the same directory as `123728000.synthetic-quarantine-e5d135576a2444609efd7ed08a980760`. The source path was verified absent and the preserved copy retained SHA256 `701dda239b5865c2dc8a09739feb8164da5ba692683c7c5a2d4a79c9e6bd7e65`. `cache-quarantine.json` records paths, timestamps, size, hash and the seven potentially affected synthetic account addresses. Subsequent real-fork acceptance must use fresh RPC cache data; the final fault injection here uses chainId 13371337 with caching disabled.
