# Exact review of five existing Slither findings

The formal target-owner candidate retains the existing Firsto sale and sale settlement code. Slither 0.11.5 reports five Medium findings in those unchanged paths. They were reviewed individually; no Solidity file, approved deployment bytecode, compiler metadata, gas ceiling or published upgrade package was changed to silence the scanner.

The first remote run (`37163173399`, contracts job `111320663347`) failed the raw `--fail-medium` threshold after 602 passing tests and passing storage compatibility checks. A separate local scan of the same committed source also returned 255 with 5 Medium, 92 Low and 55 Informational findings. This is not a zero-findings report. The raw JSON/log stays in the evidence directory and its digest is recorded in `slither-local-input-20261004.json`.

| Exact site | Disposition and evidence |
| --- | --- |
| `FirstoSale.delist`, pool-share balance equals zero | Required membership rejection. The self-call reads this Vault's ERC20 share count, not an ETH/external-token balance target. `TargetOwner.t.sol` and existing governance tests preserve membership restrictions. |
| `SaleSettlement.totalOwed`, sole member owns all 100 shares | Required remainder liability. `PoolFunds` allocates that remainder only to the all-share holder; excluding it would understate liabilities. `PoolPurchase.t.sol` checks the 99-wei remainder and settlement. |
| `PoolVault._harvest`, returning `FirstoSale.harvest` | Explicit four-value tuple return. Slither's unused-return detector retains tuple-element lvalues even when the tuple itself is returned. `PoolRewards.t.sol` checks all four amounts. |
| `FirstoSale._harvest`, returning `RewardAccounting.account` | Same explicit tuple-return detector limitation, with the same rewards regression coverage. |
| `FirstoSale.receiveNative`, invoking `RewardAccounting.account` | Deliberate use of bookkeeping, platform-fee transfer and `Harvested` event. The tuple is an accounting summary, not a success flag. A revert still rolls back the native sale. Existing native-sale tests check accounting and failed payout rollback. |

`FirstoSale.sol`, `SaleSettlement.sol` and `RewardAccounting.sol` are byte-identical to the formal artifact's source commit `6361bff1247e7297b96d2659145a0e7256e6765c`. `PoolVault._harvest` has the same return body; its location shifted when the new owner functions were added. This source comparison is not a claim that the earlier Slither run was repeated.

`scripts/review-slither.mjs` accepts only the five exact detector IDs, complete descriptions, functions, source paths and expressions in `slither-reviewed-findings.json`. Five relevant source files are hash-pinned. Any source edit, additional Medium finding, High finding, duplicate finding, changed occurrence, unknown impact, missing report or tool failure rejects the check. No detector is globally excluded, and the scanner still runs `--fail-medium`; its original nonzero exit is recorded separately from the successful review. Regression tests deliberately introduce those rejected cases.

This is an internal assessment, not a third-party audit. Lower-level findings remain visible in the complete report.
