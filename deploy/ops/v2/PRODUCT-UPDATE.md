# 更新已运行的 v2 部署台并接入独立用户站

`product-v2-update.remote.py.template` 只适用于已运行的 `pinkuang-deploy-v2`，不能用于首次安装，也不能替代包 staging。它不签名或发送链上交易。

先在独立目录构建、校验并 stage 两份不可变包：

- runtime：`/srv/pinkuang-deploy-v2/releases/<runtimeReleaseId>/`，使用现有 `release-manifest.json`。
- product：`/var/www/bemine-v2/releases/<productReleaseId>/public/bemine-v2/`，放置 `NEXT_PUBLIC_BASE_PATH=/bemine-v2` 的完整 Next 静态输出；在 release 根保存 `product-release-manifest.json`，字段包括 `sourceHead`、`artifactDigest`、`basePath` 及每个文件的 `sha256/bytes`，清单本身不包含在 files 中。

计划 JSON 需提供两份 releaseId/sourceHead/manifestSha256、artifactDigest、现场 nginxSha256/deployUnitSha256、旧服务及旧 current 链接的 `legacy` 快照、已实测公共 `logsRpcUrl`。计划的全部值必须来自最终包和新近只读服务器快照。不得用猜测值或删除检查来通过 guard。

首次历史追赶可额外配置 `primaryRpcUrl`（默认官方 `https://bsc-dataseed.bnbchain.org`）、`catchupSeconds`（整数120～1200，默认120）和 `operationId`（独立备份目录名，如 `v2-product-20260928-7b5176a-retry2`）。RPC只接受没有凭据、路径或查询字符串的已审阅公共HTTPS地址。更换主RPC需先测同配置区块读取及双节点规范哈希一致性；最终规范性验证仍独立访问官方RPC，不因更换primary而跳过。延长追赶窗口不改变起始块、确认数、完整性或新鲜度条件。

同一包重试须使用新的 `operationId` 和新的本地输出目录，并刷新只读现场快照；第一次 prepare/activate/rollback 及证据保留。未配置 operationId 时沿用 `<productReleaseId>-product`。备份不会覆盖，回滚脚本还会核对整个计划摘要，不能拿另一次计划恢复本次现场。

```sh
python deploy/ops/v2/render-product-v2-update.py \
  --plan /path/reviewed-plan-input.json \
  --record /path/complete-deployment-record.json \
  --manifest /path/verified-public-manifest.json \
  --out /path/new-review-directory
python deploy/ops/v2/test-product-v2-update.py
```

Renderer 只生成本地 `product-v2-prepare.py`、`product-v2-activate.py`、`product-v2-rollback.py`，不会 SSH。经操作员逐份审阅后才可以通过已批准 SSH 通道执行。`prepare` 只备份现场和保存候选配置；`activate` 才更新现有 v2 服务并增加独立用户站和 index；`rollback` 恢复本次原配置。激活过程的 stdout 为 JSON Lines，含每约10秒一次的索引追赶进度和最终结果；调用程序应逐行读取，不能对整个多行输出直接 `json.loads()`。

必须保留 `/var/lib/pinkuang-deploy-v2/journal.sqlite` 及其 WAL/SHM，绝不能用旧备份回滚这些文件。脚本只读检查未决交易和 inode，更新代码后仍使用同一 private DB；旧 `/bemine/`、旧 deployment/index、芯火服务及其 current 链接保持原样。全部现场字节和产品链接在回滚停止服务前核对；他人修改会阻止自动覆盖。

本次新图（初始化块124453751）使用：

| 角色 | 地址 |
|---|---|
| core Factory | `0x2995B10d19056c8C24C57b281C22562a603C571F` |
| core ShareMarket | `0x347e094BAAB9b74059567A25ab49dFaEA149E734` |
| Budget Factory | `0x07FC0b1118529bA3c7C406058699b9B57Dd9e360` |
| Budget ShareMarket | `0xC6d3860817e8F04b42DA4975319aED32540e8cf8` |
| 旧 Factory | `0xcB24E7F96D81037086A268d6ea63c53f91D412A2` |

可信完整 record 写到 `/var/lib/pinkuang-deploy-v2/trusted-product-deployment.json`；`BEMINE_JOURNAL_FACTORIES` 必须含新两 Factory，`BEMINE_LEGACY_FACTORY` 必须填旧 Factory。须先发布包含创建门禁的新 runtime，不能只给旧 runtime 添加变量。旧工厂 `poolCount=0 / creationPaused=true` 是新建三类项目的条件；不因此关闭已有用户市场、撤单、领取。需要由旧 owner 自己在钱包中签署 `pauseCreation(true)`；本文和发布脚本不代签。

Index 使用独立 `/var/lib/pinkuang-index-v2/index.sqlite`，监听 `127.0.0.1:4181`，两个图都从初始化块开始。脚本默认等待最多120秒，按审阅计划可设至1200秒，每约10秒输出进度、已过时间和总上限；`health 200` 不代表完整，必须同时验证四地址、chain56、起始块、已核验块覆盖、checkedAt、规范区块哈希及近期安全头。没追齐会恢复原配置，已验证索引进度保留供下次从原始图继续，不能改SQL跳过历史。普通 RPC 与日志 RPC 分别配置；2026-09-28 的 Node ethers 只读测试中，`https://bsc-rpc.publicnode.com` 成功返回初始化块日志，官方 dataseed 对相同 `eth_getLogs` 请求报 limit exceeded。每次发布仍需实际健康验收。

公网只增加 `/bemine-v2/`；API通过4174、cookie路径隔离到 `/bemine-v2/api/journal`，不公开4181。成功标记还要求静态首页/public manifest、更新部署台首页和 artifact 精确匹配包哈希，RPC返回chain56，未登录journal返回401。通知默认禁用。

本地故障测试只覆盖配置和模拟回滚，不等于已经完成服务器激活或真实钱包交易验收。部署图、16笔回执和 manifest 的本次只读证据保存在主任务输出目录 `pinkuang-mainnet-readiness-20260928`；这批部署的 artifact 来源字段保持原提交 `8c5598cf44fe8fb6174969eba12b3baa13f7942b`，不因后续网页提交重新标记。
