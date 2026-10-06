# Portfolio deployment progress correction — 2026-10-06

The confirmed schedule was incorrectly rejected because MetaMask used its Delegation Framework single-call envelope. The original BSC transaction was successful; no second deployment or schedule is required.

The portal now accepts the fixed, signed MetaMask envelope only after checking the exact inner Timelock schedule, original nonce/hash/sender, canonical finalized inclusion, all three reviewed wrapper runtime hashes, and unique complete `CallScheduled` and `CallSalt` events. CREATE remains a direct creation check. Reverted or unknown wrapped transactions retain their original journal and cannot automatically retry.

Saved schedule hashes reconcile on page load with reads only. Both transaction receipts are rechecked; this invocation can reuse its freshly verified complete graph when the graph anchor covers the receipt and the replacement, operation, target and minimum delay agree. A later receipt still requires a fresh graph. Persisted or React proof state is never reused. The redundant full graph read after deployment/scheduling has been removed.

Validation: 105 tests passed across plan, journal, nonce, pacing, workflow, exact schedule envelopes, and proof reuse; isolated portal TypeScript check passed. The privately stored real schedule envelope also passes the same verifier. Public evidence omits its signature and salt.

- Deployment: `0x09831ad37d71a3c8cc8deddcee367f1a3091d95c95a8f87c12cd5833e64ecd76`, nonce 170, finalized.
- Schedule: `0xe328b1082d4b61acfade27755e5fef5c29aec4da5a3ad83876463d6f96fc0202`, nonce 171, finalized.
- Earliest execution: **2026-10-08 09:12:09 Asia/Shanghai**. This correction does not execute the upgrade.
- Candidate signing configuration and browser journal key remain unchanged. Publication changes only the portfolio portal; no read service restart, route change, product release change, or chain action.

[MetaMask official Delegation Framework v1.3.0 deployments](https://github.com/MetaMask/delegation-framework/releases/tag/v1.3.0) identify the fixed DelegationManager used by this transaction.
