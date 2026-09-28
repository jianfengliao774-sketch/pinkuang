# 更新已经运行的 v2 用户站后台与索引

`runtime-v2-hotfix.remote.py.template` 适用于 `/bemine-v2/`、`pinkuang-deploy-v2` 和 `pinkuang-index-v2` 均已发布的环境。只更新两个 v2 systemd unit 的运行目录及执行路径、索引日志超时，并在现有产品 nginx snippet 中添加一条精确的公开 BEM 报价映射。它不升级合约、不签名、不发送链上交易。

发布前先提交、构建并 stage 新的不可变 runtime 包。计划中的 `runtimeReleaseId`、`runtimeSourceHead`、`runtimeManifestSha256` 必须来自这份最终包；不能用 TBD、猜测哈希或重标旧包来源。`previousRuntimeReleaseId` 必须对应当前两个服务实际使用的目录。现有 `productReleaseId`、产品清单与源码哈希保持不变，不构建或切换产品 current。

计划还需包括新近现场只读得到的 `deployUnitSha256`、`indexUnitSha256`、`productSnippetSha256`、`nginxSha256`、`trustedRecordSha256`，以及原五个服务加 `bemine-price.service` 的 PID/InvocationID/身份快照、三个旧 current 链接。使用新的 `operationId` 保留每次热修的独立备份和证据。`logsTimeoutMs` 默认12000，仅接受12000～30000的整数；本次日志稳定性修复配置为30000，普通 RPC 仍由代码限制为12000，`TimeoutStopSec=45` 保持不变。`catchupSeconds` 默认120，范围120～1200。

```sh
python deploy/ops/v2/render-runtime-v2-hotfix.py \
  --plan /path/final-reviewed-hotfix-plan.json \
  --manifest /path/existing-verified-public-manifest.json \
  --out /path/new-review-directory
python deploy/ops/v2/test-runtime-v2-hotfix.py
```

Renderer 只生成本地 `runtime-v2-hotfix-prepare.py`、`runtime-v2-hotfix-activate.py`、`runtime-v2-hotfix-rollback.py`。操作员审阅后才执行。prepare 只保存root私有的原文件和候选文件，不停止服务。activate 会优雅停止两个 v2 服务、核对数据库身份后更换候选文件、重新启动并验收；失败恢复原 unit 和 snippet，重新加载 nginx。回滚先检查全部文件、数据库身份、产品链接和旧服务，发现他人修改就拒绝覆盖，不能先停止服务再检查。

两个数据库及其 WAL/SHM 全程保留，不复制、清空、覆盖、恢复旧备份或跳改索引位置。脚本检查 journal 和 index 文件的 inode、所属用户及0600权限，并以只读方式核对 index 元数据绑定的新双 Factory 图。prepare 和停止服务后的切换点要求 journal 没有未决意图；热修上线后若用户开始新操作，后续回滚检查仅核对数据库身份并保留完整内容，不能因新意图而删除或复写记录。现有产品 current、可信部署 record、主站 nginx 文件及旧六个服务不改变。

本次唯一新增 nginx 路由是：

```nginx
location = /bemine-v2/data/bem-price.json {
    alias /var/www/bemine-preview/data/bem-price.json;
    default_type application/json;
    add_header Cache-Control "no-store" always;
    add_header X-Content-Type-Options nosniff always;
}
```

不得映射整个 `data/`，否则可能将旧 Factory 清单带入新页面；也不复制报价静态快照。已有 `bemine-price.service` 持续原子更新该公开 JSON。验收要求本地源和公网报价均为 BSC/BEM/指定两个池、正数有限价格、USDT，并检查更新时间与区块时间不超过120秒。

验收还核对新部署台 HTML/artifact 与包清单精确匹配，现有用户站 HTML/manifest 保持原哈希，未认证 journal 仍为401，RPC为chain56。索引先在受限窗口内追齐，再于90秒内取得至少3次完整、新鲜、规范哈希匹配的快照，且覆盖至少2个不同的 indexedThrough。同步过程中的未完成状态不计成功，但不抹除已核验的完成周期；graph/hash错误立即失败，整个窗口未取得足够完成周期仍回滚。stdout JSON Lines 记录全部样本、未完成/不可用与HTTP503次数。这验证跨多个完成周期可用，不代表整个时段没有503。

本地故障测试使用临时文件和模拟服务调用，不代表远端激活已完成。实际发布后还要运行独立只读验收及浏览器整页检查。
