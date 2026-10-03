# Firsto batch candidate validation

The production candidate pins the officially advertised exchange runtime hash
`0x0a44a1aa18057cf5345eea9e1c58e4d40b0ff9c3da52c0f6eb8032320e7f23fb`.
The public deployed runtime fixture instead hashes to
`0x84072ba0b149f0cb72a8d1be49797ba293206d931407eeb2a25eeaf9f28db0b0`.
The browser compares an API-supplied RuntimeCodeHash with its configuration;
the API's raw/normalized hash convention is not available. The numerical
difference alone does not prove a different contract version. Verified source,
deployment and fingerprint-generation evidence have not resolved the discrepancy.
The candidate therefore rejects that runtime before payment. Its ABI and a
historical successful trade are not sufficient to trust its bytecode.

From the repository root:

```sh
node scripts/run-forge.mjs test --root contracts --match-path 'test/unit/FirstoBatchSafety.t.sol' -vv
node contracts/test/isolated/run-batch-logic.mjs
```

The first command tests the original production pin, including rejection of the
observed public runtime. The second copies the contracts into a disposable local
directory, computes the controlled mock runtime hash, and replaces the pin only
inside that copy. It then compiles `FirstoBatchLogic.t.sol.template` as a temporary
unit test. The original source is checked unchanged. This proves logic against
the controlled fixture; it does **not** prove source provenance, a real Firsto
fill, archive state, or permission to deploy the substituted source.

`test/fork/FirstoBatchPoolFork.t.sol` retains a separate real-protocol rehearsal
at BSC block `125506634`, immediately before the public historical trade for
TapeOut #5181. It has no skips, mock calls, storage replacement, code replacement,
or relaxed runtime pin. Its fixed-block and strict runtime checks must pass
before purchase. Available public RPC returned `missing trie node` for that
historical state, and the runtime provenance blocker remains unresolved. No
passing real-fork result is claimed. This fixture cannot run as part of the
older `123728000` protocol baseline.

The budget order envelope is exactly three top-level ABI values:
`abi.encode(bytes32 magic, uint8 kind, bytes inner)`, where
`magic = keccak256("BEMine Firsto order envelope v1")` and `kind = 1`.
It is not an ABI encoding of a single dynamic tuple. Existing single signed ask
bytes remain unchanged. Inner batch data is
`abi.encode(BatchAsk batch, AskLeaf leaf, bytes32[] proof, bytes signature)`.
Limits are 32 proof elements, 1024 signature bytes, 704–2752 inner bytes and
2880 envelope bytes, with exact canonical re-encoding checked on chain.
