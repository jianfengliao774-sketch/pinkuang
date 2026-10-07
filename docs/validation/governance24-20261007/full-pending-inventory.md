# Complete old Timelock inventory and pending portfolio patch

The read-only inventory covers the Timelock's actual creation block **125476240**, including the 47 blocks before the formal verification anchor, through finalized block **126156767** (`0xed113da760e87a2e61877cccb2e2ae7025a9ffc3bc7a2724f19b4de7be8566de`). The 69 ranges are contiguous and contain 14 events, four operation IDs and **three pending operations**. Each event's transaction, successful receipt, exact receipt log inclusion and canonical block header were checked. The beginning and finalized end headers were rechecked after collection.

Each schedule was forwarded through the existing wrapper. Its complete targets, values, payloads, predecessor, salt and delay were reconstructed from the Timelock's own verified `CallScheduled` and `CallSalt` events. Single-call and batch encodings were independently hashed; exactly one matched the operation ID. Current pending timestamps equal the original block timestamp plus the original 172800-second delay. The complete raw events, transactions and receipts remain in protected local evidence; the compact JSON records its SHA-256 and Keccak-256 file digests.

| Pending operation ID | Target | Original ETA, Asia/Shanghai | Schedule transaction |
| --- | --- | --- | --- |
| `0x8ae3fceccde348445cdef62041cba8861fccecc9b2a347a213da3503da72709b` | Portfolio Beacon | 2026-10-08 09:12:09 | `0xe328b1082d4b61acfade27755e5fef5c29aec4da5a3ad83876463d6f96fc0202` |
| `0x5432346a5d2d3558c444d2b0a8b62e99df41bd857abe67191ba365ead83b19ff` | Core Beacon | 2026-10-08 19:45:39 | `0x31b4470f2d8beeba053cd0cb2be7bfc8778903d3e13b3c6f0c8f6bcd976e71b1` |
| `0xe3350ca31df2df72fb1a69ca68d3514e960780f5ab4eafc3434c59a462377a27` | Core Beacon | 2026-10-09 07:46:36 | `0x2731466effdf23023d12d387aca16c6782c5672b5960bc049611a6766238e390` |

The third pending Core Beacon operation is newer than the two previously known operations and must be included in the migration review. All three are old `upgradeTo(address)` operations that could replace the new dispatcher later. Their handling belongs to the explicit user-signed migration plan; this read-only inventory did not cancel, execute or send any transaction.

The pending portfolio implementation `0xd318bceEAb70B9C96b360d21051e5A7262522C9A` was independently checked against the original dust-patch artifact. Its complete runtime, preserved SaleGovernance link and official factory immutable match exactly; runtime Keccak-256 is `0x0ebfcb7243b2808904b178e743be4bc2c90c95dc358df46305ad59d08a1df3a6`. The original CREATE transaction `0x09831ad37d71a3c8cc8deddcee367f1a3091d95c95a8f87c12cd5833e64ecd76` was rechecked for exact initcode, zero value, sender, contract address, successful canonical receipt, canonical block inclusion and finality.

The governance migration candidate's entire `BudgetPortfolioVault.sol` file is byte-for-byte equal to actual dust-fix commit `6150ad88`; its SHA-256 is `45217a6dc436f58754dfec09f150b6a0f92384eb24167ed1b81492beccc29998`, matching the new compiled artifact's source hash. This checks that the final-sale rounding fix is included in the new migration candidate rather than merely mentioned in the upgrade UI.

These facts are anchored to the stated finalized snapshot. Newly scheduled operations after that snapshot require a new inventory before release or execution.
