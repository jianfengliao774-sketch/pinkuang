# T0.2 Q8 / Q9 evidence notes

All reads and independent swap tests use BSC block **123728000**, hash `0x18c5cda4bb465d1a9aae3d4fe66150cffbe187e2488b856a93f4376080e26306`.

## Q8 — BEM mint permission

- BEM `minter()` returns the Mining proxy `0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46`.
- This is a runtime-code permission check, not an inference from the token name: selector `0x40c10f19` jumps to byte offset `0x02f8`; the deployed bytecode at `0x031f` contains `PUSH32 0x0000000000000000000000007e2e0dc66a3bd9103e69b766afa62d9f7b697b46`. `CALLER` at `0x0342`, then `SUB` and `JUMPI`, send every different caller to the reverting branch at `0x03da`. See `token-bem-runtime.hex` and `token-mint-disassembly.txt`.
- `test_Q8_MintOnlyImmutableMiningMinterAndCap` verifies a non-minter call reverts, a fork-only impersonation of Mining can mint 1 BEM, and exceeding `MAX_SUPPLY` reverts. This impersonation does **not** show that an ordinary wallet can cause arbitrary issuance through the Mining implementation.
- BEM decimals: **8**. `MAX_SUPPLY = 2,100,000,000,000,000` raw units = **21,000,000 BEM**. Supply at the fixed block is `22,572,656,921,338` raw units = **225,726.56921338 BEM**.
- The authority chain continues into Mining: at this block `owner() = address(0)`, `isSealed() = true`, and its EIP-1967 implementation slot points to `0xa3dbe873da37cd4e4a13c7cef23a7db6ca60f898`. The test asserts all three facts. These observations do not substitute for a full audit of all authorization paths in that implementation.
- BEM's `owner()` call reverts. This alone would not establish who can mint; the successful `minter()` read, deployed runtime check, and permission test provide the evidence.

## Q9 — SmartRouter native BNB swaps

The [official PancakeSwap v3 address reference](https://developer.pancakeswap.finance/contracts/v3/addresses) identifies BSC SmartRouter as `0x13f4EA83D0bd40E75C8222255bc855a974568Dd4`. Fixed-block reads and `test_Q9_PoolAndRouterIdentity` verify:

- Pool `0x28B12792F9D81Bd529Bc5572434E861C9EDbBBC2`: `token0 = BEM`, `token1 = WBNB`, `fee = 10000 / 1000000 = 1%`, nonzero active liquidity.
- Pool and router factory: `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865`.
- Router `WETH9()` returns BSC WBNB `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c`; WBNB has 18 decimals.
- The fork executes SmartRouter's seven-field `exactInputSingle` tuple. It uses `multicall(uint256 deadline,bytes[])` for a deadline; the exact-input tuple has **no deadline field**. BNB input is payable and wrapped by the router; output in WBNB is delivered to the router and unwrapped into native BNB with `unwrapWETH9(minimumOut, recipient)`.

| Test | Input | Actual output | Nonzero minOut | Fee-adjusted spot shortfall |
|---|---:|---:|---:|---:|
| `test_Q9_BnbToBemWithMinOutAndRefund` | 0.001 BNB (`10^15` wei) | 0.01213154 BEM (`1213154` raw) | 0.01201023 BEM (`1201023` raw) | 1 BEM raw unit; approximately **0.824297 ppm** |
| `test_Q9_BemToNativeBnbWithMinOutAndUnwrap` | 0.01 BEM (`1000000` raw) | 0.000807891677110236 BNB (`807891677110236` wei) | `799813783390897` wei | `1033385620` wei; approximately **1.279112 ppm** |

Each direction starts from a separate fresh fork of the same block. For the BEM sale, the real BEM holder `0x4e5dcf356443174f5f03e4ac134238201c1f2bd8` is impersonated to transfer 0.01 BEM into the test contract. No ERC-20 `deal`, storage overwrite, synthetic mint, or preparatory pool trade is used. BNB funding is a local `vm.deal`; no mainnet transaction is sent.

The measured shortfall is **deterministic price impact plus integer rounding against the instantaneous spot price after a nominal 1% fee**. Buy spot and post-fee quote are already rounded to BEM's 8-decimal raw units. These are not measurements of mempool execution slippage or an assurance for larger trades. Relative to fee-free spot, the total shortfall is about **1.000155%** for the buy and **1.000127%** for the sale; almost all of it is the 1% pool fee. Gas is excluded.

`test_Q9_ExcessiveMinOutRevertsWithoutTakingBnb` verifies that an impossible `minOut` reverts atomically without losing the funded BNB or crediting any BEM. Production integration still needs a quoted `minOut`, deadline, and configured `maxIn`; this test does not select business limits.

## Reproduction and results

Read-only RPC evidence:

```powershell
python scripts/m0/token-evidence.py
```

Fork command (using an ASCII temporary mirror to avoid the Windows compiler path issue):

```powershell
$env:BSC_RPC_URL='https://bsc-mainnet.public.blastapi.io'
$env:FORK_BLOCK='123728000'
$env:HTTPS_PROXY='http://127.0.0.1:7897'
$env:HTTP_PROXY='http://127.0.0.1:7897'
.tools/forge/package/bin/forge.exe test --root "$env:TEMP/tapeout-tokenprobe-123728000/contracts" --match-contract TokenSwapProbeTest -vvv
```

The local HTTP proxy is an environment transport detail, not a repository or CI requirement. The mirror contains the same test source, Foundry configuration, and dependency tree as the project.

Raw output: `token-forge-test-vvv.log` — **5 tests passed, 0 failed, 0 skipped**. Raw JSON-RPC requests/responses: `token-chain-evidence.json`.

No business contracts, shared address constants, private keys, broadcasts, or dependency changes were introduced.
