# 待修复：预算子矿池与独立项目目录的完整性计数口径

状态：源码确认的可达前端读取故障，尚未修复。本文不代表已执行真实预算购机，也不代表相关端到端回归已通过。

记录日期：2026-09-28。复核时仓库 HEAD 为 `355d6f58a7edb3e7f060ef5468e38e91e4852294`；涉及的核心目录读取逻辑也存在于本次已发布的前端 `7b5176a` 和后台 `c90c255`。本轮三位小数显示及同步期间 503 重试修复不解决本问题。

## 触发条件和影响

预算项目完成首台子矿机采购后，该子矿池仍属于 core Factory 的永久矿池登记表，但被用户目录接口排除。前端却继续拿全部登记矿池数验证过滤后的独立项目分页，因此在目录最后一页触发 `index_coverage`：`项目分页与同块工厂总数不一致。`

这不是合约采购本身必然失败的证据。问题发生在成功采购后的目录读取；`readPageRound()` 的各主要页面都包含 `catalog: client.readPools(...)`，所以目录失败还会阻断同轮首页、资产、市场等依赖读取结果。交易入口仍须遵守原有最新区块预检与钱包确认，不得因展示故障跳过这些保护。

本次发布阶段的只读样本中，core `poolCount=0`、预算 `portfolioCount=0`，尚无预算子矿池，因此当时不会触发此差异。最近一次用于定位索引卡段的独立内存扫描，在区块 `124463117` 读到两者均为零，证据为主任务输出目录 `pinkuang-mainnet-readiness-20260928/index-stalled-chunk-readonly.json`。这是该固定块的证据，不是对后续链上状态的持续承诺。

## 代码证据

以下行号对应记录时源码；函数名与 SQL/断言为后续定位依据。

| 位置 | 当前行为 |
|---|---|
| `contracts/src/PoolFactory.sol:221`，`_createPool()` | 将每个创建的矿池写入 `isPool` 和 `allPools`；约235行 `allPools.push(pool)`。 |
| `contracts/src/PoolFactory.sol:310`，`poolCount()` | 返回全部 `allPools.length`，并非独立项目数量。 |
| `contracts/src/BudgetPortfolioVault.sol:210`、`:221`，`buyOfficial()` / `buyFirsto()` | 采用已创建的 core 子矿池；`_prepareChild()` 要求其已被 `legacyFactory.isPool(child)` 登记、处于 Funding 且份额为零。预算采购不是在此另造一套不计入 core 的矿池登记表。 |
| `contracts/src/BudgetPortfolioVault.sol:270`，`_finishChild()` | 成功后登记 `childInfo`、`children`，并在约286行发出 `ChildPurchased`。子池不会从 core `allPools` 删除。 |
| `contracts/src/PoolLens.sol:180`，`_snapshot()` | 读取 core Factory 的 `poolCount()` 并返回 `Snapshot.totalPools`。 |
| `web/lib/chain-client.mjs:102` | 将 Lens 的全部登记数作为 `snapshot.totalPools` 暴露给前端。 |
| `deploy/server/chain-index/indexer.mjs:313`、`:349` | 核对 `ChildPurchased` 的子池身份及链上 `childInfo`，再写入 `portfolio_children`。 |
| `deploy/server/chain-index/indexer.mjs:423`，`pools()` | SQL 使用 `WHERE address NOT IN (SELECT address FROM portfolio_children)`，`items` 和 `nextCursor` 均按排除子池后的独立项目集合计算。 |
| `web/lib/live-data.mjs:161`，`readPools()` | 约168–169行用 `cursor + items.length`、`nextCursor` 与 `snapshot.totalPools` 校验分页，混用了过滤后目录与全部登记集合。 |
| `web/lib/live-page.mjs:26`，`readPageRound()` | 每轮均先列入 `catalog`，目录故障会使整轮读取失败。 |

