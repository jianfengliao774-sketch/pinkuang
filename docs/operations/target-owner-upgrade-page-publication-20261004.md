# Formal fixed-target-owner upgrade entry

The user-operated upgrade entry is live at <https://bemine.cc.cd/pinkuang-target-owner-upgrade/>. It serves the reviewed candidate and the independently verified preserved formal graph. Publishing this page did not deploy a contract, schedule or execute an upgrade, migrate an old pool, restart a backend worker or change the public product release.

The deployment and Timelock proposer wallet is `0x042B23288E2316DFb6503488292FD0Ad2F811Ae7`. The page requires BSC chain 56. Connect that wallet, perform the read-only check, establish one recoverable upgrade record, and deploy PoolFunds, FlexiblePurchase and PoolVault in order. Verify the finalized original receipt after each send. Then schedule the single existing Beacon operation, export the record, and execute only after the original Timelock's 172800-second delay. Planned addresses and locally claimed confirmation never enable the next deployment.

The source package is pinned to commit `9784000db2f9adf7775e0ebc232b76437f1fdef2`; the candidate artifact is independently pinned to `0xc9be5208ec97a0513d29c5f1d35a9e89f54c998b5994d2a291c09e5e496881e5`. The original Factory, Authority, budget system, markets and assets remain preserved. Existing 3-day whole-machine sale cooldown is not modified by this scoped upgrade.

The offline CREATE measurements use the actual reviewed artifact, current preserved library addresses and original Factory constructor argument. Fixed deployment Gas ceilings are 2500000, 3590000 and 6460000, with a measured 20% plus 50000-Gas margin rounded upward. Both measurement and ceiling replay succeeded on a disposable non-forked loopback EVM. These are Gas limits, not prepaid fee amounts or production receipt estimates. The website adds no application-side transaction simulation or Gas estimate requests.

Load only fetches the seven pinned static public JSON files. Full graph reads run on explicit read-only checks, recovery/import and immediately before a wallet submission, without a background graph polling loop. Reloads and disconnects retain the exact same journal/salt; ambiguous sends block retries. A matching original transaction proven finalized, canonical and status 0 can be archived before retrying that same step. Unknown transactions and changed/reorganized receipt evidence cannot clear a pending send.

## Publication evidence

- [Public manifest](../evidence/target-owner-upgrade-page-static-manifest-20261004.json): ten public files plus manifest, including reviewed Gas and live baseline evidence.
- [Publication receipt](../evidence/target-owner-upgrade-page-publication-20261004.json): nginx configuration tested, every public file hash checked, chain-56 read-only proxy checked, original product HTML/release and six worker invocation identities unchanged.
- [Browser check](../evidence/target-owner-upgrade-page-browser-check-20261004.json): the deployed UI loaded all pinned artifacts and passed its manual read-only graph preflight at finalized block 125575400. Without a connected wallet all send buttons stayed disabled. No wallet signature or transaction was requested.

The first immediate post-reload public probe saw the old nginx worker's 404; the publisher restored the exact prior configuration and removed the new current link. The guarded retry waits briefly for the reviewed entry hash and only reuses an exact previously staged inventory. Its second publication and complete public verification succeeded. The input tar was rebuilt from manifest-listed files to omit macOS resource-fork metadata; all served file bytes and the manifest stayed unchanged.

## Activation still requires coordination

Deployment and scheduling are not activation. After execution, independently verify the three CREATE receipts plus schedule and execute receipts, approve the activated catalog, and coordinate the runtime configuration described in [the scoped candidate runbook](funding-target-owner-upgrade-candidate-20261004.md). Existing fixed pools also require their separately reviewed historical creation-owner evidence and both current administrators' migration signatures. This entry explicitly leaves old-pool migration incomplete and does not activate an automatic cancellation/refund keeper. Until that follow-up is active, the separately published temporary public-directory and subscription guard hides externally transferred fixed fundraising targets while retaining positions, withdrawals and current deadline refunds.
