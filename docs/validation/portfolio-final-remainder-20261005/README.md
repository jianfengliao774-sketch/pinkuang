# Final portfolio sale remainder

When the final child miner is sold, integer division could leave up to 99 wei
without a later sale to distribute it. `settleChildSale` now credits that final
remainder to the existing treasury recipient and clears the remainder before
setting Closed. Intermediate sales keep their carry-forward accounting.
Immediate credit is necessary because PlatformAuthority only calls
`withdrawBnb` when its visible `bnbOwed` is nonzero. The change does not add
storage or ABI entries.

BudgetPortfolio unit regressions: 36 passed, zero failed. The new cases cover
the final 99-wei remainder with acquisition fees still outstanding and with
treasury having already withdrawn those fees; participant and treasury
withdrawals conserve the full balance, and the remainder cannot be claimed
twice. Formatting, diff checks and production `forge build --skip test --sizes`
passed. Runtime size is 24,507 bytes, leaving 69 bytes below EIP-170's limit.

This is a separate, unactivated contract patch. It must not replace the already
scheduled PoolVault candidate or its linked libraries. A new Portfolio artifact,
reviewed deployment binding and the existing upgrade procedure are required
before it affects chain behavior. It does not recover a remainder in a project
already Closed under the old implementation with no treasury debt remaining.

## Separate deployment entry

`deploy/portfolio-dust-upgrade.html` and `PortfolioDustUpgradeStandalone.tsx`
build an isolated signing entry for exactly one BudgetPortfolioVault and one
Timelock schedule call. The reviewed release configuration is in
`deploy/evidence/portfolio-dust-20261005/config.json`. It links the existing
SaleGovernance at `0x64F116956E5647791F491da28BAdc645859d4Baf` and binds the
existing portfolio Factory and Beacon. It never replaces the core upgrade
candidate or submits an execute transaction. Activation requires a later
runtime verification and the existing 48-hour governance waiting period.

The exact candidate runtime was verified through read-only BSC creation and a
local Anvil deployment; no public-chain transaction was sent during preparation.
Local deployment used 5,380,686 gas, with a conservative wallet gas limit of
6,500,000. Unused gas is not charged. This is not a fixed BNB fee quote.

Fourteen portal/proof/journal regressions pass, including wrong Factory/library,
Authority changes, canonical reorg, nonce/calldata mismatch, missing receipts,
cross-scope records, short delays and a canceled schedule. The isolated TypeScript
check and Vite production build pass. Transaction intent is persisted before
wallet requests and protected by a browser cross-tab lock; an unknown submission
is never silently retried. Confirmations are re-proved on resume. The page does
not claim an operation is scheduled if its current chain state is unscheduled.
