# d09b25c v2-only compatibility patch

The live v2 runtime observed on 2026-09-29 uses release
`v2-20260929-d09b25c-audit-test`. Its `server/journal-api.mjs` SHA256 is
`68194b6785598cc35bca475f036f9b89f4fb3dab6dfb2114d890dfda6a1466dd`.
Unauthenticated `GET /bemine-v2/api/journal/product-graph` currently returns
401 because this runtime has no public route. The current page needs a verified
genesis graph before it can load. The same old source accepts `list(..., 0)`
as a product intent.

This patch only adds a public, parameter-free, read-only **genesis** graph
response and rejects zero-priced share listings in the server decoder. It
reuses the original v2 trusted 16-step deployment record, original artifact
bundle, and existing on-chain graph verifier. It has no candidate ABI, v4
Factory, signing path, wallet call, or chain transaction. The public proof is
single-flight with a 20-second verified cache and a short failure cooldown;
signing continues through the old verifier and never consumes that cache.

Build a dedicated v2 source commit from the **exact** d09b25c runtime. The
stager accepts only the original journal file bytes and writes two replacement
files to an empty local output directory:

```sh
node deploy/ops/v2/genesis-graph-compat/stage-d09.mjs \
  /path/to/d09b25c/deploy/server/journal-api.mjs /path/to/empty-output
node --test deploy/ops/v2/genesis-graph-compat/genesis-graph-compat.test.mjs
```

Copy those two files into a **new staged v2 runtime release**, retaining the
old bundle, record, Factory allowlist, genesis frontend manifest, index graph,
and databases. Build a release manifest from the actual patched v2 source
commit and immutable package. Then follow the guarded v2 runtime hotfix
process in `deploy/ops/v2/RUNTIME-HOTFIX.md`. Do not use the HEAD v4 runtime
package or overwrite the running release in place.

Before any v2 static page update, check that unauthenticated
`GET /bemine-v2/api/journal/product-graph` returns 200 and is accepted by
the build-pinned v2 genesis validator. Re-check the old product manifest and
Factory identity, and confirm that a 0-priced market `list` intent is rejected
without sending a transaction. A failed graph proof must return 503, not a
fabricated empty or fresh deployment.
