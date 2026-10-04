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
