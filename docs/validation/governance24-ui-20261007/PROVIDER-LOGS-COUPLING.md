# UI provider and scoped archive coupling correction

The parent independently found that `createGovernance24ReadProvider` still excluded `eth_getLogs` from its transport method allowlist. That omission blocked the new proof's required incremental schedule query before it could reach the otherwise working scoped read service. Earlier server-only tests and the static UI review did not exercise this end-to-end coupling; the earlier preliminary no-blocker statement was incomplete.

The correction enables exactly this additional pure read method in the new governance24 provider. It does not add transaction counts, wallet writes or unknown RPC methods. The unchanged scoped service still enforces the exact old timelock, CallScheduled signature, review anchor, 2048-block range and canonical/finalized checks.

The added test invokes the actual exported UI provider's `getLogs()` through the actual isolated HTTP server and actual scoped log handler, with deterministic archive responders. It verifies exact numeric filter serialization, complete returned log formatting, fresh repeated queries and refusal of other events before archive work. Existing write/unknown rejection, retry, deadline and abort tests remain in the same suite. All 17 provider tests, 143 combined old/new UI regression tests and TypeScript compilation passed. No production RPC, wallet operation or UI button was used.
