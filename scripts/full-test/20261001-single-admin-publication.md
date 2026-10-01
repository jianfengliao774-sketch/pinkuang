# Independent full-test deployment: single administrator

The user selected `0x6F4d78fB59eC938cBAF65b9fc822aD04d00c155E` as the deployer and sole administrator. Both ABI-compatible administrator slots contain that same address. The independent test Gas wallet is `0x0C14b1008cFFe78711d65b13C8Ce5ca9B944252C`.

## Published artifacts and preserved deployment

- Contract and frontend build: `ecb663758a4b3fc6481757dae8038c175a0f1bc6`.
- Artifact digest: `0x3d386ce28a1898546697d1ee715b5276104894f781e68b785306eac9cde5338b`.
- Previous digest: `0x3185cc2ec2ce4e21ba80e71b1942a115a52b1673e474dcb8420cdd02aca02ddb`.
- The reuse proof compared all 21 artifact ABIs, all 20 unchanged artifacts and immutable byte offsets. Compiler AST identifiers may change without changing those offsets. Only the not-yet-deployed PlatformAuthority bytecode changed.
- All 16 existing bootstrap receipts and the bootstrap graph passed read-only chain verification before the journal artifact binding was updated. The prior journal and configuration were backed up locally on the server.
- The publication tools sent no transactions. The seven subsequent Authority deployment and role transactions were confirmed in the user's wallet.

## Confirmed Authority activation

Authority: `0x3D32Cdb5BC55b2E4B79256Bd11af01ff536D2c52`.

| Step | Confirmed transaction |
|---|---|
| Deploy Authority | `0x5338f200cbe91c592f8863d6d3070483a53e947a27187248cd0446eab4a2586e` |
| Core operator | `0xfbee5117fb8b940c8107331515c3711aa5eff890b43e53d8361da76ff73746d5` |
| Core treasury | `0x2c741995430c2eb8026ecec8320931252b28e2d524425aced20540b9814e11dc` |
| Budget operator | `0xc23974d9d2c51b78c928fca76a4e06793bcd235a4d9644854ce19140c137c482` |
| Budget treasury | `0x03322e1188cd2d7b5740c8a8f57f0e969923e39be8da743ef65ed907f55a51e4` |
| Core owner | `0xb42fe0133711764bbfd43fa3060b4774bace0c26dfaf0413043acd3b6a6ca147` |
| Budget owner | `0x52d8e13142642d07be251657f29127847563f9f4b3f7052680b1857615316532` |

At finalized block 125118461, both Authority administrator getters returned 155E and the Gas getter returned the independent test sender. No transaction simulation was used for this publication. The Authority gas cap was 6,000,000; its confirmed deployment used 4,330,687 gas.

## Runtime repairs

The deployment reader now uses `/bemine-full-test/api/rpc`; Nginx also serves the prior nested `/bemine-full-test/deploy/api/rpc` route. Both returned HTTP 200 and a finalized block after publication.

The activation provisioner accepts the narrowly named test repair releases in addition to original test releases. The independently built test index manifest validator accepts the single administrator configuration while retaining the Authority/Gas address separation. A regression test normalizes and serializes that complete manifest, rejects different test administrators and address aliases, and confirms the formal validator remains unchanged.

All changes are scoped to the independent full-test deployment. Private keys, RPC credentials, sessions and journal backups are excluded from this report and the repository.
