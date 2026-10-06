# Passed sale proposal blocked by an absent reference — 2026-10-02

At block 125205516, test pool
`0x0d776F099Fe694E07A7509334067b1f92F68Cd0E` was still Mining (state 2).
Proposal #1 at 0.04000 BNB had passed with 100 approving shares and one approving
member, but had not executed. `listedProposalId` and `salePrice` were zero.
The market's `saleReference` was also entirely zero, not merely an expired
browser cache. The current Factory operator and both test administrator slots
matched the active single-administrator Authority profile.

The official Firsto API supplied a market capacity reference and this NFT's
daily production, but there was no service that published this reference to the
market contract. The only UI path required manually entering a price and source
in the administrator console. Removing the browser's disabled state would not
solve this: the deployed contract requires the operator's fresh attestation.

The repair reads the official current market reference and the selected NFT's
daily production, then derives its whole-miner reference using Firsto's exact
integer conversion. A private background worker publishes the reference using
the existing Gas wallet. The new ShareMarket entry point permits that wallet
to update references only; sale review, procurement and treasury actions keep
their existing administrator authorization.

The current market has no such entry point. A one-time upgrade uses the existing
Timelock proposer wallet: test `0x6F4d78fB59eC938cBAF65b9fc822aD04d00c155E`, formal
`0x042B23288E2316DFb6503488292FD0Ad2F811Ae7`. Both vault beacons and the core
ShareMarket are upgraded in one atomic batch. Test delay is zero; formal delay
remains 48 hours. Candidate artifacts, storage comparisons and exact graph
bindings are isolated from the active genesis artifacts.

After activation, users see the worker's read-only status. No routine
administrator reference signature is requested. The worker uses the shared
durable Gas-wallet queue, retains unresolved transactions without resending,
reuses fresh references and pauses when its rolling hourly Gas budget is spent.
User listing confirmation remains the point at which `executeSale` is sent;
the reference worker never lists or sells an NFT.

Redacted read-only evidence is retained in
`outputs/test-project-repair-20261002/sale-reference-witness.json`.
