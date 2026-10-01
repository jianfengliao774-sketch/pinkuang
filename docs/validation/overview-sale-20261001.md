# Overview mining totals and isolated sale validation

The implementation is based on `codex/automatic-proposal-reference-20261001`, commit `8762d0e68dafc534864bba8b68dd8e55f12100b4`, committed at 2026-10-01 14:46:00 +08:00. All remote branches were fetched before selecting it. It includes the earlier display optimizations, direct member wallet operations, compact purchase confirmation, quiet finality/success handling, and automatic proposal references. Production was already serving this same source when work started.

The overview previously hard-coded both current managed miner count and daily output to null. Managed miners now come from the existing public pool cache: acquired Active/Listed standalone and portfolio child NFTs, deduplicated by collection/token ID. Funding targets and disposed miners do not contribute. Estimated output is the gross whole-miner BEM estimate from the existing local Firsto display proxy, not a member's claimable rewards. BEM uses eight atomic decimals and displays five decimal places.

Public requests read materialized server data. Quote collection runs in the background, shares cached detail requests, and does not introduce browser RPC/proof rounds. Coverage metadata keeps partial data from masquerading as a complete total. Existing page caches and SSE invalidation also carry the refreshed overview values.

Sale timing is unchanged in the formal contract:

- A first whole-miner sale proposal requires activation plus seven days.
- Voting lasts 24 hours; execution can occur within that window once both member count and share count have a strict majority.
- Listing expiry is seven days after execution; a buyer can complete the sale at any time before expiry.
- An ask below the current market reference additionally requires platform approval.

The added fixed-block BSC fork cases exercise the seven-day boundary, signed Authority approval, rejection and signature/replay failures, three-member voting, real Firsto/NFT/mining settlement, and the original holders' BEM/BNB entitlements. They use isolated contracts and public fixture keys. They do not broadcast transactions, change formal contract parameters, or use production administrator keys. Contract implementation sources remain identical to the formal artifact source `23770972ce961f7da45848d4e5fddc0c4023bbfc`.

Exact-source CI and production acceptance results are recorded in the release evidence separately; the deployment manifest and contract artifacts stay pinned to the existing mainnet deployment.
