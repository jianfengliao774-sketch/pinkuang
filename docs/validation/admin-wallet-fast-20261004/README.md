# Administrator confirmation opens the wallet immediately

Based on the exact formal frontend `af164a6ad76427e53a4bb1a6e1e907f96dae998a`, recovered from its verified production source bundle. The prior production release remains the rollback target. Public canonical links already published as HTML overlays are included in source.

Single-miner creation/reclaim and budget-project creation prepare a single-use opaque signing token during preview. Explicit confirmation consumes that token and immediately invokes `eth_signTypedData_v4`, with no second read RPC, simulation, product-graph fetch or session preflight. Authentication and submission occur only after the signature. The independent Gas relay, exact request ID/accepted/hash checks, nonce verification, durable publication journal and on-chain constraints remain intact.

The token binds the original provider, administrator, complete deployment configuration, exact business calldata and page epoch. Its default lifetime is five minutes, bounded by the signed deadline. Rejection or an unknown wallet result consumes it; there is no automatic nonce refresh, re-sign or relay retry. Cancelling or changing context invalidates the preview. Normal completion of bounded read cleanup must not invalidate it.

Validation: 66 authority/submission/admin/portfolio/dialog/create-input regressions and 35 actual administrator handler/public-link/publication/result tests passed (101 total, no skips). Fifteen new handler tests execute the actual three components' preparation and submission handlers with real preparation and signing modules; the exact confirmation call order is wallet signature, authentication, relay. No real wallet signature or chain transaction was performed.

Publication evidence and a screenshot are recorded separately after verification. Backend/contract/upgrade-console files are not part of this frontend release.
