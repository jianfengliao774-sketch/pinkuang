# Explicit recovery of legacy deployment requests

The old PoolFunds row saved no transaction hash or original nonce. A readonly bounded account check found no matching successful CREATE in the record's observed time window; it does not prove an old request was never broadcast. The primary button previously looked usable but could never advance.

The page now requires the user to close other upgrade tabs and cancel the old wallet request, then explicitly archive the unchanged unknown row. This applies only to a current hashless, nonce-less CREATE component. The archive remains unknown, never failure/success, and records a fresh nonce observation separately. Current reviewed sender, initcode and confirmed prefix are checked. The archive action cannot send and stops after durable storage. A later click prepares a new exact nonce and invokes the existing wallet flow. Known hash/nonce rows and governance requests cannot use this recovery. An old delayed deployment can still consume extra Gas or contend for a nonce; the UI states that residual risk.

The existing graph, runtime, canonical receipts, role checks, 48-hour wait, cross-tab lock and compare-and-swap storage protection remain. No wallet signing, broadcasting or contract upgrade was performed during publication. Only the standalone upgrade static entry changes. Formal frontend, services, nginx and pinned contract artifacts remain unchanged.

Validation: actual component tests exercise explicit consent, preservation, zero sends before a new click, pending nonce, exact sender/initcode, graph failure, wallet changes, Web Lock conflict, storage failure and import validation. All prior nonce/hash recovery tests remain. Public publication checks verify each static file and retain every previous immutable asset.
