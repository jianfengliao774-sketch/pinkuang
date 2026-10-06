# BEMine 主网页面接入与测试记录

更新：2026-09-27。采用用户最后确认的方案：保留朋友设计的主页，在现有芯火夺宝服务器接入实际业务；取消 TapeKit 容器部署，不上传 TapeKit，不重部署合约。

## 入口与合约

- 产品页面：<https://tapeout.cc.cd/bemine/>
- 管理员部署记录：<https://tapeout.cc.cd/pinkuang-deploy/>
- 网络：BSC 主网，chainId `56`。
- Factory：`0xcB24E7F96D81037086A268d6ea63c53f91D412A2`
- ShareMarket：`0x0B274eFD3E33139209D1C62512F7e2345F16dD3c`
- 运营地址：`0x6F4d78fB59eC938cBAF65b9fc822aD04d00c155E`
- 初始化区块：`124286242`；既有部署记录为 13/13 完成。
- 合约基线：`200e5444d945e0426228db9502816c282dd4f645`；构建摘要：`0xf48637de6a1c988b92d21347662b724b1ee7d59b09f66aaca9c7fe81b9a3b9ce`。

本次修改网页与后台接入，不改变 Solidity、既有合约地址或编译产物。发布候选通过隔离检查，不等于用户已完成主网资金流程。主网只读检查时工厂池数为 **0**；第一笔建池须由用户连接运营钱包并自行确认。

产品服务于 **2026-09-27 07:56:13 UTC** 首次切换上线。随后 `07:58:20.684 UTC` 的生产只读验收确认索引已追平：`indexedThrough=observedSafeHead=124296799`、`complete=true`、`unknownReason=null`；部署记录仍为 13/13 完成，原站服务正常，本次发布未发送链上交易。后续前端读取修复的发布目录与浏览器验收另记于最终发布证据，不能用首次上线时间替代后续版本验收。

## 同源服务与配置

| 公共路径 | 实际服务 | 用途 |
|---|---|---|
| `/bemine/` | Next 静态导出 | 朋友主页与实际业务界面 |
| `/bemine/data/frontend-manifest.json` | 已核验公开清单 | 固定部署地址与代码摘要 |
| `/bemine/api/journal/*` | `127.0.0.1:4173/api/journal/*` | 钱包登录、持久化意图、签名许可与回执恢复 |
| `/bemine/api/rpc` | `127.0.0.1:4173/api/rpc` | 有方法白名单的只读 RPC |
| `/bemine/api/chain-index/*` | `127.0.0.1:4173/api/chain-index/*` → `127.0.0.1:4180/*` | 矿池、订单和活动索引 |
| `/pinkuang-deploy/` | 原部署台 | 保留已完成部署及恢复记录 |

Nginx 只代理以上前缀，避免占用芯火夺宝原站 `/api`。BEMine 日志响应的 Cookie Path 从 `/api/journal` 重写为 `/bemine/api/journal`；部署台保留原前缀的 Cookie 重写。后台继续验证精确同源 Origin，不增加通配 CORS。

主服务使用 Node.js 24、Linux 私有持久目录；启动真实发布目录的 `server/index.mjs`。索引器为独立服务，启动 `server/chain-index/server.mjs`，只监听 loopback。前端构建指定 `NEXT_PUBLIC_BASE_PATH=/bemine`。

