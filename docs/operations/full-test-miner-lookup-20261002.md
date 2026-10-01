# Newly minted miner order discovery repair

Published source: `a15b44dde73d05aa02956d9dd491adb5de6d0dfd`.
Site: https://tapeout.cc.cd/bemine-full-test/#operator

## Observed failure

TapeOut NFT `16736` was returned by Firsto's exact numbered list (total 1),
but the local quote proxy returned zero rows and `excludedOnPage: 1`.
The asset belonged to official collection
`0xb1024b89886b9a34aa4ff5f31c411d708b20a14c`, category `official_mining`,
with verified Mining status, positive verified weight and zero unverified weight.
Its separate netlist enrichment classification was `unknown`.
Both proxy and quote adapter incorrectly required enriched classification
`official_mining`; the detail adapter imposed the same incorrect restriction.

## Repair

- Permit pending classification `unknown` only alongside the existing official
  collection, category and verified Mining requirements. Explicit unrelated
  classifications, foreign collections and unknown Mining states stay excluded.
- Accept the same pending enrichment state when matching the exact order detail.
- Numeric searches with a selected series directly query that NFT's official
  market, then Firsto when needed. They no longer depend on a directory match
  or show an empty directory as evidence that no order exists.
- Canonicalize numeric input, including leading zeros, for exact NFT identity.

## Verification and publication

69 relevant proxy, pricing, quote, procurement and component regression tests
passed. TypeScript, Vite deployment console and Next static export succeeded.

The isolated API runtime was patched with
`full-test/ops/patch-firsto-enrichment.py`; all 67 installed module hashes and
both matching source inventories verified after the patch. API was restarted
and public configuration returned `status: ready`.

Static release: `/var/www/bemine-full-test/releases/miner-lookup-a15b44dde73d`.
The deployed contract artifact digest remains
`0x3d386ce28a1898546697d1ee715b5276104894f781e68b785306eac9cde5338b`.

Live API subsequently returned one exact `16736` row, zero exclusions,
seller price `40000000000000000` wei and buyer total `40400000000000000` wei.
The actual Chrome operator page, connected to the existing `155E` administrator,
displayed TapeOut #16736, 0.00432 BEM/day, 9.25926 BNB/(BEM/day),
0.04000 BNB seller price and 0.04040 BNB fee-inclusive cap.
Clicking the reversible fill button populated miner ID `16736`, raise
`0.04444` BNB and cap `0.04040` BNB. No wallet signature, transaction simulation
or broadcast was performed.

Screenshot: `/private/tmp/bemine-16736-lookup-fixed.png` on the local workstation.
Source and evidence are pushed to `codex/full-test-gas-repair-20261001`.
