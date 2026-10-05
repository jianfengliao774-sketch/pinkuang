# Portfolio signing entry nonce synchronization

The signing entry used to compare two concurrent floating `latest` / `pending`
wallet reads and label every difference or invalid value as another pending
transaction. This also rejected a stale wallet view after an earlier transaction
had already mined. It could stop the workflow before requesting a signature.

The entry now reads the independent node's confirmed nonce at an explicit block,
reads its pending nonce, verifies the same block hash after the reads, and uses
that nonce only when the independent pending nonce matches and both wallet views
do not lead it. If a transaction mines between reads or a node is behind, up to
three fresh proofs are attempted. Persistent pending, malformed responses and
unsynchronized nodes have separate messages. The UI exposes the observed values
in the existing read-only progress panel.

An original uncertain/submitted journal intent must still be recovered from its
original transaction before any nonce proof or new request. Already confirmed
nonces cannot be reused. No max-nonce selection, automatic transaction replacement,
private-key use or signing is added. The exact candidate config, journal key,
contract bytecode, constructor, upgrade salt and waiting period remain unchanged.

The deployed dedicated read proxy is based on `6841bf0132f600870b135e728ecb8ff5e882ee98`,
with a separate minimal nonce change in `41b12ac` on
`codex/fix-upgrade-nonce-proxy-20261005`. This preserves its archive quota retries,
null-id handling and separate transaction RPC. Its new runtime SHA-256 is
`66d317b0f94a4fcb7151009b2da988ad22d74ddac8669efd61e814ca17ddd84e`.
Nonce queries stay on the primary node, are never cached or coalesced, and explicit
block queries invalidate old headers before and after the read. The same compatible
allowlist increment is present in this branch's older product proxy source; that
older product file is not substituted for the newer deployed upgrade service.

Validation before publication:

- Candidate plan, journal, nonce and product proxy tests: 81 passed.
- Actual standalone upgrade proxy, archive retries, read-server and fee history
  tests: 92 passed (independent reviewer used the existing installed dependencies).
- Isolated TypeScript check, Python publisher syntax check and diff checks passed.
- Two independent public BSC nodes both reported latest/pending nonce 170; the
  MetaMask activity page showed the previous schedule transaction as confirmed.

Publication evidence is recorded separately after checking the live portal.
These are website and read-service fixes, not evidence that the user has signed
the new candidate deployment or timelock schedule.
