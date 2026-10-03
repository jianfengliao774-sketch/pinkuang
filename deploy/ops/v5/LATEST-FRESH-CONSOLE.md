# Latest fresh formal deployment console

The user selected a new contract graph on 2026-10-03 instead of upgrading the
existing v5 graph. The fresh console must use an independent journal. The old
v5 journal already contains a completed genesis and must not be reset or reused.

Entry: https://tapeout.cc.cd/pinkuang-deploy-latest/

Reviewed contract artifact digest:
`0xbe37228e94095440e9cde68ae7b5e605b75154a5c7453d58b796ddb2925ec927`

Public roles:

| Role | Address |
| --- | --- |
| Deployer | `0x042B23288E2316DFb6503488292FD0Ad2F811Ae7` |
| Administrator one | `0x7674fa446D42b1f7f150DC5e678cc525d275Ea53` |
| Administrator two | `0xeD2FCBe59EBe1754a3676aeb9CcfBA20f193FcbB` |
| Independent Gas wallet | `0xA285d1933e32b5990625aC1F5BEa205Cf2606619` |

Runtime is isolated under `/srv/pinkuang-deploy-latest/releases/<source-head>`;
service `pinkuang-deploy-latest` listens only on loopback port 4237. Its journal
is `/var/lib/pinkuang-deploy-latest/journal.sqlite`. Session cookies are scoped
to `/pinkuang-deploy-latest/api/journal`, separate from the old console.

The host stays on tapeout.cc.cd because the protected Gas possession attestor
already binds to this origin. No signer configuration or credential is changed.
The browser receives only public addresses and artifacts. Both relay flags
are disabled, so the new console cannot send old-graph operational calls.
Deployment and the seven Authority activation transactions require the user's
deployment wallet. No private key is accepted in the deployment page.

`install-latest-console.py` requires a tar archive and manifest that pin the
source commit, artifact digest, every packaged file, and dependency release.
It checks the artifact using the same canonical digest reader as the server.
Dependencies may be reused only when package-lock.json matches, and the symlink
must point to a resolved immutable release rather than the old `current` link.
The archive must contain the new `.service` and `.conf` files in `ops/v5`.
No existing journal, product worker or signer is overwritten.

Validation before publication: full console suite 1067 passed, one skipped,
zero failed; `build:fresh` succeeded and its allowlist verified 68 files.
The fresh bundle excludes upgrade pages and pinned old genesis records.

After the user completes deployment and activation, independently verify the
new finalized receipts, roles, artifact digest and exported manifest. Then
prepare the new graph's trusted runtime, index, API, signer, purchase and mining
services and republish https://bemine.cc.cd/ against the new graph. A console
publication alone is not a completed on-chain deployment or product cutover.
Keep old contracts and asset recovery records intact.
