# Temporary pause of old and test BEMine versions

Applied on 2026-10-02 at the user's explicit request. The scope includes the old
formal v4 website, all test versions, and old deployment consoles. Retain v5 and
its deployment entry. This is a reversible service pause, not a contract upgrade,
asset migration, cancellation, withdrawal, or deletion.

## Live configuration

Install `bemine-retired-paused.conf` in `/etc/nginx/snippets/` and include it in
the HTTPS servers for `tapeout.cc.cd` and `bemine.cc.cd`. Its server rewrite runs
before location selection, including the old exact API and static-file routes.
The internal 418 is rendered as a 503 maintenance page with `Cache-Control:
no-store`. Place `bemine-paused.html` in `/var/www/bemine-maintenance/`.
The match excludes `/bemine-v5/`, `/pinkuang-deploy-v5/`, and the unrelated
TapeOut root application.

Stopped and disabled:

- `bemine-full-test-activate.path` (the activation service was also stopped)
- `bemine-full-test-{api,index,mining,purchase,signer}.service`
- `pinkuang-deploy-v4.service`
- `pinkuang-product-v4.service`
- `pinkuang-index-v4.service`
- `pinkuang-v4-{mining,purchase}.service`
- `bemine-price.service` (only retired product pages currently consume it)

The `pinkuang-v4-signer` name remains because the v5 console uses its private
socket for the Gas-wallet public-address proof. `zz-paused-attestation.conf`
loads `/etc/pinkuang-v4/paused-attestation.env` **after** the existing runtime
environment files, with exactly:

```ini
AUTHORITY_SIGNER_ATTEST_ONLY=1
AUTHORITY_RELAY_ENABLED=0
```

That existing mode instantiates no transaction relay, receipt polling, reference
publisher, or listing-expiry keeper. The old IPC relay returns 503. Do not stop
this restricted proof service or delete its credential paths while v5 needs it.
The retained console service is `pinkuang-deploy-v5`, port 4217.

## Asset inventory

Read-only verification at BSC block **125314775**,
`0x020fa5d8c53794bfd72fab72aea5816ed2d78fe23549c83d8cc93b0ac8392979`,
2026-10-02 23:16:05 Asia/Shanghai:

| Miner | Current owner / vault | Original version |
| --- | --- | --- |
| TapeOut #12962 | `0xC0EdD7E9Ef4eba0f75Cf85a14F35fe4F7190686e` | v4 |
| TapeOut #16736 | `0x46f679165e475D58e0F64a5c0958130fcAffB047` | full-test |

Both `ownerOf` calls matched their vaults. Collection:
`0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C`. Both vaults were Active, with no
whole-miner listing executed. Full-test also contains the closed historical
vault `0x0d776F099Fe694E07A7509334067b1f92F68Cd0E` for the same #16736; do not
count it as another NFT.

#16736 has proposal #1 and an uncancelled 50-share market order #1 in
`0x8003B8A6e774849C1686C94f1BAccC44b0A1a400`. Share trading was frozen at the
snapshot, but that is not permanent cancellation. A website pause cannot revoke
an on-chain order. Recheck the order before recovering the miner. No cancellation
was submitted as part of this work.

Full holder balances, withdrawal amounts, the proposal deadline, and recovery
instructions are in the user's private recovery note and the protected server
archive, not in this public repository.

## Preservation and selective recovery

Server archive: `/root/bemine-pause-20261002/` (0700).

- `configs-before/`: original nginx configs and service units/drop-ins.
- `service-states-before.json`: original enabled/active states.
- `release-paths.json`: original release symlink targets.
- `old-runtime-state.tar.gz`: old databases, WAL files, and keeper journals after
  stopping their writers. Original files remain in place.
- `chain-inventory.json`: exact public chain snapshot; `RECOVERY.zh-CN.md`:
  detailed private recovery instructions.
- `verification.txt`, `gas-pending-check.json`: operational checks.

Archive SHA-256:
`df791f37b489b01a88020df2fdc98f6375b9b2bd1ac0d48143ecace344bf492b`.
The two original static releases remain at:

- `/var/www/bemine-v4/releases/static-hotfix-d90f5f09cd0a`
- `/var/www/bemine-full-test/releases/static-hotfix-1f3c3809ca44`

To recover later, first re-read current NFT owners, pool states, proposals,
orders, and member balances. Restore only the requested old site/API/index from
its preserved release and database, and narrow the pause rule for that route.
Validate nginx before reload. Do not blindly overwrite newer nginx configs with
the dated backups, reactivate the test `.path`, or restart all senders.
NFTs are owned by their vaults: use the vault's governance/sale route to recover
the whole miner; an administrator cannot directly withdraw the NFT.

Old v4 and v5 use the same Gas account. Before restoring any old transaction
sender, coordinate it with the new nonce journal. The attestation-only override
must not be removed while independent old and new senders would compete.

## Verification

- `nginx -t` passed; live old/test pages, nested APIs, and static routes return
  503 from both localhost routing and public URLs.
- v5 console and the TapeOut root application return 200. v5 read RPC returns
  BSC chain ID `0x38`.
- All listed old services are inactive and disabled; the activation `.path` is
  disabled. No BEMine timer reactivates them.
- Restricted signer flags verified from its actual process environment; old
  IPC relay responds `Authority relay is not active` / 503.
- Both old Gas accounts had equal latest and pending nonces after shutdown.
- All three deployment/product journal DBs and both old index DBs passed SQLite
  `quick_check`. The archive contains both old journals and all 1,520 entries.

## v5 status discovered during this pause

The new console now records **16/16 deployment and 7/7 Authority steps confirmed**.
Public addresses and transaction hashes are in `../v5/mainnet-deployment.json`.
No v5 index/product has been activated yet: `/bemine-v5/` returns 404 on both
domains. Keep this distinction visible; retiring v4 does not complete the new
website launch. The latest live website source commits remain unavailable in
the accessible checkout/remotes; see the v5 runbook.
