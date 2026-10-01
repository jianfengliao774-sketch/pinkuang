# Formal API query cost audit — 2026-10-02

This is a read-only audit of the running formal services. No worker, timer,
contract, wallet or deployed source was changed during the audit.

## Evidence and limits

Checked the actual systemd MainPID environments, active worker journals, nginx
requests and deployed modules. Environment values were examined privately;
only provider hostnames are recorded here, never RPC keys or credential URLs.
The deployed index server, pool cache, purchase supervisor and mining supervisor
hashes match the corresponding files in the formal fix branch.

Actual running endpoints:

- Index ordinary reads: `bsc-dataseed.bnbchain.org`.
- Index event reads: `bsc-mainnet.nodereal.io`, with a PublicNode fallback.
- Mining and purchase workers: `bsc-mainnet.nodereal.io`.
- Public product RPC proxy: `bsc-dataseed.bnbchain.org`; its scoped fee-history
  event reads use the configured NodeReal logs provider.

Systemd environment files contain both base and override values. MainPID
environments were used to resolve the effective endpoints, rather than assuming
the first file value is active.

Ten-minute worker journal sample: mining completed **78** rounds, average period
**7.72 seconds**, all with the same single pool `mining-active`. Purchase completed
**26** rounds, average period **22.72 seconds**, all with `fundedCount=0`.
These are completed application rounds, not provider billing units.

A separate nginx window 2026-10-01 16:18:02–16:28:02 UTC showed 33 price-JSON
reads, 8 display-pool reads, 7 display-stat reads, 2 notification-capability
reads, 1 display SSE connection and 1 Firsto directory read on the formal site.
All these sampled HTTP responses were 200. Browser HTTP counts do not measure
the independent worker RPC traffic. No NodeReal billing dashboard or per-method
provider meter was available; actual charged requests/CUs and money are unknown.

## Confirmed unnecessary or overly broad query paths

1. **Paid mining worker reads the same state twice in an ordinary active round.**
   `mining-supervisor.mjs` calls `readMiningState`, then for a non-restart state
   calls `runMiningCycle(send:false)`, which calls `readMiningState` again.
   Each active state read includes ten contract getters and a latest header.
   The 78 observed active rounds follow this path. Up to 780 logical contract
   reads in this ten-minute sample are candidates for merging; this is a source
   calculation, not measured charged requests, since provider batching/caching
   can affect accounting. `STOP_COOLDOWN` and `armedAt` are also fetched even
   when the miner is already active. Reuse one current observation for the
   read-only decision; obtain a fresh snapshot when an actual action is needed.

2. **Paid purchase worker polls unrelated running pools.**
   Every round reads Factory poolCount and state of every registered single pool
   before selecting Funded pools. All 26 sampled rounds had no funded candidate.
   Use indexed pool lifecycle changes to maintain candidates; retain a slow
   discovery fallback and current reads for an actual purchase/recovery.

3. **Single-pool display cache refresh grows with all historical users.**
   Every completed capture is followed by a 15-second delay. Capture rescans
   historical local logs, reads public Lens positions and then all pools for
   every discovered account (up to 200), every account's market credit and every
   directory order. Current cache: 1 public pool, 4 account rows and 3 orders.
   The broad ordinary reads currently use the public endpoint, so this is
   avoidable load/latency rather than evidence of current NodeReal charges.
   Separate public state from account state, refresh affected pools/accounts
   after relevant events and keep recently viewed accounts warm. Do not
   continuously refresh every historical account or terminal order.

4. **Fee history repeats overlapping old-range reads.**
   The visible fees pane polls its first history page every 30 seconds. Browser
   history TTL is also 30 seconds. On expiration it starts at the latest
   finalized head and scans up to six 5,000-block windows. Moving heads make the
   exact range cache keys differ even though most of the history overlaps.
   The proxy routes those event reads to NodeReal. Index FeesClaimed once,
   persist old pages and only fetch new blocks; a confirmed claim should
   refresh the newest page. The pane is not polled when unmounted/hidden, but
   multiple visible clients still repeat this work.

5. **Unrelated push events invalidate quote caches.**
   Display SSE sends the same complete topic array for every business revision.
   The frontend increments a global refresh token without topic filtering.
   FirstoMarketBoard and OperatorQuotePicker use that token in their cache
   identity, so an unrelated project/account change can cause another directory
   and market-reference request. Firsto list/reference server caching is only
   3 seconds and, unlike display-detail caching, lacks same-key in-flight
   coalescing. Keep quote freshness independent of unrelated pool revisions;
   share identical pending display requests and use a reasonable shared TTL.
   Firsto is a separate upstream service; this audit does not assert that its
   API is billed under the user's NodeReal account.

## Existing useful protections

Display pools/orders/stats are served from shared server snapshots, not new RPC
reads per visitor. Firsto exact display details have a 30-second cache and
pending-request coalescing. Overview mining estimates reuse quotes for two
minutes. Main page polling pauses while hidden/busy and backs off after failure.
Some 5/15-second frontend timers only check elapsed time or repaint expiry and
do not issue requests on every tick. SSE heartbeats do not query the blockchain.
The index scans incremental blocks rather than starting over on every request.

Prioritize the duplicate paid mining reads, incremental fee history, and paid
purchase candidate selection. Then narrow account/order cache refresh and
topic-based frontend invalidation. Current transaction and unresolved-nonce
reads must stay separate from display-cache freshness.
