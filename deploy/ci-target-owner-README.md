# Fixed target owner upgrade CI scope

The release scope in `.github/workflows/contracts.yml` is explicitly
`target-owner-upgrade`, including after a merge to `main`. It does not choose a
profile from a branch name, artifact mismatch, generated digest or environment
fallback. A future full fresh deployment requires a separate reviewed scope and
Gas plan.

The two independently checked scopes are:

- Current HEAD Solidity is compiled with the pinned compiler and compared with
  the previously approved candidate digest
  `0xc9be5208ec97a0513d29c5f1d35a9e89f54c998b5994d2a291c09e5e496881e5`.
  The mixed formal graph must retain its separate
  `0x01ff90f9a074a6faeb71c452bd8ad36fc0989b143f68fe5240c4d6ece0c538ba`
  review pin. Current upgrade UI, shared, server, keeper and ops regressions run
  against HEAD.
- The retained full-deployment console is compiled and fully tested in an
  isolated checkout of `1486d897331e7a54a08f86d9068f3c2682258adf`. Its Solidity
  inputs must equal artifact source commit
  `6361bff1247e7297b96d2659145a0e7256e6765c`, and its artifact must remain
  `0xbe37228e94095440e9cde68ae7b5e605b75154a5c7453d58b796ddb2925ec927`.
  Its static/synthetic packages and product ABI are verified there. Every
  pre-existing deployment UI and product frontend file, plus dependency locks,
  must be byte-identical to HEAD before these retained tests can substitute for
  HEAD tests that specifically compile the old full-deployment source.

The checked-in generic `deploy/public/deployment-artifacts.json`, generated
product ABI and its measured full-deployment Gas plan stay unchanged. Default
generic build/signing guards still reject the new candidate as a full fresh
deployment. This profile does **not** make that console capable of deploying a
new `c9be` genesis. The separately reviewed wallet entry from commit `9784000`
is the scoped three-implementation Beacon upgrade page, not a new-genesis page.
CI does not rebuild or publish that approved production package.

`target-owner-ci-profile.mjs` writes its compiled HEAD candidate and scope
summary only into a new external evidence directory. The retained checkout has
only three exact dependency mounts in its local Git exclude file; source,
artifacts and manifests remain tracked and source-clean. It never rewrites the
working repository's artifact, genesis, manifest, ABI or Gas plan.

The uploaded `target-owner-scoped-ci-*` evidence keeps the HEAD candidate and
retained synthetic release scopes distinct. Passing these checks does not
attest deployment, scheduling, execution, old-pool owner migration or runtime
activation. Existing source-integrity checks remain mandatory.
