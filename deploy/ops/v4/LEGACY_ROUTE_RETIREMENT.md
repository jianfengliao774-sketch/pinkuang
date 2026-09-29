# Retired legacy web routes

On 2026-09-29, `retire-legacy-routes.remote.py --apply` replaced the public v1
deployment console and the v3 deployment console with HTTP 410. It also made
the v1 product and both old test frontends redirect to `/bemine-v2/`, while
their old `/api/` routes and the retired upgrade page's `/api/rpc` return 410.
The v3 deployment service was disabled. The v1 service remains internal until
its notification dependencies are separately retired; the active v2 product,
v2 purchase service, v4 deployment console, and SparkDraw routes were not
changed.

The script is fail-closed for unexpected nginx layouts, retains timestamped
backups beside each edited file, validates `nginx -t` before reloading, and
restores the backups if validation or reload fails. The first application left
backups with suffix `bak-20260929T064322Z`.

Post-reload probes returned 410 for `/pinkuang-deploy/`,
`/pinkuang-deploy-v3/`, `/bemine/api/rpc`, and
`/pinkuang-upgrade-v2/api/rpc`; 302 for `/bemine/` and both retired test
frontends; and 200 for `/bemine-v2/` and `/pinkuang-deploy-v4/`.

The v4 deployment console still needs a chosen access-control method before
public release. The v2 Factories remain live while their existing product is
in service; changing their on-chain pause state requires the owner wallet and
is independent of this route retirement.
