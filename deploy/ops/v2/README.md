# Independent v2 deployment-console activation drafts

These files prepare a separate deployment console at `/pinkuang-deploy-v2/` on loopback port 4174. They do not deploy contracts, expose `/bemine-v2/`, start the v2 chain index, configure notifications, or modify the old application/keeper/current pointers. No SSH transport, private-key path, `.env`, credential or live deployment address is included here.

`render-activation.py` is **local only**. It reads a reviewed staging `plan.json` and a fresh read-only server snapshot, then writes new `prepare-v2.remote.py` and `activate-v2.remote.py` drafts into a new output directory. It never connects to a server or executes these drafts.

```text
python render-activation.py --plan-directory /absolute/stage-plan --snapshot /absolute/nginx-readonly.json --out /absolute/new-activation-plan
```

The staging plan must contain releaseId (`v2-…`), archiveSha256, manifestSha256, sourceHead, sourceCommit and artifactDigest. The read-only snapshot must contain the actual `/etc/nginx/sites-available/bem2075` SHA256, its unique old `/pinkuang-deploy` anchor, checkedAtUtc, old service metadata and current links. Expected metadata includes MainPID, InvocationID, LoadState, ActiveState, SubState, User and Group for `pinkuang-deploy`, `pinkuang-index`, `bem2075-site`, `sparkdraw-keeper` and `sparkdraw-bot`, plus the three legacy current links used by the template. Never substitute guessed values or bypass a changed hash/PID check.

After staging the exact reviewed package, an operator reviews both generated scripts and may send **prepare** through the approved SSH connection. Prepare verifies every release-manifest file, creates only the independent `pinkuang-v2` nologin account, root-owned 0700 backup, v2-owned 0700 data directories, new unit and inactive nginx snippet. It does not start services or insert the include. Code remains root-owned. The rendered service reads no EnvironmentFile, disables notifications and leaves the product factory allowlist empty.

Only after reviewing prepare's result may the operator explicitly run **activate**. Activation rechecks all source/config hashes, old PIDs/InvocationIDs/current links and free port; starts only the new 4174 service; verifies loopback HTML/artifact hashes, BSC chainId, disabled notifications, journal permissions and the authentication boundary. It then inserts exactly one include into the dedicated tapeout HTTPS server, runs `nginx -t` **before reload**, verifies the real local TLS/SNI route, checks the old services again and enables only the new service.

Nginx reload acknowledges its signal before new workers necessarily accept connections. Activation allows at most ten short HTTPS probes for the exact release HTML hash, then runs the complete verification. A transient old-route 404 or a wrong 200 response is never accepted as success. Persistent mismatch still restores the previous configuration and stops the new service.

Unauthenticated `/api/journal/build` must return 401. The script verifies the public artifact file against the release manifest; it never fabricates a signed wallet session. `proxy_cookie_path` is restricted to `/pinkuang-deploy-v2/api/journal`; runtime cookie issuance still requires user-login acceptance. No RPC signature or blockchain transaction is sent.

On failure, rollback restores the original nginx file only if the live file still matches this candidate hash; concurrent edits are never overwritten. It stops only the newly started service and preserves the journal, backup and release. An already active v2 deployment is not treated as a fresh install. The product/index services remain disabled until the new 16-step graph is finalized and verified.

Start/reload attempts are recorded before invoking their commands. If systemd or nginx accepts an operation but its command then fails or times out, rollback still stops the new service and reloads the verified original nginx configuration. Local fault injection exercises the actual activation/rollback code without connecting to a server:

```text
python deploy/ops/v2/test-activation-rollback.py
```

The seven cases cover a partially effective start/reload, an already restored config file, failed config/HTTPS checks, concurrent edits and successful activation. They do not replace the script's actual file, process, TLS and service checks during prepare/activate. Regenerate prepared drafts after changing the template; do not patch generated scripts to bypass their equality checks.

The current operator's local-only driver is `outputs/pinkuang-mainnet-readiness-20260928/execute-v2-activation.py` in that workstation's task outputs, not a repository runtime dependency. That driver defaults to dry run and requires an explicit `--execute` for a chosen phase. Other computers should use their own reviewed SSH transport with strict host-key verification; do not copy workstation credentials into this repository.

Separate journal databases do not provide nonce coordination across two simultaneous callers of the same real wallet. During actual deployment, avoid concurrently sending from that wallet through legacy write routes or other programs. All real-wallet, new-graph, product-index and mobile-wallet acceptance remains a separate step.
For an already-running v2 deployment console, use the separate [product update runbook](PRODUCT-UPDATE.md) and `product-v2-update.remote.py.template`. It preserves the existing signing journal, introduces the independent dual-factory index and `/bemine-v2/`, and requires reviewed immutable package manifests. Do not reuse the first-install activation flow to update a live journal.
# 已运行站点的热修复

已发布用户站和索引后，使用 [RUNTIME-HOTFIX.md](RUNTIME-HOTFIX.md) 更新现有 v2 runtime/index，保留产品目录、journal 和 index 数据库。

只更换产品网页时使用 [PRODUCT-STATIC-UPDATE.md](PRODUCT-STATIC-UPDATE.md)：核验新旧发布包后原子切换静态目录，合约清单必须逐字节相同，无需重启后台或索引。
