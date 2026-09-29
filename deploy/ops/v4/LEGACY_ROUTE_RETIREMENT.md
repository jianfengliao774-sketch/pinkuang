# Retired legacy web routes

On 2026-09-29, `retire-legacy-routes.remote.py --apply` replaced the public v1
deployment console and the v3 deployment console with HTTP 410. It also made
the v1 product and both old test frontends redirect to `/bemine-v2/`, while
their old `/api/` routes and the retired upgrade page's `/api/rpc` return 410.
The v3 deployment service was disabled. The v1 service remains internal until
its notification dependencies are separately retired; the active v2 product,
v2 purchase service, v4 deployment console, and SparkDraw routes were not
changed.

The 2026-09-29 application used the original script. Its backups with suffix
`bak-20260929T064322Z` remain beside the edited nginx files. That version did
not pin the complete source bytes, lock concurrent runs, probe after reload,
or reload restored files on failure; the original run must not be described as
having had those safeguards.

The repository script is now hardened for any future use. A dry run prints the
SHA-256 of each of the three nginx files and the complete proposed diff. Before
`--apply`, independently review the three preimages (including the retained
2026-09-29 backups where relevant) and pass their exact hashes as
`--expected-site-sha256`, `--expected-v3-sha256`, and
`--expected-upgrade-sha256`. Apply requires root, holds an exclusive lock,
checks all three bytes again, and puts private backups under
`/root/pinkuang-legacy-route-retirement/`. It validates nginx, reloads, and
probes the retired routes plus the v2 product (200) and protected v4 console
(401) through local HTTPS. Any failure restores changed files and reloads
the restored configuration. These repository changes have not been applied to
the server.

The original run's manual post-reload probes returned 410 for `/pinkuang-deploy/`,
`/pinkuang-deploy-v3/`, `/bemine/api/rpc`, and
`/pinkuang-upgrade-v2/api/rpc`; 302 for `/bemine/` and both retired test
frontends; and 200 for `/bemine-v2/` and `/pinkuang-deploy-v4/` before
the v4 Basic Auth rule. The hardened probe expects 401 once that rule is active.

Retiring the public v2 console page does not close its shared backend. The
repository v2 product generator and runtime hotfix template now return 410
for the deployment and fresh-activation journal paths while preserving the
product's session, market, budget-queue, and read-only RPC routes. The running
nginx configuration is unchanged until a separate reviewed v2 update applies
those template changes. The v1 services and port 4174 likewise require a
separate operational decision; this script does not stop them.

The v4 deployment console still needs a chosen access-control method before
public release. The v2 Factories remain live while their existing product is
in service; changing their on-chain pause state requires the owner wallet and
is independent of this route retirement.
