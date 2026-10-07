# Independent governance24 upgrade entry

The independent read endpoint is `/pinkuang-governance24-read/api/rpc`, backed by the isolated loopback 4230 service. Its incremental `CallScheduled` log scope and deployment templates are documented in `ops/governance24-read/README.md`; old Firsto and product read services remain independent.

Entry: `/pinkuang-governance24-upgrade/`. Only deployment wallet `0x042B23288E2316DFb6503488292FD0Ad2F811Ae7` on BSC mainnet may start the flow. Every transaction requires the selected provider and a user-triggered button flow. The first migration deploys the canonical 13-component prefix, explicitly prompts the user to sign each reviewed covered old-operation cancellation, proves the exact `Cancelled` receipts, then schedules the exact seven-call batch under the original 48-hour timelock, then requires a separate user click after 48 hours to execute. Normal business upgrades use the new 24-hour timelock after full migration; old timelock and old Beacon 48-hour recovery remain.

Old pages and journal schemas are unchanged. The new namespace binds genesis record/manifest, complete predecessor input, candidate artifacts, independent review catalog and the exact ordered cancellation IDs. Nonce intent, fixed gas ceilings, canonical finalized receipts, Web Locks, multi-tab revision checks, failed receipt archives and storage failure recovery remain gated. Pure nonce/finality/transmission helpers are imported from the unchanged tested Firsto module; the new ordered journal and batch receipt verifier remain separate. An unknown send result never authorizes a resend. Cancellation rows have the same nonce and recovery gates; a legacy hashless cancel cannot use the deployment-request archive escape. Failed cancellation receipts permit only a later explicit retry click. Original operation arguments and ETA are retained in the exported plan and visible technical ledger.

Public packaging is exactly eight files: one HTML, one referenced JS, one referenced CSS, and five pinned JSON inputs (`predecessorInput`, `upgradeBundle`, `reviewCatalog`, `gasEvidence`, `liveReview`). The manifest is written beside the public directory. Extra files, symlinks, inline scripts, remote assets, missing pins or changed source hashes are rejected.

`deploy/scripts/governance24-release-roots.mjs` deliberately retains null new artifact/review/predecessor/gas/live roots until independent final review. Candidate JSON cannot supply its own approval. This task has not prepared a production package, sent any chain transaction, published a website or activated a product.

After independent roots are reviewed and committed:

```sh
node scripts/measure-governance24-gas.mjs --input /absolute/reviewed-input.json
node scripts/prepare-governance24-static.mjs --input /absolute/reviewed-input.json --gas-evidence /absolute/measured-gas.json --live-review /absolute/reviewed-live.json
npx tsc -b
npx vite build --config vite.governance24.config.ts
node scripts/package-governance24-static.mjs
```

Measurement is restricted to a fresh disposable loopback, unforked Anvil. It uses neither a production key nor an external RPC and never calls `eth_estimateGas`. Measurement evidence is informational; its local addresses are never deployment claims.

Completion requires all user-signed canonical cancellations and the branded final graph proof, complete coverage, normal 86400-second business delay, preserved 172800-second recovery delay, and confirmed exact original batch receipt. Informational exports never set `productActive` true. Proof results and imported activation claims alone cannot bypass this gate.

Validation: 79 new TypeScript tests plus seven new Node tests passed. A combined regression of the unchanged Firsto and new governance UI passed 142 TypeScript tests. TypeScript compilation passed. Component tests execute the actual component and journal engine against deterministic hooks/wallet/RPC adapters, mocking only independently tested graph callbacks. No browser extension, live wallet, production RPC or chain action is used. Full proof-module tests are owned by the independent proof change.
