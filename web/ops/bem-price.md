# BEM reference price service

The homepage is a static export. Browser polling alone is not backend refresh. Deploy this separate Node 18+ read-only worker to refresh a shared JSON file every 15 seconds; no wallet, API key or chain transaction is required. The output is an indicative spot reference, not an executable trade quote.

## Verified identity and sources (2026-09-26)

- Official https://tapeout.net/ currently loads `/assets/index-CMTeTi9V.js`; mainnet config `token` is `0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a`.
- Single market source: PancakeSwap V3. Its official BSC factory is `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865`, verified against https://developer.pancakeswap.finance/contracts/v3/addresses . The RPC transport is not an additional price source.
- BEM/WBNB pool: `0x28B12792F9D81Bd529Bc5572434E861C9EDbBBC2`; token0 BEM (8 decimals), token1 WBNB (18 decimals), fee 10000.
- USDT/WBNB pool: `0x172fcD41E0913e95784454622d1c3724f546f849`; token0 USDT (`0x55d398326f99059ff775485246999027b3197955`, 18 decimals), token1 WBNB (18 decimals), fee 100. This is BSC USDT, not USD.
- Each refresh verifies chain 56, both pool token identities, decimals, expected fee, positive liquidity, factory address and the factory's `getPool` registration. Both prices are read at the same explicit recent block. The USDT/WBNB pool ratio must be inverted to obtain USDT per WBNB.
- Formula: `BEMUSDT = (BEM sqrtPriceX96 / 2^96)^2 × 10^(8−18) ÷ (USDT/WBNB sqrtPriceX96 / 2^96)^2`. No centralized-exchange quote is used.
- The public payload keeps the primary BEM pool link, `source: "PancakeSwap V3"`, and `conversionPoolAddress` for the second pool. The UI validates both pool addresses and the source; users see one source link while the conversion route stays auditable in the JSON.
- Read-only verification and worker smoke test succeeded at block 124060707 on 2026-09-26 02:27:05 UTC: BEM reference price 53.107248 USDT. This is a recorded sample, not a fixed/current price.
- More than 60 seconds old, unknown identity, zero liquidity or upstream failure means unavailable. The worker writes null price on failure; the UI also independently rejects stale/malformed data. Never substitute demo price or zero.

## Deployment

1. Install `scripts/update-bem-price.mjs` and `lib/bem-price.mjs` under `/opt/bemine-price/`, preserving relative directories. Check `/usr/bin/node` is Node 18 or newer (or update unit ExecStart to actual binary).
2. Create `/var/www/bemine-preview/data` owned by `www-data`, not inside a release. Run worker once with `--once --output /var/www/bemine-preview/data/bem-price.json` to verify upstream accessibility on the server.
3. Preserve a `data` symlink in every static release: `data -> /var/www/bemine-preview/data`. This exposes `/bemine/data/bem-price.json` without changing existing nginx routing. Keep JSON responses uncached (existing `/bemine/` no-cache plus client `cache:no-store`).
4. Install `bemine-price.service`, reload systemd and enable/start the dedicated service. The worker starts a new attempt every 15 seconds, skips overlapping requests and uses seven-second individual timeouts.
5. Verify the public JSON has status ok and its updatedAt advances after 15 seconds; compare displayed quote to payload. Check unavailable state by serving a local unavailable/stale fixture (do not disrupt live upstream services).
6. For local static preview, run a single `--once` output to `web/out/data/bem-price.json`. Never commit/cache that live payload in public source. Local preview intentionally shows unavailable unless fed a current quote.

Deploy the worker and the UI together: the UI rejects previous payloads without the verified conversion pool and single-source fields. Historical review snapshots should remain frozen and should not receive live prices implicitly.
