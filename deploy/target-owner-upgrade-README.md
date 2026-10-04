# Fixed target owner upgrade page

This standalone page belongs at `/pinkuang-target-owner-upgrade/`. Map only its
`api/rpc` endpoint to the existing read-only RPC service. Serve the packaged
`index.html`, `assets/` and `data/` files. The package has no server executable,
private key, keeper credential or wallet signature.

The page is fixed to the reviewed formal genesis record, genesis artifacts,
activation manifest, current per-node graph catalog and candidate `c9be5208…`.
It deploys only PoolFunds → FlexiblePurchase → PoolVault. The Vault constructor
uses the original Factory. Existing FirstoSale retains its reviewed old Funds
link. The only governance operation is the original Timelock scheduling and
executing `originalBeacon.upgradeTo(newPoolVault)` after at least 48 hours.

Creating candidates does not activate them. The page marks activation only after
the exact five finalized receipts, runtime links, factory immutable, original
formal roles and current Beacon pointer pass verification. Legacy fixed pool
owner migration is separate and is not included in this page.

Wallet submission first persists an uncertain intent. A lost response must be
recovered using the original transaction hash; it cannot be resent. The local
journal is namespaced by four independent evidence digests plus the Factory;
import never overwrites an existing journal. A browser lock excludes simultaneous
submission by two tabs. Journal rows are claims until rechecked against receipts.
An exact finalized canonical `status: 0` receipt is archived with its original
sender, calldata hash and inclusion block. Only then is that same step released
for retry. Missing, pending, mismatched or reorged receipts keep the retry gate
closed. Imported failure archives are rechecked before further submission.

There is no timer, background full-graph polling, app simulation or gas estimate.
User refresh, recovery and each wallet submission trigger an explicit read-only
preflight. Phase text appears during these reads. The separate published live
baseline report is informative and never authorizes a later wallet action.

| CREATE | Measured gas | Fixed gas ceiling |
| --- | ---: | ---: |
| PoolFunds | 2,036,850 | 2,500,000 |
| FlexiblePurchase | 2,943,515 | 3,590,000 |
| PoolVault | 5,334,486 | 6,460,000 |

These values were measured with the actual candidate initcode, mixed per-node
links and preserved Factory constructor in a fresh, un-forked loopback Anvil.
Every runtime was compared byte for byte and a second CREATE run exercised all
fixed ceilings. Local test addresses and hashes are explicitly non-production.
The review uses 20% plus 50,000 gas, rounded up to 10,000. Its canonical evidence
digest is `0x7f2f154c2c2d6814716273294240826f76a5c027aa37d4445016b74dbadbf48e`.

Build from `deploy/` after the reviewed shared plan/proof files are present:

```sh
node scripts/prepare-target-owner-static.mjs --review-catalog /private/tmp/bemine-funding-owner-candidate-20261004/formal-target-owner-review-catalog.json --review-catalog-digest 0x01ff90f9a074a6faeb71c452bd8ad36fc0989b143f68fe5240c4d6ece0c538ba
node_modules/.bin/tsc -p tsconfig.target-owner.json
node_modules/.bin/vite build --config vite.target-owner.config.ts
node scripts/package-target-owner-static.mjs
```

The preparer deliberately requires fixed review roots and the approved local
public evidence files. It cannot turn a new arbitrary artifact or JSON upload
into approved deployment input. A changed candidate or gas measurement requires
an independent review and updated fixed pins. The static package manifest hashes
every public file and records its source fingerprint; no production action is
performed by building or packaging.
