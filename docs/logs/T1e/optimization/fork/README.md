# Superseded local fork run — diagnostic evidence only

This run actually reported 39 passing tests, but it overlapped an exploratory synthetic JSON-RPC test that used BSC's chain ID and the same block number without disabling Foundry's shared storage cache. The results are retained verbatim for diagnosis and are **not used for final acceptance**.

The affected single-block cache file was isolated with its hash preserved; see [the quarantine record](../rpc-retry/cache-quarantine.json). The final synthetic probe uses chainId 13371337 and `--no-storage-caching`.

The authoritative local rerun is [fork-clean-cache](../fork-clean-cache/summary.json), with its own complete logs and input manifests. See [the optimization report](../../../../M1e-optimization.md) for its outcome and the independent fresh-runner GitHub check.
