# Independent mainnet sale rehearsal

This test pool uses BNB Smart Chain (chain ID 56), its own ERC20 shares and a newly created mock ERC721. It never holds a formal miner or calls Firsto, mining, official factories, signing services, or production APIs. Construction is nonpayable: the simulated purchase cost is a reference value, not a deposit. Every simulated cost, sale reference and proposed price is capped at 0.001 BNB. Use 0.00001 BNB for the first sale test.

Deploy `ShareCheckpoints` and `SaleSettlement`, then link those addresses into `SandboxSalePool` creation bytecode. The pool constructs `SandboxMockMiner` itself. The pool constructor is:

```solidity
constructor(address testOwner, address[] initialMembers, uint8[] initialShares, uint128 simulatedPurchaseCost)
```

The connected deployment wallet must be explicitly passed as `testOwner`; this avoids an internal CREATE wrapper becoming administrator. The only administrator and platform-fee recipient is `testOwner`. Initial members must be unique, nonzero, and hold exactly 100 whole shares in total. The pool has no external mint, replacement NFT, admin drain, or privileged sale completion. A new rehearsal can use a new isolated pool.

`SandboxSaleGovernance` is generated from the current production `SaleGovernance` source. Only the library name/import, six external entries inlined into the pool, and three durations change: initial hold/proposal cooldown 60 seconds, voting window 300 seconds, listing expiry 900 seconds. Strict majorities of both snapshot addresses and snapshot shares, the voting freeze, the 15-minute market reference freshness rule, exact-price low-price approval, and the sale settlement calculations remain unchanged. Run `node contracts/sandbox/generate-governance.mjs --check` after production governance changes.

The workflow is `transfer` (before voting if members need test shares), `propose`, `vote`, optional owner `reviewSale`, `executeSale`, buyer `completeSimulatedSale`, and each holder `withdrawBnb`. Refresh `setSaleReference` from the owner when needed. Passing votes can execute immediately while the five-minute window remains open; the window is a deadline, not a mandatory wait. Listings can be canceled only after the 15-minute expiry. A below-reference proposal needs owner approval for the exact current proposal ID and price. Rejection is final for that proposal.

`completeSimulatedSale` requires the exact listing ID, price and `msg.value`; it transfers only the pool's mock NFT to the buyer. The original production `SaleSettlement` deducts a 1% platform fee, assigns all remaining wei to holders (including its deterministic rounding recipient), and `withdrawBnb` materializes and pays the caller's entitlement in one transaction. These are small real BNB payments. The test does not exercise a real Firsto ask, its buyer fee, a real miner's reward settlement, formal NFT transfer, production signature service, or the formal factories.

Run:

```text
node --test contracts/sandbox/governance-source.test.mjs
node scripts/run-forge.mjs test --root contracts --match-path test/sandbox/SandboxSalePool.t.sol -vv
```

Publish only verified creation/runtime artifacts and deploy using the user's wallet. The public page must reject the wrong chain, an unexpected owner, malformed links/bytecode, excess transaction value, and any address outside its three deployment receipts and the pool-created mock NFT.
