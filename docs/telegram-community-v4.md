# v4 Telegram community announcements

The community worker is optional and disabled by default. It uses the existing private notification database and bot, but keeps its own baseline, lease and `community_announcements` queue. The only allowed destination is `@BEMineCommunity`, chat `-1004492628953`, topic `2`. It sends one photo announcement for a confirmed, open standalone pool created after its first verified baseline. Later state changes edit that same message. Portfolio child pools are excluded by the index's standalone pool directory; budget portfolios have no community template yet.

Enable it only after the v4 notification service and loopback chain index are configured for the same v4 Factory and ShareMarket, and only one process owns the bot webhook and sender. Set these public environment variables on that process:

```dotenv
BEMINE_COMMUNITY_ENABLED=1
BEMINE_COMMUNITY_CHAT_ID=-1004492628953
BEMINE_COMMUNITY_THREAD_ID=2
BEMINE_COMMUNITY_USERNAME=BEMineCommunity
```

The worker uses `BEMINE_NOTIFICATION_PUBLIC_URL` for its same-origin poster and project links. That URL must serve `images/bemine-share-v11-tech.jpg`. The feed at `/v1/community` is reachable on the loopback index only; the public `/api/chain-index` proxy deliberately rejects it. The worker verifies creation events and current pool fields at one confirmed block, checks the prior block anchor and destination identity, and never falls back to the general chat. An invalid pool is skipped and reported as `community_degraded` with `invalidPools`; unrelated verified pools continue. An invalid or stale global source stops the round.

On first start, the worker records the current verified block as its baseline without publishing historical pools. Its scope includes the Factory, market, chat and topic, so a fresh v4 Factory starts a separate baseline. Preserve the database and message IDs across restarts. A Telegram send can succeed just before a process stops and before the receipt is saved, so an uncertain result needs manual inspection before retrying. Disabling `BEMINE_COMMUNITY_ENABLED` pauses community work without deleting its state or changing personal notifications.

Wallet binding now needs confirmation in both places: after `/start`, the private bot shows the full wallet address and asks that Telegram user to confirm it; only then can the authenticated wallet session finish the connection on the site. This prevents merely opening a forwarded link from enabling unsolicited notifications. A user who deliberately confirms someone else's wallet can still opt into that wallet's fixed-template alerts; the bot cannot prove external wallet ownership by itself.