最小代数例子：core 登记一个池，该池被预算项目购入并登记为子池。此时 `R=1`、`C=1`、`S=0`。`/v1/pools?cursor=0` 正确返回 `items=[]`、`nextCursor=null`，Lens 正确返回 `totalPools=1`；当前页尾断言要求 `0 >= 1`，故必然失败。源码已经足以确定这个条件下的结果；本记录没有把该例子冒充为已运行的主网采购测试。

## 修复必须保持的规则

不能删除完整性断言、把 `index_coverage` 当可忽略警告、无条件接受 `nextCursor=null`，也不能把未读到的数据显示为零。不能为了避免报错把子矿池重复显示成独立拼矿项目，造成与预算父项目重复统计。同步、重组或历史缺失仍必须停止提供未验证结果。

需要在同一已确认区块及哈希下统一目录、统计和前端校验口径，建议复用现有统计字段并明确含义：

| 字段 | 含义及约束 |
|---|---|
| `registeredPoolCount`（R） | core Factory 所有已登记矿池，等于同块 `poolCount()`。 |
| `childPoolCount`（C） | 已验证归属预算父项目的不同子池数量，不得重复计入；采用历史登记口径，不能用当前运行中的 `activeChildCount` 替代。 |
| `standalonePoolCount`（S） | 独立项目目录总量，必须满足 `S = R - C`，且 `0 <= C <= R`；`/v1/pools` 的游标及页尾完整性按 S 校验。 |
| `portfolioCount`（P） | 预算父项目数量，等于同块预算 Factory 的 `portfolioCount()`。 |
| `topLevelProjectCount` | 展示项目总量 `S + P`，不将每台子矿机再次当成一个父项目。 |

这些字段目前部分已出现在 `indexer.stats()`（约460、480–483行），但 `/v1/pools` 没有把相同口径完整交给前端。仅增加未验证的 JSON 数字还不够：R/P 应独立匹配链上登记数，C 应由经过验证的父子归属及同块 `childCount()` 一致性证明，不能信任一个未经核对的减数来掩盖遗漏目录行。父子地址、数量及所有页必须绑定同一个 `source.indexedThrough/indexedBlockHash`；跨块更新时从第一页重新读取，不能拼接两个来源的分页。

现有 `_verifyHistoryComplete()`（约175行）已经核对 core/预算登记数、市场订单数及每个预算父项目的 `childCount()`，修复应保留这些检查，并据此补齐目录的独立项目计数语义。不能将部分同步数据库标为 complete。

## 必须补充的回归与验收

1. 零登记池、零预算父项目：完整空目录仍通过；真实 RPC/历史读取失败不能变成“零项目”。
2. 一个预算父项目购入唯一子池：R=1、C=1、S=0、P=1，独立目录为空但合法，预算父项目可读，子矿机只在父项目中出现；首页与资产整轮读取不再抛 `index_coverage`。
3. 独立项目与多个预算子池混合：验证过滤后总量、页面项目数、页尾及下一页游标，同时保留全部 core registry 的链上交叉验证。
4. 多页目录及分页途中发生新的子池采购：同块读取可以完整走完；不同块/哈希必须拒绝拼接并重新读首个完整轮次。
5. 遗漏/重复 `ChildPurchased`、错误父子归属、漏掉独立项目、伪造 C/S 数量、错误 Factory、区块重组、RPC 失败和历史计数不一致：均需失败关闭，不能通过“R-C”表面相等规避验证。
6. 子矿机出售或父项目停止采购后，历史登记与运行中数量仍分开；不得把已售子机重新作为独立目录项目计入。
7. 为核心目录和预算目录提供真实链形状的同块 fixture；再完成一次预算首台采购后的完整目录、首页和资产流程验收。合约购买测试通过或当前零项目页面通过，不能替代该前端流程验收。

在修复并通过这些验证以前，不得将“预算项目首台采购后的目录流程”标记为已验收。本条作为独立未完成项保留；当前发布修复仅覆盖三位金额显示与常规同步期间的只读重试恢复。
