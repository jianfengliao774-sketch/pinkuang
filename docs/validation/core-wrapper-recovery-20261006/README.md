# Core wallet wrapper and original schedule recovery

The upgrade portal rejected a successful MetaMask DelegationManager wrapped `Timelock.schedule` transaction because it compared the outer transaction directly with the expected inner call. It also resumed a newly scheduled batch instead of the original batch whose 48-hour delay had already elapsed.

The repair accepts only the reviewed single-call wallet envelope and verifies its exact inner target, value, calldata, delegation signature, caveat and reviewed finalized runtime. Sender, recorded nonce, canonical finalized transaction/receipt rereads and operation events remain required. Failed or ambiguous wrapped calls stay blocked. The patch does not change contract candidates, governance delay, roles or financial actions.

A separate original-schedule recovery import proves both current and imported records against the live graph, preserves the complete current record in an immutable local archive, checks storage/current-session barriers, and switches to the already-ready original journal. Import performs no chain writes. The original deployment and schedule receipts are reconstructed from canonical public evidence, not from untrusted exported proof or plan fields.

The original operation became executable on 2026-10-06 at 18:00:33 Asia/Shanghai. The batch scheduled on 2026-10-06 at 19:45:39 has a different operation ID and becomes executable on 2026-10-08 at 19:45:39. Evidence for both operations and all candidate deployments is included in the redacted JSON files. Execution remains a wallet action for the user.

Validation: 60 shared/package tests and 57 UI/sequence/intent/recovery tests passed; full deploy TypeScript checking passed. Recovery tests cover wrong payload, sender, nonce, events, canonical reread changes, reverted wrappers, expired proof and preservation barriers. Four additional bounded import tests passed, and the 40 import/related tests rerun passed. A full 207,712-byte export now parses through the same record validator. Full import files are bounded to 512 KiB; the actual saved journal remains bounded to 100,000 UTF-8 bytes. The native Chrome recovery succeeded: the original ready operation is active in the portal and one complete new batch is archived locally. The final static publication receipt is recorded separately.

Only the standalone core static portal is published. The candidate artifact/catalog pins, formal product, portfolio portal, read runtime, service invocation IDs, Nginx configuration and protected server configuration remain unchanged. Public static bytes are verified against the package manifest after publication. No deployment, schedule, execute, cancellation, transfer or wallet confirmation is performed by this repair.

Private wallet journals, salts and real wrapper signatures are excluded from this directory and from the public repository. Synthetic wrapper fixtures use test-only accounts.
