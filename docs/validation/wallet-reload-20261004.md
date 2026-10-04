# Wallet recovery after a page reload

Production baseline: `a65f9e31dabeb240c16f4005c4f79a68302d4b04`.

The page previously kept the connected provider/account only in React memory.
Reloading discarded both and redirected the operator route before a previously
authorized wallet could be recovered.

Successful explicit injected-wallet connections now save only a versioned
selection hint (source, reverse-domain identifier and concrete legacy brand).
Reload recovery selects a unique matching provider and reads its current
`eth_accounts` and `eth_chainId`. An address in storage never establishes
authorization; ambiguous, unavailable, revoked or wrong-network selections do
not connect. Manual disconnect removes the hint. Generic legacy providers and
WalletConnect are not guessed or initialized during a reload.

Late wallet injection is bounded to five seconds. Identity reads have a 2.5
second timeout and at most three attempts per recovery stage. Normal recovery
performs four wallet read requests, including the final session handoff check;
it does not add backend/paid-API polling. No permission, chain switch, signature
or transaction is requested by recovery.

The session watcher attaches its listeners before checking the recovered
identity. Transaction controls stay unavailable until this check succeeds.
Each adopted connection has a separate ownership token, including deliberate
reconnections to the same provider, so former callbacks cannot clear the new
connection. Disconnect/identity events retire outstanding responses without
resetting the bounded retry budget.

Validation:

- Catalog, price and current review-policy checks passed.
- Full web/server suite: 1,257 tests passed, no failures.
- Local browser regression: explicit selection then F5 preserves MetaMask and
  the operator route even with another default provider; explicit disconnect
  survives F5 without wallet reads; late EIP-6963 injection works at mobile
  width; current account changes are read afresh; wrong chains and empty
  authorized accounts stay disconnected without wallet prompts.
- Session tests cover the handoff interval, listener-installation events,
  cancellation, repeated interruptions and same-provider stale callbacks.

Browser tests use local fake providers and API fixtures, including when testing
the production export with its public manifest. They never exercise a real
account, paid API, signature or mainnet transaction. UI publication retains the
current contract manifest, backend services, upgrade console and older immutable
static chunks; there is no contract deployment in this change.