| 环境变量 | 要求 |
|---|---|
| `NODE_ENV` | `production` |
| `HOST` / `PORT` | `127.0.0.1` / `4173` |
| `DEPLOYMENT_JOURNAL_ORIGIN` | `https://tapeout.cc.cd`，不含路径 |
| `DEPLOYMENT_JOURNAL_DB` | 持久 SQLite 文件；父目录权限 0700，服务账户可读写 |
| `DEPLOYMENT_JOURNAL_RPC_URL` | `https://bsc-dataseed.bnbchain.org`，用于签名前检查与回执核对 |
| `BEMINE_JOURNAL_FACTORIES` | 本次 Factory 地址 |
| `BEMINE_DEPLOYMENT_RECORD_PATH` | 服务端私有、完整、已完成的可信部署记录路径 |
| `BEMINE_READ_RPC_URL` | `https://bsc-dataseed.bnbchain.org`；未设时沿用 `DEPLOYMENT_JOURNAL_RPC_URL` |
| `BEMINE_INDEX_URL` | `http://127.0.0.1:4180` |
| `CHAIN_INDEX_RPC_URL` | `https://bsc-dataseed.bnbchain.org`；读取主网区块、合约代码与状态 |
| `CHAIN_INDEX_LOGS_RPC_URL` | `https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3`；NodeReal 官方公开共享端点，单独提供历史 `eth_getLogs`，该公开 key 不是私人凭据 |
| `CHAIN_INDEX_SCAN_RANGE` | `500`；限制日志查询批次的区块跨度，与生产配置及索引器单轮 500 块上限一致 |
| `CHAIN_INDEX_DB` | 独立持久索引数据库 |
| `CHAIN_INDEX_FACTORY` / `CHAIN_INDEX_MARKET` | 上述 Factory / ShareMarket |
| `CHAIN_INDEX_START_BLOCK` | `124286242` |
| `CHAIN_INDEX_CONFIRMATIONS` | `12` |
| `CHAIN_INDEX_HOST` / `CHAIN_INDEX_PORT` | `127.0.0.1` / `4180` |

本次索引器使用**双 RPC**：BNB Chain 官方节点读取区块、代码和合约状态，NodeReal 处理事件日志查询；每轮同步直接核对两个节点的 `eth_chainId=56`。主 RPC 不能据此当作历史日志服务使用。虽然代码允许省略 `CHAIN_INDEX_LOGS_RPC_URL` 并与主 RPC 共用地址，本次部署必须显式填写上述日志节点。

