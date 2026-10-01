# Independent full test deployment

Build `node scripts/full-test/build-artifacts.mjs`, then run
`node scripts/full-test/anvil-graph-check.mjs` and
`node --test scripts/full-test/*.test.mjs`.

Generated output is separate under `full-test/public/`:

- `deployment-artifacts.json`: same schema and 21 formal contract/library names and ABIs, with digest-bound `metadata.profile = "full-test"`, exact timing substitutions, original source hashes and transformed compiler input hashes.
- `contracts.generated.json`: the existing web ABI mapping, rebound to the independent artifact digest; the formal web ABI file is not overwritten.
- `gas-plan.json`: `schemaVersion = 1`, `kind = "bemine-full-test-gas-plan"`, `artifactDigest`, 16 `gasLimits` and 7 `activationGasLimits`, all decimal strings. Each limit is measured gas plus 30% and 50,000, rounded up to 10,000.
- `local-graph-evidence.json`: actual disposable Anvil receipts, runtime fingerprints and binding assertions. Its addresses are local fixtures and must not be imported as a mainnet deployment manifest.

`verifiedFullTestBuildDigest()` recompiles and checks the independent bundle for a deployment-console build. It does not read or write production runtime configuration.

The 16 bootstrap calls retain the existing `integrated-v2` order and constructor bindings:
9 topologically sorted linked libraries, `AtomicDeployment`, `PoolVault(predictedFactory)`,
`FreshPoolFactory`, `ShareMarket`, `BudgetPortfolioFactory`,
`BudgetPortfolioVault(predictedPortfolioFactory)`, and
`AtomicDeployment.deployIntegratedSingleOwner(...)`.
Owner, operator and treasury initially equal the deployment wallet. The normal 7 Authority activation calls then deploy
`PlatformAuthority(coreFactory, budgetFactory, administratorOne, administratorTwo, gasWallet)`,
set both factories' operator/treasury to Authority, and transfer both owners to their common timelock.
Authority activation is required before calling the full deployment active.

Only 10 exact fragments in 8 sources change in memory:
single-miner initial holding/proposal cooldown, three multi-miner holding/round/member cooldown fragments,
and six matching timelock minimum-delay/binding fragments become zero.
The vote window stays 24 hours, listing/order expiry stays 7 days, and purchase/accounting periods remain formal.
Passing both strict majorities allows execution during the vote window; it does not require waiting until its end.
A single-miner proposal still uses a timestamp later than its activation for the original checkpoint invariant.
Upgrade execution has zero delay in this test profile, but proposer/canceller/executor permissions remain enforced.

The complete graph retains the real fixed BSC NFT, Mining, BEM and Firsto addresses.
The local EVM check alone installs existing fault-injection fixtures at these fixed addresses to exercise
purchase, immediate proposal, signed low-price review, Firsto guarded settlement, holder withdrawal and Authority fee withdrawal.
Those fixtures are never included in the deployment bundle and this check is not evidence of the real protocol's behavior.
Deployment on chain 56 remains a separate user-wallet action and needs independent test assets and addresses.
No formal source, formal artifact or production service is changed by these scripts.

The complete interface and wallet deployment console are mounted at
https://tapeout.cc.cd/bemine-full-test/ and /bemine-full-test/deploy/.
Use the selected deployer 0x6F4d78fB59eC938cBAF65b9fc822aD04d00c155E.
The test administrators are that wallet and 0x7674fa446D42b1f7f150DC5e678cc525d275Ea53.
The separately generated test Gas sender is 0xaD95dFf16FE0e09C47bADe687aB549929AC66c80;
its private key remains only in the test server's systemd credential. Automation
requires funding that sender with at least 0.003 BNB. These are real mainnet funds.

After committing, rebuild artifacts and run build-site.mjs --output with a new absolute directory.
build-runtime.mjs --out with a new absolute directory and --denylist with an explicit formal-address-list.json
installs an exact source copy under runtime/deploy/, with separate cookies, ports, roles,
test time bounds and state paths. It never imports the production runtime as a fallback.
full-test/server.mjs keeps the interface unconfigured until all 23 wallet transactions
are proven. The explicit “启用测试站” action derives manifests from the authenticated journal.
A separate systemd path triggers full-test/ops/activate.py, which independently proves
the graph before starting only the test index, signer and workers. Readiness requires
the correct live workers, a complete test index and the funded new Gas sender.
