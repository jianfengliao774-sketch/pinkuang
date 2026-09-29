# v4 预创世部署台：移除公网进程的 Gas 凭据

此流程只替换仍未创建项目的 `/pinkuang-deploy-v4/` 部署台，不开放产品、不启用
Authority signer，也不部署合约。执行者先核对下面的前置状态和实际文件 SHA256。
`update-console.remote.py` 会在切换前再次检查这些条件；任一条件变化即停止。

## 1. 在本地形成单一可复核发布包

先将要发布的源码提交，保证 `deploy/src`、`deploy/server`、`deploy/shared`、
`deploy/scripts`、`contracts/src` 和构建配置无未提交改动。发布包工具拒绝未跟踪的运行文件。
以下命令在仓库根目录执行；`RELEASE_ID` 必须是新的 `v4-...` 名称。

```sh
cd deploy
npm ci
npm run artifacts
npm run artifacts:check
npm run build:fresh
node --test scripts/package-fresh-console.test.mjs server/authority-ipc.test.mjs server/authority-relay-api.test.mjs ops/v4/prepare-fresh-cutover.test.mjs
python3 -m unittest ops/v4/test-console-update.py
cd ..
SOURCE_HEAD="$(git rev-parse HEAD)"
RELEASE_ID="v4-audit-$(git rev-parse --short=12 HEAD)"
PACKAGE_DIR="/tmp/${RELEASE_ID}-package"
ARCHIVE="/tmp/${RELEASE_ID}.tar.gz"
node deploy/scripts/package-fresh-console.mjs --out "$PACKAGE_DIR"
COPYFILE_DISABLE=1 tar -C "$PACKAGE_DIR" -czf "$ARCHIVE" dist public server shared scripts src package.json package-lock.json
shasum -a 256 "$ARCHIVE" deploy/ops/v4/update-console.remote.py deploy/ops/v4/activate-console.remote.py
```

在 macOS 上必须禁用 `tar` 的 AppleDouble (`._*`) 元数据，否则远端安全校验会拒绝归档。
本地先用归档校验器检查包内容：

```sh
python3 - "$ARCHIVE" <<'PY'
from pathlib import Path
import runpy
import sys
runpy.run_path('deploy/ops/v4/activate-console.remote.py')['validate_archive'](Path(sys.argv[1]))
PY
```

核对打包输出中的 `sourceHead` 与 `SOURCE_HEAD` 一致，并记录三项哈希。包中只有
公网部署台的静态依赖；`server/authority-signer.mjs`、Gas 私钥、旧版运行材料不在包中。
独立 signer 需要将来另制经审查的产品运行包，不能用本包启动。

## 2. 线上只读前置核验

以下示例先由执行者在私有运维记录中设置 `HOST` 和 `SSH_KEY`；如服务器身份或主机指纹变化，先停止。
不要输出 systemd 单元正文、`/proc` 环境、RPC URL 或凭据文件内容。

```sh
ssh -o BatchMode=yes -i "$SSH_KEY" "root@$HOST" \
  'systemctl is-active pinkuang-deploy-v4.service; sha256sum /etc/systemd/system/pinkuang-deploy-v4.service'
ssh -o BatchMode=yes -i "$SSH_KEY" "root@$HOST" python3 - <<'PY'
import sqlite3
connection = sqlite3.connect('file:/var/lib/pinkuang-deploy-v4/journal.sqlite?mode=ro', uri=True)
for table in ('deployment', 'fresh_activation', 'deployment_archives',
              'market', 'market_abandoned', 'market_signing', 'market_results',
              'budget_queues', 'quotes'):
    print(table, connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
PY
```

必须是 active、九张业务日志表全为零、新 release 不存在；把现场单元 SHA256 作为
`CURRENT_UNIT_SHA256`，不要使用旧笔记里的哈希。再次确认 `AUTHORITY_RELAY_ENABLED=0`、
`BEMINE_FRESH_STAGE2_HOLD=1`；这两项在本次更新后也必须保持。核对 systemd
实际加载的是上述主单元，`NeedDaemonReload=no`，并且没有已加载或磁盘上待加载的
drop-in。脚本会拒绝额外的环境变量、`EnvironmentFile`、`PassEnvironment`、
额外命令和其他凭据注入。可用仅打印布尔值的只读命令核对，避免打印包含 RPC
地址的整个单元。

## 3. 上传、预检与切换

将发布包和 **两个** Python 文件放入 root 专用临时目录：更新脚本在执行同目录
`activate-console.remote.py` 之前会校验其内置 SHA256。上传后还要核对远端三项
SHA256 与本地相同。
先备份当前单元到 root 私有目录，保留原 release 和原归档，不碰旧版服务或密钥文件。