生产最终采用 [NodeReal 官方 API 入门文档](https://docs.nodereal.io/reference/getting-started-with-your-api)列出的公开共享端点和 `CHAIN_INDEX_SCAN_RANGE=500`。历史日志探测及初始化块的三条事件身份核验通过；切换后的 40 秒观察窗口内未记录同步错误，游标推进至 `124293791`，当时距安全链头尚差 `2583` 块。这证明该时段回填可推进，不能替代追平验收或长期可用性验证。500 块配置回归测试通过。

NodeReal 官方说明公开端点按每个 IP 限制为 **2000 CU/分钟**；其 [CU 计费表](https://docs.nodereal.io/docs/compute-units-cus)列出 `eth_getLogs` 每次 **50 CU**。按当前无矿池、追平后每 10 秒一轮、每轮工厂和市场各一次日志查询估算，约 12 次日志查询/分钟，即约 **600 CU/分钟**，另有链 ID 校验等开销；这是对当前代码和空池状态的估算，矿池增加、历史回填、重试及同 IP 其他请求都会提高用量。代码保留失败退避和数据不可用状态。免费配额仍须在真实运行中观察，不能据此保证无条件长期稳定。

Blockmachine 曾通过 500 块实际嵌套 topics 查询（0.542 秒）及初始化三事件核验，但已退出本次生产日志配置。其[公开 RPC 说明](https://blockmachine.io/public-rpc-endpoints)标明免 key 配额为每 IP 每分钟 60 RU，重日志调用消耗更多 RU，且免 key 端点不提供归档访问；一次历史探测成功不能作为持续归档保障。故本次未将它保留为生产日志源。

其他已探测节点的限制保留为排查记录：BlockReq 本次只支持最近 8192 个区块，部署块 `124286242` 已超出该窗口；1RPC 本次能读取该历史部署块，但日志查询跨度限制为 50 个区块。二者不作为本次生产日志配置。

日志服务是否适用，须从实际部署块开始验收历史查询、事件身份、区块跨度限制及追平结果；只通过 `eth_chainId`、最新块或最近区块查询不够。节点的历史窗口与限额可能变化，换源时重新验收。读取受限应保留失败状态，不得把缺失历史视为合法空日志或把起始块改到较新位置绕过回填。

日志的区块哈希逐条与主 RPC 扫描的区块头匹配，区块父哈希须连续，提交前再次检查区块尾部；不一致时不提交该批数据。追平时还对照链上矿池数与订单序号，防止明显遗漏的创建历史被报告为完整。

两个 HTTP 客户端均为 12 秒超时、最多 8 条批处理。关闭 SDK 内部的 429 重试，由同步循环按连续失败次数等待 4、8、16、32、60 秒，后续最多 60 秒；成功后清零，追平期间间隔 1 秒、追平后间隔 10 秒。停服停止排队任务并等待有界的正在进行请求；重复关闭共用一次完成状态。限流、超时、错误网络和批次哈希不一致时，该失败批次不前移游标，不把错误当成空日志或切到其他网络；已提交历史发生重组时，按规范链检查回退后重新扫描。

`/health` 返回 HTTP 200 只表示服务存活，发布验收还须检查 `source.complete=true`、`unknownReason=null` 及已核验区块。追平前业务索引接口返回 503。索引使用 12 块确认深度，不代替产品交易的独立最终回执校验。免费日志节点可能限流，应以健康状态判断当前可用性；更换节点由运营显式配置并重新验证，不自动放宽检查。

可信记录从服务器已有完成日志导出，经只读核验后放入私有运维目录，再配置服务路径。文件须包含 13 个已确认步骤、初始化回执、完整地址与运行代码摘要、通过的检查及匹配当前产物的 artifactDigest。不能使用浏览器任意提交的记录代替，也不能只填一个工厂地址放行；运行账户须能读取该私有文件。公开清单与私有记录分开保存。

每次产品签名前，服务端在固定区块检查编译运行代码、库链接、实现槽、工厂与市场关系、运营权限、时间锁角色，随后检查 nonce、Gas、余额及精确调用模拟。索引未追平、RPC 超时或上游报错应显示数据不可用，不得解释为没有资产。

页面只读部署校验保留 chainId、部署区块、5 个运行代码摘要、8 项部署关系、Lens 版本及读取结束后的规范区块检查。独立代码与关系读取最多并发 4 个；同一 `区块编号:区块哈希` 的页面分支共享正在执行的完整校验，成功后最多缓存 8 个区块身份，缓存命中仍核对网络与规范区块。失败停止发起后续校验，等待已发请求全部结束，再清除失败状态；读取中重组不能写入成功缓存。

页面遇到索引同步窗口 HTTP 502/503/504、索引未完成或过期、`source_changed` 时，等待本轮全部读取结束，间隔 1 秒从头重读整组页面数据，最多 3 轮，避免混合新旧快照。权限错误、合约身份或完整性错误不自动重试；同轮出现这类错误时优先报告。切换页面、矿池或钱包后，旧轮次不能更新当前界面。该重试仅用于只读页面，不包装钱包签名或交易操作。

## 交易记录规则

产品沿用 `/api/journal/market`，记录版本为 `2`，固定目标、操作、calldata、金额、nonce、Gas 上限和 Gas 单价。先持久化，再通过 `/market/arm` 取得一次性许可，之后才请求钱包签名。

`arm` 与 `/market/abandon` 使用数据库事务和 revision 检查：同一意图只能取得一次签名许可；只有从未取得许可且没有发送、恢复或取消历史的准备记录可以清除。丢失许可响应、拒签、发送结果不明均不能靠超时推断可重发。

配置正式 BEMine 可信部署后，旧部署台市场不再接受新建无哈希的 v1 签名意图，提示从产品页面操作。已有 v1 记录及带哈希的历史恢复保留。产品和部署共享同一钱包交易通道；未完成部署阻断新增产品签名，已完成 13/13 部署不再占用业务通道。

业务交易继续按实际外层目标、calldata、金额及最终回执核对；初始化交易的中转兼容不扩展为任意业务交易许可。建池成功还须核对唯一 `PoolCreated` 事件，才返回新 `poolAddress`。

## 验证结果与复现

| 检查 | 结果 | 证明范围 |
|---|---|---|
| Linux 后台基线回归 | 81/81（双 RPC 新增专项前） | 包含日志恢复、并发许可、可信图、代理及索引基础用例 |
| 索引与启动服务专项复跑 | 16/16（原索引 10 + 双 RPC/退避/关闭 6） | 本机 mock RPC 验证分流、错误链、429、超时及幂等关闭；不与基线重叠累计 |
| Linux 完整 web 最终回归 | 133/133（前端脚本 121 + 旧 live API 12） | 同一隔离 Linux QA 目录，mock RPC 与临时数据库；新增整轮读取重试、并发上限、校验共享、失败排空及重组回归 |
| 本机 Anvil 资金回路 | 2/2 | 实际本机 EVM 执行：未满额撤回提现、募集超时退款提现 |
| 主网只读图检查 | 通过，区块 `124292027` | 本次既有地址、代码、实现关系与运营绑定 |

本机资金回路使用当前前端 calldata 构造器与 `productGasLimit`。曾确定性复现旧 `estimate × 120%` 策略在跨时间戳撤回时 Gas 不足；当前采用 `max(ceil(estimate × 120%), estimate + 100000)` 后回归通过，同时保留费用预算及后台最新估算检查。失败记录保留，没有改 Solidity 或跳过失败检查。

完整开发目录安装锁定依赖后，可在 Linux / Node.js 24 复现后台与前端脚本：

```sh
cd deploy
node --test $(find server -name '*.test.mjs' ! -name artifact-digest.test.mjs -print)
node --test server/chain-index/indexer.test.mjs server/chain-index/server.test.mjs
node --test server/artifact-digest.test.mjs
cd ../web
node --test scripts/*.test.mjs server/live-api.test.mjs
node scripts/sync-contracts.mjs --check
NEXT_PUBLIC_BASE_PATH=/bemine pnpm exec next build
```

独立产物编译测试需要完整开发依赖，不能只在精简生产包中运行。Windows 不用于宣称通过 Linux 私有目录权限验收。

本机资金回路脚本和证据位于工作区 `outputs/pinkuang-deployment-200e544/product-live/`。在本次隔离源码根目录的 PowerShell 中复现：

```powershell
& .\deploy\node_modules\.bin\tsx.cmd --test 'C:\Users\Administrator\Documents\流片上链条\outputs\pinkuang-deployment-200e544\product-live\local-business-e2e.mts'
```

脚本顶部为本机绝对路径，迁移机器须先修改源码、依赖与输出路径。它只启动 `127.0.0.1` 的临时 Anvil，使用解锁测试账户，无主网 RPC 或 fork；chainId 56 只用于测试网络守卫。外部矿机、挖矿与市场地址使用本机占位代码，因此 **不证明真实采购、NFT 交割、挖矿、收益或市场结算完成**，也不覆盖真实钱包弹窗。

证据包括 `backend-tests-final.txt`、`web-linux-tests.txt`、`web-linux-result.json`、`web-linux-source-manifest.json`、`mainnet-graph-check.json`、`activation-result.json`、`post-release-check.json`、`local-business-e2e-result.json`、`withdrawDeposit-revert-trace.json`、`本机业务回归与Gas诊断.md`。初版 121/121 的完整日志、结果和文件哈希另存 `web-linux-tests-initial.txt`、`web-linux-result-initial.json`、`web-linux-source-manifest-initial.json`；最终 133/133 使用冻结源码的 136 个文件，运行前后核对哈希，未改正式服务。最终公开服务是否已切换到这一构建，以发布后的页面、清单及服务验收为准。

## 用户首轮主网测试顺序

1. 打开产品页，连接运营钱包并确认 BSC 主网，在「运营工作台」建立测试矿池。核对矿机系列、编号、募集金额、购机上限及截止时间，预览后由用户确认钱包交易；记录新矿池地址和交易哈希。
2. 打开该矿池认购。首轮保持**全池未售满 100 份**，验证资金尚处募集状态，记录钱包确认金额和份额。
3. 在该项目执行「撤回本次项目认购」。确认份额归零、本金进入待领取 BNB；这一步不会直接把本金转回钱包。
4. 执行提现 BNB。确认待领余额归零，钱包收到对应本金；余额对比应单独计入 Gas 支出。
5. 另测募集超时退款时，等待真实链上截止时间，再执行「开启到期退款」和提现；不能提前改时间或把页面倒计时结束当作链上退款成功。

全池认购达到 100 份后的采购单独测试，不混入这轮可撤回流程。采购、实际 NFT 状态、收益归集与领取、份额成交和整机出售需各自验收。

当前已接入运营 `arm/reclaim` 的规范调用，**`start` 所需工作证明尚未接入**。不能据此声称挖矿全流程已经完成，也不提供收益保证。所有主网业务交易均由用户自己在钱包中确认。
