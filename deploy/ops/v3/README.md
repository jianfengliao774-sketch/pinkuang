# Parallel v3 fresh graph cutover draft

**Historical v3 plan, superseded by the independent v4 deployment.** The v3
genesis and first Authority transaction remain on-chain records. Do not resume
v3 activation or use the old-Factory pause/cross-check requirements below for
v4. See `../v4/README.md` for the current deployment handoff.

This directory prepares a separate `/pinkuang-deploy-v3/` console and `/bemine-v3/` product. The offline renderer does not deploy contracts, pause old factories, start services, change nginx, or replace `/bemine-v2/`. The deployment console may be served before genesis with an empty product Factory allowlist, no product record, no Gas credential, and `AUTHORITY_RELAY_ENABLED=0`; that does **not** activate the v3 product. The old v2 site must keep showing the existing pool, its two holders, the active share listing, and withdrawal/claim actions.

The offline renderer requires the completed 16-transaction fresh genesis record, its exact artifact bundle, the completed 7-transaction Authority activation evidence, the frontend genesis manifest, and the **full public** Gas-wallet address copied from the wallet. It refuses the truncated 39-hex address previously seen in a screenshot. It writes a new JSON draft with `activationAllowed:false` and independent v3 runtime/index service configurations.

Example input (paths and public RPC origins only; never put a private key here):

```json
{
  "recordPath": "/var/lib/pinkuang-deploy-v3/trusted-product-deployment.json",
  "bundlePath": "/srv/pinkuang-deploy-v3/releases/v3-reviewed-runtime/public/deployment-artifacts.json",
  "activationPath": "/etc/pinkuang-deploy-v3/fresh-activation.json",
  "manifestPath": "/var/www/bemine-v3/releases/v3-reviewed-product/public/bemine-v3/data/frontend-manifest.json",
  "expectedGasWallet": "<complete public wallet address>",
  "runtimeReleaseId": "v3-reviewed-runtime",
  "productReleaseId": "v3-reviewed-product",
  "keeperStateRoot": "/var/lib/pinkuang-v3/keeper-state",
  "rpcUrl": "https://bsc-dataseed.bnbchain.org",
  "logsRpcUrl": "https://bsc-dataseed.bnbchain.org"
}
```

```sh
node deploy/ops/v3/prepare-fresh-cutover.mjs reviewed-input.json v3-cutover-draft.json
node --test deploy/ops/v3/prepare-fresh-cutover.test.mjs
```

The renderer checks public evidence consistency only. Before enabling a v3 **product** service or route, independently verify finalized BSC receipts and code for all 23 transactions, the two old Factory proxy/implementation hashes, `creationPaused=true` on both old Factories, the old v2 `machinePool` getter, all new Factory/Authority/Timelock roles, the new index caught up to finalized blocks, and end-to-end admin signature plus Gas relay operations. The server product graph rechecks these chain facts; `fresh-wired` and missing proof remain dark, while `fresh-active` is the only browser-accepted operational stage. A v3 creation permit may coexist with the old v2 pool only when the new FreshPoolFactory cross-check is verified and old v2 creation is paused. No old Factory, pool, listing, or claim data is imported into the new index.

The pre-genesis console publication is a separate step. Commit reviewed source first, regenerate `public/deployment-artifacts.json` so its `sourceCommit` equals that commit, then run `npm run build:fresh`. The v3-only `scripts/package-fresh-console.mjs --out <new absolute directory>` refuses a stale source commit, uncommitted runtime code, incomplete import closure, unexpected build output, or a browser bundle with the wrong artifact digest. Its output contains exactly the fresh `dist`, 31 reviewed runtime modules, `package.json`/lockfile, the public artifact, and a per-file SHA256 manifest; it excludes the old upgrade entry, build tools, tests and private material. Archive only those output directory entries, then let `activate-console.remote.py --dry-run` verify the archive digest and the reviewed nginx/v2-unit hashes before installation. The installer exposes only `/pinkuang-deploy-v3/` and passes the Gas wallet's **public address** as configuration. It refuses an obsolete `/etc/pinkuang/keeper-v3.key` copy and verifies that the public process has no credential directory or private-key environment variable. It does not add `/bemine-v3/`, start the index, or enable any sender. The historic Stage 2 signing gate remains closed without a credential.

Even after the 16 genesis and 7 Authority transactions complete, `deploy/server/journal-api.mjs` intentionally reports `stage=fresh-wired`, `operationalReady=false`, and refuses fresh product signing intents. A **separate reviewed product activation release** is required: at a finalized block, prove all 23 receipts and exact code/roles, pin both previous Factories and their paused state, verify the v3 index and full admin EIP-712/relay/user purchase flows, drain/stop the old v2 Gas sender or establish one shared lock account, and verify old v2 claim/listing access. Only then may that release change the v3-only server product stage to `fresh-active` with `operationalReady=true` and open its transaction gate. The static v3 manifest, dynamic proof and browser digest must match the same fresh artifact. Until then, any `/bemine-v3/` static build remains unserved and the old v2 site remains the only live product.

The renderer's post-activation service drafts use separate `pinkuang-v3` OS identity, ports 4175/4182 and databases under `/var/lib/pinkuang-*-v3`. The public runtime never receives a Gas key, and the relay remains explicitly disabled. The purchase unit is an **uninstalled, disabled, read-only draft** with `FRESH_PURCHASE_ENABLED=0`, no `--send`, and no private credential. A future sender would require a separate reviewed design with a dedicated key, private signer identity, and nonce coordination; this historical draft cannot be enabled for signing by merely changing one flag. The activation evidence stays root-owned outside the release tree; the service can read it but cannot edit it. The nginx snippet is an **uninstalled draft**. Review actual paths, release file hashes, ownership, CSP and existing HTTPS server context, then test `nginx -t` before any cutover. Continue serving `/bemine-v2/` independently.