```sh
ssh -o BatchMode=yes -i "$SSH_KEY" "root@$HOST" \
  'install -d -m 0700 /root/pinkuang-v4-stage /root/pinkuang-v4-backup; install -m 0600 /etc/systemd/system/pinkuang-deploy-v4.service /root/pinkuang-v4-backup/pinkuang-deploy-v4.before-update.service'
scp -i "$SSH_KEY" "$ARCHIVE" \
  deploy/ops/v4/update-console.remote.py deploy/ops/v4/activate-console.remote.py \
  "root@$HOST:/root/pinkuang-v4-stage/"
```

远端下面的 `ARCHIVE_SHA256` 与 `CURRENT_UNIT_SHA256` 必须换成刚核对的真实 SHA256，
`NEW_RELEASE_ID` 换成上面的 `RELEASE_ID`。先运行 `--dry-run`；成功后使用完全相同的
参数去掉 `--dry-run` 执行。预检会完成单元变换和全部必要配置校验，不留下新 release。
正式运行再次检查归档、旧单元、空日志，安装依赖，短暂停止
v4 部署台、移除仍存在的旧 `keeper-private-key` 注入、启动新 release，并验证本地及 HTTPS
状态、Stage2 关闭状态和进程没有收到 Gas 凭据。服务停止后、切换单元前，会再查一次
九张业务日志表；若停机前有新写入，则停止切换并恢复原服务。安装依赖若在停服务前失败，
新 release 目录可能已建立；再次尝试相同 release ID 前须只读核对其内容，再由运维人员
明确处理，不要让脚本自动删除未复核的目录。

```sh
python3 /root/pinkuang-v4-stage/update-console.remote.py \
  --archive /root/pinkuang-v4-stage/NEW_RELEASE_ID.tar.gz \
  --archive-sha256 ARCHIVE_SHA256 \
  --release-id NEW_RELEASE_ID \
  --current-release-id CURRENT_RELEASE_ID \
  --current-unit-sha256 CURRENT_UNIT_SHA256 \
  --dry-run
# 预检成功后：仅删除上一行的 --dry-run，再执行一次。
```

脚本成功的终态为：部署台页面、部署产物与部署台 API 对未认证访客均返回 401；经
Basic Auth 的浏览器仍可访问新部署页。环回服务的产品图和 relay 仍返回 503，
`/bemine-v4/` 仍为 404，旧 `/bemine-v2/` 仍可访问。更新前必须已按 README
配置 nginx 访问控制；缺失时脚本会拒绝切换。
`AUTHORITY_RELAY_ENABLED=0` 是刻意禁用，不能因为 signer 草案存在就改为 1。

## 回滚边界

切换脚本若在停止服务之后失败，会自动恢复原单元、原 release 并启动服务。
若原单元仍含旧 Gas 凭据，自动回滚会重新把该凭据加载到公网 v4 进程；若原单元
已移除该凭据，回滚仍须复核实际单元。即使只是 HTTPS 或旧 v2 健康检查短时失败，
也会触发回滚。必须立即核对实际单元、进程的 `CREDENTIALS_DIRECTORY` 状态和
v4 服务可用性，不得把失败运行误记为凭据隔离完成。成功后若发生后续故障，原
release 和事先保存的原单元是回滚点；回滚含私钥的老单元必须作为单独的运维决定，
不能由本发布流程自动执行。不得删除或轮换任何凭据来完成本次预创世部署台更新。

本更新去掉公网 v4 进程的 Gas 私钥，并保留或补入经脚本钉扎核对的原 Gas **公开地址**。
部署页可以显示该地址，但公网进程仍不加载私钥；公开地址本身不构成凭据证明。
Stage2 的 `credentialVerified` 仍为 false，直到私有 signer 的可核验证明完成；
旧 v2 发送者排空与 nonce 核对前，Authority relay、自动购机和产品站保持关闭。

## v4 API 独立限流

公网部署台的页面和 API 都先通过 nginx Basic Auth；API 写入仍必须通过钱包身份验证。可在不改变
旧站或 v4 页面访问控制的前提下，单独给 `/pinkuang-deploy-v4/api/` 加每来源 IP
30 次/秒、突发 60 次的 nginx 限流，超额返回 429。先核对现有 nginx 片段的
SHA256，上传 `limit-console-api.remote.py`，以该哈希执行 `--dry-run`，再用相同
参数正式执行。脚本会备份原片段、检查配置并重载 nginx；若验证失败会恢复原片段。
它不会修改 v2/v3 路由、链上合约或 Gas 凭据。

```sh
sha256sum /etc/nginx/snippets/pinkuang-deploy-v4.conf
python3 /root/pinkuang-v4-stage/limit-console-api.remote.py \
  --current-snippet-sha256 REVIEWED_SHA256 --dry-run
# 预检成功后：仅删除上一行的 --dry-run，再执行一次。
```
