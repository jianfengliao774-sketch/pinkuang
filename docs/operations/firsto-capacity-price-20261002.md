# Firsto daily capacity price — 2026-10-02

The official frontend bundle at
https://tapeout.firsto.ai/assets/index-C0yCy4VD.js calculates a whole-miner daily
capacity price as `floor(priceWei * 10^tokenDecimals / estimated24hAtomic)`.
Its reverse conversion rounds up to the next wei. The unit is BNB per
one BEM of estimated daily production; it is not a BEM market price or a payback
period. Buyer fees are separate from this quoted-price calculation.

The official detail API for TapeOut #16736 at
https://api-tapeout.firsto.ai/v1/circuit/0xb1024b89886b9a34aa4ff5f31c411d708b20a14c/16736
returned `estimated24hAtomic=432000` and `tokenDecimals=8`, or 0.00432 BEM/day.
A proposed whole-miner price of 0.01500 BNB therefore gives 3.47222 BNB per
(BEM/day), rounded to the user's requested five displayed decimal places.
That screenshot value already agrees with Firsto's formula.

The UI repair makes the unit explicit and separates five-decimal presentation
from precise input and transaction values. Derived prices must use Firsto's
integer floor/ceiling conventions; displaying five decimals must not silently
change the amount submitted for a sale proposal. The same calculation applies
to project, miner and share-market displays, with a share price converted to the
whole project's fixed 100 shares before dividing by whole-miner daily output.

Read-only official-source evidence is retained under the workspace directory
`outputs/test-project-repair-20261002/`, including the downloaded official bundle
and `firsto-official-evidence.json`. Both sites retain their current contracts,
administrators and deployment manifests.
