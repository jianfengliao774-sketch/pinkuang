# Fixed-target projects with no remaining sell order

The public fundraising catalog previously hid a fixed-target project only when
the NFT owner changed. Cancelling its listing without changing ownership left
the project open in the catalog, even though its executable daily-capacity price
was unavailable. TapeOut #14281 and #14277 exposed this mismatch.

The background indexer now reads the official market's `listingFor` at the same
verified block as ownership. If there is no valid official listing, it checks
the exact NFT's Firsto detail through the existing loopback display proxy. Only
two successful absence checks produce `target_listing_unavailable`. Wrong
identity/owner, incomplete or malformed orders, unknown status, delivery errors,
old evidence, and inconsistent ask summaries remain unknown. Either valid venue
keeps the project available. Relisting is evaluated again automatically.

Firsto requests are shared per NFT/owner for at most 30 seconds, capped by the
original delivery freshness and order expiry. Official reads are shared at an
exact block. Neither visitor requests nor per-account position reads issue
additional market requests. Active projects, portfolio children, and flexible
purchase reference NFTs are excluded from these delisting checks.

The frontend recognizes the two-source evidence and its explicit `validUntil`,
filters unavailable projects out of the public catalog, and retains exact
project records, participant positions, withdrawal credits, explanations, and
refund actions. Expired or unknown evidence does not mean an empty order book.
Subscription preparation no longer turns a missing-listing result back into
available merely because the owner has not changed.

This is a display and website-action change. It does not change contract state,
cancel projects on chain, sign transactions, or shorten the existing purchase
deadline. Funding participants can withdraw their contribution and then claim
the booked BNB. Funded projects still follow their deployed refund conditions.

Validation: 100 focused backend/frontend tests pass, including two-venue
absence, relisting, unknown evidence, flexible references, expired delivery and
orders, participant withdrawal access, and zero visitor-triggered RPC. Existing
index-server configuration and transport tests also pass. The generated ABI
matches verified unchanged contract sources, and the production static build
passes with the existing V5 manifest unchanged.

## Formal publication and browser verification

Implementation commit `f86aa63a2425b8a9c3c804e48826e9712cc4e249` is deployed on
`https://bemine.cc.cd/`. The index restarted once with the five-file overlay;
the existing database, manifests, signer, purchase/mining services and nginx
were preserved. The public projection contains five funding and two active
projects. The two missing-listing projects are hidden; #1461 and #15191 retain
their previous owner-change delisting. All eleven raw project records and their
detail routes remain accessible.

An initial static candidate missed the fresh build environment. Browser boot
verification detected it, the previous static site was restored, and the
candidate and receipts were preserved. The corrected candidate was checked in
a separate browser before publication, then the formal site was checked again:
valid rows and prices render, #14281/#14277 do not appear in the public catalog,
and #14281's detail shows the delisting notice and existing withdrawal/refund
explanation. No wallet request or chain transaction was sent.

Future V5 builds must use the complete fresh build settings, not just basePath:

```text
NEXT_PUBLIC_BASE_PATH=/bemine-v5
NEXT_PUBLIC_BEMINE_PRODUCT_FAMILY=fresh-v4
NEXT_PUBLIC_V4_MANIFEST_SHA256=0xc1e46426f96b858013c4485461f265021bf5e4c483be8a1591ad7563dcea112d
NEXT_PUBLIC_BEMINE_PUBLIC_ORIGIN=https://bemine.cc.cd
NEXT_PUBLIC_BEMINE_PUBLIC_URL=https://bemine.cc.cd/bemine-v5/
NEXT_PUBLIC_DEPLOY_CONSOLE_URL=https://tapeout.cc.cd/pinkuang-deploy-v5/
```

The compiled `web/public/data/frontend-manifest.json` and exported
`frontend-manifest.v5.json` must use the same reviewed formal manifest. Its raw
byte SHA256 is `e0455e6d40c2bc4bd2d471ce4df222e03edfc6be1a0a529c91da6e9433363f97`;
the canonical manifest digest above is different. The version path remains the
internal assets/API namespace, while browser routes use the canonical root.
Validate actual browser boot and rendered rows as well as static inventories.
