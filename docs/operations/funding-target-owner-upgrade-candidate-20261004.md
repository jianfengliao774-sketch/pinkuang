# Fixed target owner — staged upgrade candidate

This branch is a review candidate. It has not been deployed, scheduled, signed, or activated. The current production implementation does not gain these guarantees merely by deploying the website.

## New pools and refunds

`PoolVault.initialize` reads the real ERC-721 owner during creation and stores it in a separate ERC-7201 namespace. A missing token or failed owner read reverts creation. Fixed-pool `deposit` and all three purchase entry points (`buyFromMarket`, `sellToPool`, `buyFromFirsto`) require that owner to remain unchanged. An external buyer's new listing cannot revive a fixed target before synchronization. A flexible pool's opt-in purchase policy excludes this guard: its reference NFT is not its only approved purchase candidate. These contracts do not add the separate ±10% designated fallback proposal.

Anyone can call `syncTargetAvailability()` for a configured fixed pool in Funding or Funded. Only a successful nonzero `ownerOf` read showing a different external owner permits the early transition to Refunding. Pool custody alone is not an external sale. Active, Listed, Closed and already Refunding pools cannot be cancelled by this method. A cancelled listing, price-feed absence, or failed NFT read is not proof of an ownership transfer.

The transition emits the existing `Failed(2)` event and credits each member's actual `contributedWei` to their BNB pull-payment balance. It does not transfer funds to the caller, change the stored contribution total, erase share/checkpoint history, release the factory's machine reservation, or duplicate already credited withdrawal balances. Members use the existing `withdrawBnb` path. The shared Vault `nonReentrant` guard protects synchronization during a purchase callback.

## Existing pools

Existing proxies start with an empty new namespace. An unconfigured fixed pool cannot accept new deposits, purchase, or be automatically cancelled. Existing `withdrawDeposit`, `withdrawBnb`, and deadline-based `finalizeFailure` retain their original permissions. Flexible pools retain their existing behavior.

Do not set an old pool's baseline to its current owner. Historical evidence must identify the creation-time owner, including transaction ordering if the NFT transferred within the creation block. An end-of-block archive read alone may identify the wrong owner in that case. If historical evidence is unavailable, leave the pool unconfigured and preserve withdrawal/deadline refunds.

The one-time migration entry is `configureTargetOwner(bytes authorization)`. The bytes are exactly canonical `abi.encode(TargetOwnerAuthorization, bytes signatureOne, bytes signatureTwo)` (512 bytes; each signature 65 bytes). The authorization fields, in order, are:

```solidity
address originalOwner;
address authority;
address administratorOne;
address administratorTwo;
uint256 nonce;
uint256 deadline;
```

Both distinct, nonzero current administrators must sign the same EIP-712 message. The Vault checks the current Factory operator is the named Authority and reads both current administrators from that Authority. The domain name is `BEMine Target Owner`, version `1`, with the actual chain ID and this pool as verifying contract. The message also binds the Factory, NFT collection and token ID, Authority, both administrator identities, one-time nonce and deadline. Changing these fields, current Authority, or current administrator configuration invalidates authorization. Successful configuration consumes the independent target-owner nonce and cannot be overwritten. This is explicitly an administrator-attested historical baseline, not an on-chain authentication of the original listing or seller quote.

`deploy/shared/target-owner-typed.mjs` produces unsigned typed data and exact migration calldata only. It performs no RPC or wallet operation. The existing Authority's `DepositPause` signature cannot initialize this namespace and its nonce/domain are unchanged. No new Authority deployment or selector allowance is needed because the new Vault validates both signatures itself.

`prepareTargetOwnerMigration` also produces a JSON-safe review packet containing the canonical Factory `PoolCreated` event, exact creation-block `ownerOf` call/result, and ordered same-block target `Transfer` events. It reconstructs the owner before transfers occurring after creation and rejects a mismatched authorization owner. Both named administrators receive the same unsigned typed action. The helper checks encoding and internal consistency; it does not establish canonical-chain membership or prove the transfer list complete. Administrators must independently review those properties and the historical source. The packet's evidence digest is an advisory review fingerprint, explicitly not a field of the on-chain signature.

## Upgrade and frontend integration

Retain the existing Factory, Beacon, Timelock, Authority, pools and assets. Deploy the reviewed new PoolFunds, new FlexiblePurchase linked to that PoolFunds and the existing reviewed PurchaseValidation, and new PoolVault implementation linked to both new libraries and the other existing reviewed library addresses. Authorize only the existing single-machine Beacon upgrade through the original 48-hour Timelock. Reusing old FlexiblePurchase would omit the fixed acquisition guard. The new helper is internal-only and adds no external library address or link name. This candidate leaves all deployed manifests, artifacts and runtime pins untouched.

The existing `fresh-active-upgrade-plan.mjs` includes these libraries and PoolVault but requires ten replacements and upgrades both Factory/market/Beacon families. Passing only these three new addresses is rejected. A scoped upgrade plan and a reviewed mixed-runtime graph must be prepared if only the single-machine Beacon is to change. Do not redeploy a Factory to work around this requirement.

`deploy/shared/target-owner-upgrade-plan.mjs` is that scoped **offline plan builder**: exact replacement keys are PoolFunds, FlexiblePurchase and PoolVault; it requires independently reviewed genesis-record, genesis-manifest and candidate-artifact digests, and computes constructor data, exact expected runtime and hashes. Its only governance payload is `upgradeTo(newPoolVault)` on the preserved single-machine Beacon, with unsigned `schedule`/`execute` calls to the preserved Timelock and at least 172,800 seconds. It does not verify live roles, deployed bytecode, current Beacon pointer, canonical receipts or salt uniqueness, and does not perform the upgrade.

