# BEMine integrated-v2 部署准备复核（2026-09-28）

本记录是只读准备检查，不是上线或主网交易回执。检查期间没有改动生产服务、签名、广播、发布 Firsto 订单、启用 keeper 或发送通知。后续前后端仍在完善；最终打包应重新固定提交，不能把这里的 C2 通过状态转用于尚未提交的新改动。

## 版本与验证范围

- 当前封存提交 C2：`697f2e337c67a4fc4615737c07ee6d8cc116c177`；合约产物的源码提交：`8c5598cf44fe8fb6174969eba12b3baa13f7942b`。两者不同是源码提交后再封存产物，不是合约来源不明。
- 产物摘要：`0x7617c81d718e2127be6b1878abad81d7a3c8bf9c4f8cb35bf85755e42df049d7`。2026-09-28 02:18:50 UTC 重新计算摘要并逐一比对 71 个源文件哈希，全部一致。
- [PR #29](https://github.com/jianfengliao774-sketch/pinkuang/pull/29) 在 02:14 UTC 仍为 open/draft、未合并；[CI run 36366934885](https://github.com/jianfengliao774-sketch/pinkuang/actions/runs/36366934885) 的 `deployment-console`、`contracts`、`fork` 三个 job 均成功，head 为上述 C2。
- 合约验证仍是[本地记录](contracts-integration-validation-2026-09-28.md)的 482 项合约测试、26 项存储/库门禁、Slither `--fail-medium`，以及块 123728000 的 42 项和块 124308679 的 12 项真实协议 fork。历史 fork 不证明当前某张卖单仍可购买，更不证明未来协议实现不会升级。
- 当前推荐流程是新建 integrated-v2 图。`docs/deployment.md` 中旧八库、多签分离及 `deploy(config)` 是旧脚本流程，不能据此操作本次 16 步单钱包整合部署。统一业务决定见 [INTEGRATION_HANDOFF.md](INTEGRATION_HANDOFF.md)。

## 16 步与合约体积

部署台按编译依赖拓扑生成步骤；本次实际顺序和运行代码长度如下。长度来自当前封存编译模板，应用链接地址/immutable 不改变长度，但实际链上代码仍须逐项核验。

| 步骤 | 部署对象 | runtime bytes | 距 24,576 上限 |
|---|---|---:|---:|
| 1 | PoolFunds | 3,814 | 20,762 |
| 2 | PurchaseValidation | 3,918 | 20,658 |
| 3 | FlexiblePurchase | 13,236 | 11,340 |
| 4 | MiningOperations | 6,040 | 18,536 |
| 5 | RewardAccounting | 4,836 | 19,740 |
| 6 | SaleGovernance | 4,378 | 20,198 |
| 7 | SaleSettlement | 3,127 | 21,449 |
| 8 | ShareCheckpoints | 1,466 | 23,110 |
| 9 | FirstoSale | 5,848 | 18,728 |
| 10 | AtomicDeployment | 21,303 | 3,273 |
| 11 | PoolVault | 24,414 | 162 |
| 12 | PoolFactory | 24,534 | **42** |
| 13 | ShareMarket | 7,146 | 17,430 |
| 14 | BudgetPortfolioFactory | 9,567 | 15,009 |
| 15 | BudgetPortfolioVault | 22,638 | 1,938 |
| 16 | deployIntegratedSingleOwner 初始化两图 | 不单独部署实现 | 同笔全成功或回滚 |

原子图内部另含 Timelock 6,608 bytes、两个 Beacon 各 868 bytes、ERC1967Proxy 模板 163 bytes，以及 core Factory 内新建 Lens 9,101 bytes。FirstoSaleExecutor 的创建代码嵌入出售路径，源码已纳入哈希及 AST 门禁，不是第 17 个初始部署步骤。

Factory 只剩 42 bytes、Vault 只剩 162 bytes，当前满足 EIP-170；后续任何 Solidity 修改都需重编译、重查大小、重新生成产物与 ABI。不能通过改编译器参数或放宽本地代码大小限制维持“通过”。单独部署对象的 initcode 模板也低于 49,152 bytes；最终交易仍由部署台验证链接、构造参数、Gas 和完整初始化模拟。

## 当前 BSC 依赖与旧部署

只读锚点：2026-09-28 **02:17:49 UTC**，BSC 块 **124443386**，hash `0xde44127a3629d86c5d1dba0a90b52d570e2651bc111edb24da70ec287f9a8e84`。所有 `eth_call`、代码和存储槽读取固定在该块；结束后重读块哈希一致。

| 对象 | 本次观测 |
|---|---|
| Firsto V2 `0x33423244F9a5bF81b12B1a018aF6F4e079B97f29` | 实现 `0xe13e1b474dea29543c13caf174ae8c6d599faf46`；schema=2、paused=false、feeEpoch=1、当前及 epoch 费率均 100 bps；factory 为固定官方协议 Factory |
| Firsto proxy codehash | `0xba136f70efd54699acdcbfbbbbcc6671debaa0bc7f88d67e135b6c585db938d3`，与当前采购/出售预检白名单一致 |
| Firsto implementation codehash | `0x743584d511d72470b2911265f7f86e43aa3e5db3d94ba5fd7652905be434d673`，与白名单一致 |
| Mining | 实现 `0xa3dbe873da37cd4e4a13c7cef23a7db6ca60f898`；owner 为零；implementation codehash `0x63b1124d3448fdeb28b163c52142e15a7a464d7ae7d817e51f6c242b62424479` |
| 官方 CircuitMarket | 实现 `0x725771c38361abef7b844729b978c775f7a83dfb`；feeBps=100；implementation codehash `0xf248d94cd28f12edc19c9b15e8f1214d20e08059abf86a9ca8db2149f884382f` |
| TapeOut / Behemoth NFT | 两者仍为同一 Beacon 图；Beacon `0xf8d6d8eb894d6971c8976ad8b4971cbefe028156`，实现 `0x8E1D125Def6d3826C278299273a0760D47626068`，实现 codehash `0x2ea433839e23b3773b7880d6f1807affb0f648ae98760b9a3b6394879665c345` |
| BEM | decimals=8；codehash `0x982ba79538b51e54ee1382f57522098af0635b0f67f2574d393b29ed0958b344` |
| 旧 Factory `0xcB24E7F96D81037086A268d6ea63c53f91D412A2` | poolCount=0，**creationPaused=false**；owner/operator/treasury 均 `0x6F4d78fB59eC938cBAF65b9fc822aD04d00c155E` |
| 旧 Factory / Market 能力 | `machineRegistryStatus()`、`buyerFeeBps()` 均 revert；不具备新版永久登记及买方费接口 |
| 旧 Timelock | getMinDelay=172800 秒；新建图不等于绕过旧地址升级的 48h 流程 |

完整代理、实现、Beacon 与运行代码摘要保存在本次 `chain-current.json`。存在代码不是业务安全证明；转账前还需针对具体 NFT、卖家、授权、nonce、到期、预算和参数重做最新块预检及精确交易模拟。

### 永久唯一与迁移边界

新 core Factory 内永久占用 `(collection, tokenId)`，原目标和实际替代目标均登记；失败、退款、出售不释放。预算子池使用同一个 core Factory，不能另起一份互不知晓的矿机登记。

旧 Factory 目前虽为 0 池，但仍允许创建。上线切换条件是：由旧 owner 钱包执行 `pauseCreation(true)`，确认成功后在同一新快照再次核对 `poolCount=0` 与 `creationPaused=true`，再开放新图运营。此检查未代用户执行；旧 owner 后续仍可撤销暂停，运营必须持续保持旧图停建。仅隐藏按钮、关闭网页、一次历史 0 池快照都不能保证合约层永久唯一。

如果切换前出现旧池，停止直接切换。当前 `migrateMachineRegistry(maxPools)` 只从**同一个 Factory 自己的 allPools**分页回填，并拒绝冲突；不能拿它跨 Factory 导入旧池。现有自动升级证明也仅接受零历史池，不支持拿新版产物套入旧四/五节点升级流程。此时须单独设计并验证历史权益/登记迁移，或继续在旧 Factory 图上经时间锁升级；不能伪称“一键旧地址升级”已准备好。

## 服务器与独立 v2 发布方案

02:14 UTC 只读检查：旧 `pinkuang-deploy.service` 和 `pinkuang-index.service` 正常，分别监听 loopback 4173/4180；芯火主站 8788、keeper、bot 与价格服务正常。旧索引 complete=true 且已追平。生产仍是通知补丁版本 `/srv/pinkuang-deploy/releases/pinkuang-notify-20260927T1605Z` 与 `/var/www/bemine-preview/releases/bemine-notify-20260927T1605Z-r2`，13/13 旧部署记录、摘要 `f48637de…`；线上未使用新版合约图。

建议隔离表（尚未安装/启用）：

| 项目 | v2 值 |
|---|---|
| 部署台公共入口 | `https://tapeout.cc.cd/pinkuang-deploy-v2/` |
| 产品验收入口 | `https://tapeout.cc.cd/bemine-v2/`，前端构建 `NEXT_PUBLIC_BASE_PATH=/bemine-v2` |
| 后端 / 索引 | `127.0.0.1:4174` / `127.0.0.1:4181`，本次检查均未占用 |
| 服务账户 | 新建无登录 `pinkuang-v2`，不共享旧服务用户或密钥目录 |
| 发布目录 | `/srv/pinkuang-deploy-v2/releases/<release-id>`；代码 root 拥有，只读，保存 manifest |
| 持久数据 | `/var/lib/pinkuang-deploy-v2`、`/var/lib/pinkuang-index-v2`、`/var/lib/pinkuang-notifications-v2`；各 0700，文件 0600 |
| systemd | 新 `pinkuang-deploy-v2.service` / `pinkuang-index-v2.service`；UMask=0077、NoNewPrivileges、ProtectSystem=strict、ProtectHome=true，仅允许 v2 数据路径可写 |
| Cookie | 分别重写到 `/pinkuang-deploy-v2/api/journal`、`/bemine-v2/api/journal`；HttpOnly、SameSite=Strict、Secure；不得扩大为 `/` |
| Origin | 精确 `https://tapeout.cc.cd`，不含路径、不设通配 CORS |
| 通知 | 初期明确 `BEMINE_NOTIFICATIONS_ENABLED=0`；不复制旧 token/env/DB，不并行争用同一个 bot 的 webhook/worker。启用须另验新图身份、绑定与收件人 |

已有 SSH helper 为本地 `outputs/pinkuang-deployment-200e544/ops/ssh_ops.py`：固定服务器 `188.166.187.64:22`、用户 root、已知主机密钥 `RejectPolicy`，内部使用已配置 SSH 密钥文件。调用应使用 bundled Python；系统 Python 本次缺少 cryptography。无需用户再次发送私钥，本次未打印或复制私钥内容。

先固定最终源码提交并构建，再运行 `deploy/scripts/package-release.mjs --out <全新绝对路径>`。该工具拒绝未提交的受保护源码、源/产物不匹配、私密文件、符号链接、缺运行依赖；产物 `sourceCommit/sourceHead/artifactDigest` 分别留档。服务器只安装该清单文件，使用 Node.js 24 与 `npm ci --omit=dev --ignore-scripts`。`node server/index.mjs` 为正式入口，不能用 Vite preview 声称生产权限已验收。

部署台可先上线空 v2 journal 供用户部署。合约未部署前不配置伪造的 BEMINE_JOURNAL_FACTORIES/可信记录；产品交易须保持未配置状态。16 笔完成后，由部署页核对 finalized 初始化回执、两个完整图、runtime/链接/immutable/角色，再导出私有可信记录和公开 manifest；v2 索引同时配置 `CHAIN_INDEX_FACTORY/MARKET` 及 `CHAIN_INDEX_PORTFOLIO_FACTORY/MARKET`，起始块为真实初始化块、confirmations=12。只有索引完整追平且图验收通过，产品才开放交易。

独立 Cookie/数据库只隔离会话和记录，**不能跨两进程互斥同钱包 nonce**。旧、新 journal 各自的 SQLite 签名许可锁互不可见；部署窗口同一钱包不得继续通过旧写入口或独立 keeper 发起交易。若要长期同时开放两个图给同一钱包，必须有跨实例通道协调，不能以 Cookie Path 隔离代替。

新 WalletConnect 接入还须验证实际生产 CSP 的精确 WSS relay 域名、浏览器回跳和手机钱包；当前旧部署服务仅 `connect-src 'self' https:`，不能据此保证扫码连接。对新站改 CSP 时保持旧站配置不变。

本次读取另发现 `web/lib/operator-quotes.mjs` 与 `web/lib/share-daily-capacity.mjs` 的 Firsto 报价地址仍写死 `/pinkuang-deploy/firsto-api`。独立产品发布前须改为对应新 base 的报价路由，避免 v2 仍依赖旧部署后台；配置草稿预留 `/bemine-v2/firsto-api/ → 4174/firsto-api/`。

## 上线前实际验收顺序

1. 最终源码提交及 CI/构建通过，重打包并保存哈希；旧源码/通知版本可追溯。先部署独立 v2 后台与 HTTPS 页面，验证 journal build 返回正确摘要、持久目录权限、Cookie 两路径、Origin 拒绝异源和服务重启恢复。
2. 用户连接 BSC 钱包，明确 Gas 总预算，逐笔确认 16 步；未知发送结果必须恢复原 nonce，不自动重新部署。未签名的预算/余额/估算不是已支付证明。
3. 用户执行旧 Factory 停建并重新确认无旧池；检查无旧/新未完成并发签名意图，记录切换块。
4. 导出并核验真实完整图，配置独立索引、可信记录与前端公开清单，完整回填并追平；当前 Firsto 地址/hash/epoch/fee 再核验。
5. 小额两钱包验证：认购、未满额撤回/到期退款、官网购机、Firsto购机、BEM领取、份额双边费、单机及预算成员治理、本站受控 Firsto 成交和 BNB 提款。逐笔保存 NFT、资金和历史 BEM 归属证据；原生 Firsto 网页挂单仍关闭。

本次原始证据在本地 `outputs/pinkuang-mainnet-readiness-20260928/`：`github-current.json`、`artifact-current.json`、`chain-current.json`、`server-current.json`。这些只读结果是上述时点状态，不是持续监控，也不授权自动签名或自动发送资金。

同目录 `V2-PREPARATION.md`、`prepare-v2-local.py`、`execute-v2-stage.py`、`stage-v2.remote.py.template`、两个 systemd 模板及 `nginx-v2.locations.conf` 是独立部署准备草稿。已检查 Python 语法，未执行远程 staging 或 activation。默认执行器只打印计划；显式 staging 也不安装/启动服务、不写 Nginx、不改旧站。待最终源码提交与发布包生成后重新渲染并逐项审阅。
