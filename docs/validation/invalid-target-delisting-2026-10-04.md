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