## Activation sequence and remaining integration

1. Preserve the original genesis evidence. Prepare an independently reviewed target-owner upgrade catalog containing the exact three new runtime proofs, unchanged Factory/Authority/markets/budget pointers, each constructor/link binding, and the canonical Timelock execution receipt. Current `deploy/server/product-graph.mjs` has explicit proof kinds for other upgrades; it does **not** accept this new target-owner kind yet. Add an explicit, independently pinned catalog/proof verifier instead of replacing genesis expectations or accepting arbitrary live code. `deploy/server/fresh-product-gate.mjs`, the chain-index manifest identity and worker readiness pins must agree with that reviewed upgraded graph.
2. Match bytecode using per-artifact link maps. New FlexiblePurchase links new PoolFunds, and new Vault links both. Unchanged FirstoSale remains linked to the **old** PoolFunds runtime; a single global replacement map applied to every old library would falsely reject that preserved runtime. All old unaffected artifacts must continue to come from the preserved original bundle, not a freshly recompiled metadata variant.
3. Before Beacon execution, prepare the upgrade-aware website. Once the reviewed version-one runtime is canonical, read each Funding/Funded fixed pool's `targetOwner` configuration. Historical off-chain availability alone cannot authorize a deposit: unconfigured old fixed pools must show migration required and refuse subscription/purchase. Never open a wallet that will knowingly revert `TargetOwnerNotConfigured`. This also applies to any existing budget child using this Beacon. Flexible and Active/Listed/Closed pools retain their existing paths.
4. Verify creation-time evidence and obtain both explicit current administrator signatures for each existing fixed Funding/Funded pool (currently the five displayed legacy Funding projects). Submit each canonical migration envelope only after capability and runtime verification. Unknown historical owners remain unconfigured; existing withdrawals and original deadline refunds stay available.
5. For **automatic** early refund, a separately reviewed keeper must call `syncTargetAvailability` only for configured Funding/Funded fixed pools with successful current-owner evidence showing an external owner change. Unknown/reverting reads and flexible reference changes must not send a transaction. Calls are idempotent only while still eligible; re-read state before each send and keep normal transaction recovery. This candidate exposes the permissionless guarded method but does not add or activate that keeper.

The current website/backend owner guard prevents unsafe subscription attempts. It does not execute an on-chain cancellation or credit early refunds by itself. A newly created pool locks its real owner automatically after the Beacon upgrade; an existing pool requires the explicit migration above. The minimal plan does not pause creation, so activation coordination must account for pools created during the review/48-hour interval and migrate every old fixed pool, rather than assuming the initial five are the entire set forever.

Only after the reviewed upgraded runtime is finalized may a frontend expose the new capability (`targetOwnerVersion()==1`), show each old pool's migration status, request two explicit administrator signatures for the verified historical owner, and submit the exact envelope. Until then, use the existing off-chain list/subscribe guard and describe the current deadline-based refund accurately. A candidate upgrade/migration page must not claim these methods exist on the production implementation.

## Local validation

- Clean Solidity 0.8.24 build, optimizer runs 1, Shanghai, non-viaIR.
- 578/578 unit tests, including 30 target-owner cases; 6/6 audit tests.
- 18/18 invariant tests using the CI profile: 128 runs, depth 64, 8,192 calls per invariant, zero unexpected reverts. The earlier bounded 32-run/32-depth pass also passed.
- 14/14 offline Node tests for typed signatures, creation-owner review evidence and the minimal upgrade plan.
- OpenZeppelin validation: all 26 checks pass, including delivered T1a–T1e storage baselines, inherited/namespaced layout compatibility, three compatible upgrade fixtures and rejection of the deliberately incompatible layout. The new internal-library AST/link audit passes without an external link-name addition.
- Runtime templates: PoolVault 24,286 bytes; PoolFunds 9,172; FlexiblePurchase 13,365. All are below the EIP-170 limit of 24,576 bytes. The Factory runtime is not a replacement in this plan.

These are local tests and compilation evidence, not a real-chain fork, deployment receipt, current runtime proof or activation. Existing production artifacts and manifests were not replaced.

The real compiled candidate bundle also passed the scoped planner against the preserved formal genesis bundle (`0xbe37228e94095440e9cde68ae7b5e605b75154a5c7453d58b796ddb2925ec927`) and formal activation manifest. Candidate digest: `0xc9be5208ec97a0513d29c5f1d35a9e89f54c998b5994d2a291c09e5e496881e5`. The [small offline evidence summary](../evidence/funding-target-owner-upgrade-candidate-20261004.json) records all three live-verification flags as false and does not publish synthetic example addresses as deployment facts. The candidate was compiled from contract-source commit `f7a73b21aa7f471e05e559d8cf5dcc2f4252f738`; this documentation/evidence update does not alter compiler inputs.

Local raw evidence (outside the repository): `/private/tmp/bemine-target-owner-final-unit.log`, `/private/tmp/bemine-target-owner-audit.log`, `/private/tmp/bemine-target-owner-invariants-ci.log`, `/private/tmp/bemine-target-owner-node-tests.log`, and `/private/tmp/bemine-funding-owner-upgrade-validation/upgrade-summary.json`. The candidate bundle and full unsigned synthetic-address example plan are under `/private/tmp/bemine-funding-owner-candidate-20261004/`; neither is a deployment record.
