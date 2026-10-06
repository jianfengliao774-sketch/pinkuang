# Core runtime assembly after target-owner Beacon upgrade

This branch assembles a source-pinned local product and signer release. It makes no
contract deployment, transaction, server, catalog, or secret change.

The deployed genesis artifact remains `deploy/public/deployment-artifacts.json`
from source `6361bff1247e7297b96d2659145a0e7256e6765c`. Only `contracts/src`
was restored byte-for-byte to that source so the existing
`assertPinnedSourceUnchanged` release check remains valid. The executed
target-owner implementation is represented by a separately pinned, reviewed
candidate artifact and upgrade catalog supplied at runtime. Do not regenerate
the genesis artifact from this branch or put the candidate Solidity source into
the genesis package.

The release starts from target-owner runtime source `0cc28a7cd04deaafdebb4b2435f1d8d63e6dd13d`.
It also preserves deployed signer fixes from `ea3b647ac715618855cdba68491bd22ec58ed581`:
parallel interactive RPC reads, existing-journal-only failure recovery,
finalized failure archival, and bounded fast administrator submission. The
overlapping signer API and IPC modules retain the target-owner catalog pins.
It also preserves deployed mining monitor and nonce-followup fixes from
`716254c3fc540a5273070c9d1b1db6d7003696bd`; its two runtime module files
match the live mining service byte-for-byte before catalog adaptation.
The existing chain-index release `f86aa63a2425` stays in place; its target
availability fixes must not be replaced with this package's index entrypoint.

The product, signer, purchase and mining services must read the same genesis
manifest and target-owner catalog/artifact paths and digests:

* `BEMINE_GENESIS_MANIFEST_PATH`
* `BEMINE_TARGET_OWNER_CATALOG_PATH`
* `BEMINE_TARGET_OWNER_ARTIFACT_PATH`
* `BEMINE_TARGET_OWNER_CATALOG_DIGEST`
* `BEMINE_TARGET_OWNER_ARTIFACT_DIGEST`

The catalog must first pass the independent completed-upgrade proof against a
current canonical BSC block. The product and signer may use separate immutable
copies of the same packaged backend, with the exact same `sourceHead` and
`BEMINE_FRESH_MACHINE_SOURCE_HEAD`. Both workers must run that source and emit
fresh heartbeats whose graph identity includes the reviewed
`targetOwnerUpgradeDigest`; otherwise operational readiness remains closed.
Existing private signer journals and wallet-pointer state stay in place. Do not
start a worker until its pending journal and prior sender drain have been
checked. The live portfolio Beacon and old-pool owner migration are separate
work and are not changed by this runtime assembly.

## Public proof provider repair

The completed core batch executed at BSC block 126058586 on 2026-10-06.
The configured journal RPC can read current Beacon state but rejects historical
`implementation()` calls at the execute block and its preceding block. These
reads are required by the reviewed upgrade proof; suppressing them would hide
a real change in upgrade identity. The existing `BEMINE_READ_RPC_URL` supports
those reads and completed the full current graph proof with the original
9-second, no-retry, static-network provider at finalized block 126063231.

The public official proof provider now selects that configured read RPC and
follows the existing journal RPC fallback when it is unset. The signing provider
continues using `DEPLOYMENT_JOURNAL_RPC_URL`. Public product graph responses
include only the verified target-owner capability's public fields; catalog salts
and private recovery records remain excluded. Stale display snapshots keep
transaction and operational readiness disabled.

Validation: 70 journal, integrated graph, official-candidate and capability
regressions passed, including a two-endpoint test in which historical calls fail
on the journal RPC and succeed on the read RPC. The prior runtime assembly's
208 regression checks remain recorded separately.
