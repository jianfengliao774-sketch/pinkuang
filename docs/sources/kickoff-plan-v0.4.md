# TapeOut 合伙拼矿机 · GPT 开工计划

- 依据：《TapeOut 合伙拼矿机开发文档 v0.4（修订整合版）》，以下简称「文档」
- 计划日期：2026-09-24
- 用法：本计划不改业务规则，只规定**先做什么、怎么拆、每一步做到什么算完**。业务规则以文档为准；文档没写清的地方，按本计划第 3 节的「默认做法」执行，除非项目方另有指示。

---

## 0. 给 GPT 的总规则（每个任务都适用）

1. **一次只做一张任务卡**（T 编号）。做完按 0.2 的格式交付，然后停下来等验收，不要顺手做下一张。
2. **需求来源只有两份**：文档 + 本计划。二者冲突时以文档为准，并在交付说明里写出冲突点。
3. **遇到下面情况立即停工并报告，不许自己发明规则**：
   - 链上行为和文档或本计划描述不一致
   - 某条规则有两种以上合理实现，而文档和本计划都没指定
   - 必须修改文档 4.2 的费率比例、6.1 的投票规则或第 9 节的权限边界才能继续
4. **协议相关结论必须有证据**：fork 测试或链上交易哈希，不接受「应该是」。
5. **没跑过的测试不报「通过」**：附上 `forge test -vv` 原始输出（或对应工具的原始输出）。
6. **不接触私钥**：部署脚本只从环境变量读取，仓库里不得出现私钥或助记词。
7. 技术栈固定：Solidity 0.8.24、Foundry、OpenZeppelin Contracts / Contracts-Upgradeable 5.x、openzeppelin-foundry-upgrades。不引入其他合约库。

### 0.1 停工报告格式

```
【停工】任务 Tx.y
问题：一句话
证据：测试名 / 交易哈希 / 代码位置
可选方案：A…… B……（各写影响）
我的建议：……
```

### 0.2 每张任务卡的交付格式（沿用文档 12.3）

1. 改了哪些文件，每个文件一句话说明
2. 测试命令和原始输出
3. `forge build --sizes` 输出（仅合约任务）
4. 与文档或本计划的偏差清单（没有就写「无」）
5. 需要项目方决定的问题

---

## 1. 文档分析结论

### 1.1 规则清楚、可以直接实现的部分

| 模块 | 文档位置 | 说明 |
|---|---|---|
| 整数份额认购、撤回、失败退款 | 4.2–4.4、5.3 | 100 份，每份 1%，每地址 1–49 份，只收 BNB |
| 产出分账 1 / 4 / 95 | 5.1–5.4 | 分母固定为 100 份，精度 1e36 |
| 24 小时领取间隔、首次领取不限 | 5.2 | |
| 双过半投票规则 | 6.1 | 投票期 24 小时，每地址 1 票，不可改票 |
| 参考市场价算法 | 6.4 | 链下计算，合约只记录不校验 |
| 前端页面、API、TG 机器人 | 7、8 | |
| 权限边界与升级方式 | 9、13.6 | 工厂用 UUPS，项目用 Beacon，升级经 48 小时时间锁 |
| 测试清单与验收标准 | 10 | |

### 1.2 开工前补查的链上事实（2026-09-24，BSC 主网）

| 事实 | 对开发的影响 |
|---|---|
| BEM 合约**没有** `burn` / `burnFrom` 函数；`0x000000000000000000000000000000000000dEaD` 上已有约 1,826 BEM | 所有「销毁」一律转入 `0x…dEaD`，事件里记录数量 |
| BEM 合约字节码里**有** `mint(address,uint256)` | M0 查清谁有铸币权，写进网站风险提示 |
| PancakeSwap **V2** 的 BEM/WBNB 池几乎是空的（约 0.0032 BEM） | 不能用 V2 Router |
| PancakeSwap **V3** 1% 费率池 `0x28b12792f9d81bd529bc5572434e861c9edbbbc2`：约 1,346 BEM / 121.8 WBNB | 出售 2% 销毁预算换 BEM、自动复投把 BEM 换 BNB，都走 V3 SmartRouter。池子很浅，必须有 `minOut` 和单笔上限 |
| `Mining.claim(key)` 任何人都能调，奖励打给当时的持有人（普通钱包持有时已验证） | 购入前「先把历史矿币领给卖家」可以在同一笔交易里做到 |
| `arm` / `stop` 对非持有人 revert（普通钱包持有时已验证） | 合约作为持有人时是否同样可行，M0 验证 |

### 1.3 文档中的难点和缺口，以及本计划的默认做法

| # | 问题 | 文档位置 | 本计划默认做法 | 项目方需确认吗 |
|---|---|---|---|---|
| 1 | **出售时「先领矿币、再过户」无法靠 CircuitMarket 强制**：ERC-721 转出时不会回调卖方，市场 `buy` 直接转走 NFT，项目合约没有机会在过户前领取 | 2.6、6.2 | 首期出售只走项目合约自己的 `completeSale()`：买家直接向 PoolVault 付款，合约在同一笔交易内完成「领取 → 记账 → 过户 → 记录成交款」。**不在 CircuitMarket 挂单**。如果 M0 发现市场有可用的钩子，再增加市场路径 | **是**：代价是 tapeout.market 上看不到挂单；市场 1% 手续费不产生，成员实得约 96%（文档写的 95% 以市场收费为前提） |
| 2 | ShareMarket 真实托管份额代币后，「托管合约持有」和「权益人仍是卖家」冲突 | 13.1 | **不转移代币**：PoolVault 内记 `lockedShares[seller]`；ShareMarket 只有「锁定 / 解锁 / 成交转移锁定份额」三个权限（由工厂登记）。有效份额 = 余额（含锁定部分），人数和上限计算天然正确 | 否 |
| 3 | 投票快照不能用可委托的 `ERC20Votes` | 13.1、6.1 | 用 OZ `Checkpoints.Trace208` 自建：每个地址一条份额检查点，另加一条「有效成员数」检查点，时钟用时间戳 | 否 |
| 4 | 七日批次 + 份额转让的数据结构没有给出 | 13.3 | 采用本计划 3.3 节的设计 | 否 |
| 5 | PoolVault 功能多，容易超过 24KB 合约体积上限 | — | 从 M1a 起每次交付都附 `forge build --sizes`；超过 22KB 就把出售、批次、检查点逻辑拆成 external library | 否 |
| 6 | 文档写「经 PancakeSwap 换成 BEM」，没指定 V2/V3 | 6.3、13.5 | 用 V3 SmartRouter + 1% 费率池；`executeBurn(minOut, maxIn)` 设单笔上限；复投换币同理 | 否 |
| 7 | 购入时市场手续费由谁付、是否含在标价里未知 | 2.6 | M0 查清；`priceCap` 按实际总支出校验 | 否（M0 给出答案） |
| 8 | `Mining.claim` 在待领为 0 时是否 revert 未知 | 5.1 | 普通 harvest 用 `try/catch`；交割路径调用后必须核对 `pending(key) == 0` 且 `ownerOf == address(this)`，否则整笔回滚 | 否 |
| 9 | 参考价的 qᵢ 要用成交区块当时的状态 | 6.4 | 索引服务必须用归档节点。开发阶段可用 `https://bsc-mainnet.public.blastapi.io`（已验证支持历史状态），生产改用付费归档 RPC | 否 |
| 10 | 购机余款、出售款如果循环写给每个成员，会浪费 gas | 4.4、6.3 | 懒结算：记录「每份应得 BNB」；领取时按用户在购机时点（或挂牌时点）的检查点份额计算，不循环 | 否 |
| 11 | M1 预估 4–6 周，粒度太粗，无法逐步验收 | 11 | 拆成 M1a–M1g 七张任务卡，每张单独验收（见第 4 节） | 否 |
| 12 | 第二期 LoanVault、第三期最优出售 | 13.2、13.7 | 本计划只做首期（到 M5）；只预留 13.4 要求的多资产接口字段，不实现融资 | 否 |

---

## 2. 仓库与工程约定

### 2.1 仓库结构（文档 12.2 加细化）

```
tapeout-pool/
  contracts/
    foundry.toml
    src/
      PoolFactory.sol          # UUPS
      PoolVault.sol            # Beacon 实现
      ShareMarket.sol          # UUPS
      ReinvestRouter.sol       # UUPS
      libraries/               # 体积超限时拆出的 external library
      interfaces/
        ITapeoutMining.sol
        ICircuitMarket.sol
        IPancakeV3SwapRouter.sol
        IPoolVault.sol
    test/
      unit/  fork/  invariant/  utils/
    script/
      Deploy.s.sol             # 部署 Timelock、Beacon、Factory、ShareMarket、Router
      Addresses.sol            # 文档 2.1 的地址常量（人工复核后写死）
  indexer/                     # Ponder
  api/
  keeper/
  web/                         # Next.js + wagmi/viem + RainbowKit
  bot/                         # grammY
  docs/
    M0-report.md  M1a.md …    # 每张任务卡的交付说明
```

### 2.2 foundry.toml 要点

```toml
[profile.default]
solc_version = "0.8.24"
evm_version = "shanghai"      # 保守设置；如需 cancun，先在 fork 上验证
optimizer = true
optimizer_runs = 200
via_ir = false                # 体积或栈深度不够时再评估
ffi = true                    # openzeppelin-foundry-upgrades 需要
ast = true
build_info = true
extra_output = ["storageLayout"]

[rpc_endpoints]
bsc = "${BSC_RPC_URL}"
```

### 2.3 环境变量

| 变量 | 用途 |
|---|---|
| `BSC_RPC_URL` | 支持历史状态的 BSC 节点（fork 测试必需） |
| `FORK_BLOCK` | fork 测试固定区块号，所有人用同一个 |
| `DEPLOYER_PK` | 仅部署脚本使用，不进仓库 |

### 2.4 CI（M1a 起就要有）

`forge fmt --check` → `forge build --sizes` → `forge test`（不含 fork）→ fork 测试（手动或夜间跑）→ `slither .` → 升级存储布局校验。

---

## 3. 关键设计（默认做法的具体方案）

### 3.1 出售：项目合约自带受控成交入口

```
propose(price, refPrice, refAt)       # 买入满 7 天；每成员每 7 天 1 次；同时最多 1 个提案
vote(id, support)                     # 24 小时；按 snapshotTs 的检查点份额和人数
executeSale(id)                       # 双过半达标 → state = Listed；listedAt、price、expiresAt = +7 天；冻结份额转让
completeSale() payable                # 任何人，msg.value == price，nonReentrant：
    1. require Listed && now < expiresAt && ownerOf(circuitId) == this
    2. _harvest(finalHandover = true)  # claim(key)，随后 pending(key) == 0，否则 revert
    3. state = Closed；记录 buyer、saleProceeds = msg.value（先改状态，再做外部调用）
    4. emit RewardSettledBeforeTransfer(...)
    5. circuits.safeTransferFrom(this, buyer, circuitId)
    6. 平台 2% 记给 treasury；销毁预算 2% 记入 burnBudget；
       剩余部分 / 100 = salePerShareWei；尾差单独记录
    7. emit SaleCompleted(...)
cancelExpired()                        # 到期 → Active，解冻转让，需要重新投票
withdrawBnb()                          # 成员按 listedAt 时点的检查点份额 × salePerShareWei 领取
```

- 不调用 `stop`，不授权任何第三方转移矿机。
- `settleSale` 在这条路径里不需要；保留函数名，留给未来的市场路径（文档 6.3）。
- 验收重点：绕过 `completeSale` 转走 NFT 做不到；第 2 步失败时整笔回滚；过户后产生的奖励归买家。

### 3.2 购入：先为卖家领取，再在同一笔交易里买

```
buyFromMarket(listingId)   # Funded，任何人可调
    (seller, circuits, tokenId, price, feeBps, valid) = market.listingView(listingId)
    require valid && circuits == 本项目 && tokenId == 本项目
    total = 按 M0 结论计算（price 或 price + fee）；require total <= priceCap
    try mining.claim(key) {} catch {}      # 历史奖励打给当前持有人（卖家）
    require mining.pending(key) == 0       # 已结清
    market.buy{value: total}(listingId, price)
    require circuits.ownerOf(tokenId) == this
    purchaseCost = total；state = Active；activatedAt = now
    surplusPerShareWei = (totalRaised - purchaseCost) / 100，尾差单独记录

sellToPool()               # directSeller 调用；卖家已 approve 本合约
    claim(key) → 核对 pending == 0 → safeTransferFrom(seller, this, id) → 把 directPrice 记给卖家（pull）或直接 call 转账
```

### 3.3 七日到期批次（文档 13.3 的数据结构）

全局状态：

```
acc                             # 当前每份累计 BEM × 1e36
accEndOf: Checkpoints.Trace224  # key = epoch，value = 该 epoch 结束时的 acc（harvest 时写入）
epochNet[e], epochPaid[e], epochBurned[e]   # e = block.timestamp / 1 days
```

用户状态：

```
debtAcc[u]                      # 上次结算时的 acc
slotEpoch[u][0..7], slotAmt[u][0..7]   # 8 格环形缓存，下标 e % 8
lastClaimAt[u]
```

`_settle(u)`（任何份额变化前、领取前调用；份额取当前检查点值，自上次结算以来保持不变）：

1. 若 `acc == debtAcc[u]` 直接返回。
2. 对 epoch `e` 从 `max(上次结算的 epoch, 当前 epoch − 7)` 遍历到当前 epoch：
   - 该批增量 = `shares × (min(accEndOf(e), acc) − max(debtAcc, accEndOf(e−1))) / 1e36`，向下取整，负数按 0 处理
   - 写入 `slot[e % 8]`；如果格子里原来是更早的 epoch，说明它已过期，直接覆盖
3. 早于「当前 epoch − 7」的部分**不记给用户**，这些 BEM 留在 `epochNet − epochPaid` 中，等 `burnExpired` 销毁。
4. `debtAcc[u] = acc`。

其他规则：

- `claim()`：只领 `slotEpoch >= 当前 epoch − 7` 的格子，逐格累加到 `epochPaid[e]`，然后清零这些格子。
- `burnExpired(e)`：要求 `当前 epoch > e + 7` 且该批未销毁；销毁量 = `epochNet[e] − epochPaid[e]`（包括舍入尾差）；转入 `0x…dEaD`；`bemAccounted` 同步减少。
- `expiryEnabled == false`：跳过批次逻辑，直接累加到 `bemOwed[u]`。
- 必须写的不变量测试：`Σ 已领 + Σ 未过期格子 + Σ 待销毁 + Σ 已销毁 == Σ epochNet`（允许的尾差有明确上界）。

### 3.4 份额、锁定与检查点

- ERC-20，`decimals = 0`，`totalSupply` 在募满后固定为 100。
- 余额变化统一经过 `_update` 钩子，处理顺序固定：
  1. 状态检查：认购、撤回、Active 状态下的转让以外，一律禁止
  2. `_harvest(false)`
  3. `_settle(from)` 和 `_settle(to)`
  4. 写入余额
  5. 校验双方持仓为 0 或 1–49 份
  6. 更新份额检查点和成员数检查点
- `lockedShares[u]` 只限制该部分份额不能被普通转账转出；有效份额 = `balanceOf(u)`（包含锁定部分）。
- ShareMarket 通过 `lock` / `unlock` / `transferLocked(seller, buyer, n)` 操作份额；这些函数只允许工厂登记过的 ShareMarket 调用。

---

## 4. 任务卡

> 预估按一名全职开发者计算。每张卡的「验收」全部满足后才能开下一张。

### M0 协议验证（3–5 天）— **不通过就停，不写业务代码**

**T0.1 初始化仓库**
- 做：按 2.1 建目录；装依赖；配置 foundry.toml 和 CI；`script/Addresses.sol` 写入文档 2.1 的地址（注释里写明「待人工复核」）。
- 验收：`forge build` 通过；CI 在空测试下能跑通。

**T0.2 `test/fork/ProtocolProbe.t.sol`**
- 做：部署 `ProbeHolder`（能接收 ERC-721、能按白名单转发调用），在固定 `FORK_BLOCK` 上找一台正在挖矿的 TapeOut 矿机，用 `vm.prank` 从当时的真实持有人转给 ProbeHolder。逐项回答下表，每项给出测试名和结论：

| # | 问题 | 证明方法 |
|---|---|---|
| Q1 | 合约作为持有人能否调 `arm` / `start` / `stop`（排除 `tx.origin` 限制） | ProbeHolder 转发调用，断言成功；陌生地址调用断言 revert |
| Q2 | `start` 的参数怎么生成；`arm` 到 `start` 的时限 | 参考 tapeout.net 前端 `MineConsole-*.js`、`TapeoutMiner-*.js` 的生成逻辑；在 fork 上完成一次真实的 arm + start |
| Q3 | 在挖的矿机转给合约后是否继续挖 | 转移后 `vm.warp`，`pending(key)` 增长，并能 `claim` 到 ProbeHolder |
| Q4 | 购机实付金额：标价是否含 1% 手续费，由谁承担 | fork 上调 `buy`，对比买方支出、卖方到账、市场收入 |
| Q5 | 卖出后货款怎么到账：直接转账，还是记在 `owed` 里需要 `withdraw` | ProbeHolder 挂单，另一个地址买入，检查余额和 `owed` |
| Q6 | 能否在同一笔交易里强制「先领后过户」 | 买入侧：`claim` 后立刻 `buy`；卖出侧：验证第 3.1 节 `completeSale` 方案可行，并证明 CircuitMarket 挂单路径无法强制结清 |
| Q7 | `claim` 在待领为 0 时是否 revert | 连续调用两次 |
| Q8 | BEM 的 `mint` 权限在谁手里 | 读存储或实现代码，写出结论 |
| Q9 | V3 SmartRouter 用 BNB 买 BEM、用 BEM 换 BNB 是否可行，小额滑点多少 | fork 上各换一笔 |

- 交付：`docs/M0-report.md`，一张结论表（问题｜结论｜证据｜对设计的影响）。
- 验收：Q1–Q9 全部有证据；不能证实的写「未证实」，不许写「通过」。
- **分支决策**：
  - Q1 失败（合约不能开挖）：改为只买已经在挖、且过户后继续挖的矿机，`mine()` 降级为可选功能，报项目方确认。
  - Q3 失败（过户后停挖）：**整个项目停工**，报项目方。
  - Q6 买入侧失败：`buyFromMarket` 下线，只保留卖家直卖 `sellToPool`。

### M1 合约（约 5–6 周，拆成 7 张卡）

**T1a 骨架、份额与退款（约 1 周）**
- 做：TimelockController、UpgradeableBeacon、PoolFactory（UUPS）、PoolVault（ERC-7201 存储）；状态机；`deposit(uint8 shares)`、`withdrawDeposit`、`finalizeFailure`、`withdrawBnb`（退款部分）；份额检查点和成员数检查点；文档 4.5 的事件和 4.6 的错误。
- 验收：文档 10.2「认购」「失败退款」两行全部通过；不变量 `Σ 份额 == totalSupply` 与 `Funding 阶段 totalRaised == totalSupply × unitPriceWei`；工厂拒绝不能被 100 整除的募集目标。

**T1b 购机（3–4 天）**
- 做：第 3.2 节的 `buyFromMarket`、`sellToPool`、`onERC721Received`、购机余款懒结算。
- 验收：10.2「购机」一行；fork 上完成一次真实市场购入，事件显示卖家历史矿币在过户前已经结清。

**T1c 挖矿与分账（约 1 周）**
- 做：`mine(bytes)`（selector 白名单，并校验 circuits / circuitId）、`_harvest`、第 3.3 节批次、`claim`、`burnExpired`、`expiryEnabled` 关闭时的路径、销毁转入 `0x…dEaD`。
- 验收：10.2「分账」「权限」两行；文档 5.4 样例精确相等；10.3 第 2 条 BEM 守恒不变量；fork 上 `harvest` 真实领到 BEM。

**T1d 份额转让与 ShareMarket（约 1 周）**
- 做：第 3.4 节 `_update` 流程；ShareMarket 的 `list` / `fill` / `cancel`，手续费 1% 从卖家收入扣；工厂登记 ShareMarket。
- 验收：转让前后收益归属正确，且不重置七日期限；挂单份额仍计入卖家的人数和份额；借锁定绕过 49 份上限的尝试全部 revert；Listed 状态下份额单无法成交。

**T1e 投票与出售（约 1 周）**
- 做：第 3.1 节全部函数；`burnBudget` + `executeBurn(minOut, maxIn)`（V3 SmartRouter，换得的 BEM 转入 `0x…dEaD`）。
- 验收：10.2「投票」「出售」两行；fork 上跑完文档 10.1 第 4 条完整闭环；证明直接转走 NFT 或最终领取失败时成交不会发生。

**T1f 结转与自动复投（3–4 天）**
- 做：`rollover(toPool, shares)`；ReinvestRouter（UUPS）；PoolVault 的 `claimFor(user)`（仅限已授权的 Router）。
- 验收：只动用户自己已归属的 BNB；不足 1 份不认购；剩余资金用户可随时取回；平台不能替用户开启复投。

**T1g 加固（3–4 天）**
- 做：补齐 10.3 全部不变量；Slither 处理；升级存储布局校验；覆盖率报告。
- 验收：文档 10.4 前两条（行覆盖 ≥ 95%、分支覆盖 ≥ 90%、Slither 无未处理的 High/Medium）；所有合约低于 24KB。

### M2 索引与 API（1 周，T1a 接口定稿后可并行）

- **T2.1** 用 Ponder 索引工厂和所有 PoolVault 事件，以及 Mining 的 `Started` / `Stopped` / `Revoked` / `Demoted`、市场的 `Sold`、两个代理的 `Upgraded`、时间锁的 `CallScheduled`。
- **T2.2** 实现文档 8.2 的六个 REST 接口；参考价按 6.4 节计算（需要归档节点）。
- **T2.3** keeper：每小时 `harvest`，到期批次触发 `burnExpired`。
- 验收：任选一个 fork 或主网项目，公开记录逐笔与链上一致。

### M3 网站（3 周）

- **T3.1** 钱包连接、链 ID 校验、`simulateContract` 预演、错误码翻译成中文。
- **T3.2** 项目大厅、矿机详情、认购弹窗（只能选整数份数）。
- **T3.3** 我的矿机（分批到期倒计时）、领取中心。
- **T3.4** 共同决策页、出售页（`completeSale` 买家入口）、公开记录和 CSV 导出。
- **T3.5** 份额二级市场页、复投设置、升级公示栏、运营后台。
- 验收：在手机钱包内置浏览器里走完一次闭环；页面不出现「年化」「回本」字样。

### M4 TG 机器人（3–5 天）

- **T4.1** SIWE 验证、每个项目一个私有群、一次性邀请链接、每日复核移出无份额成员、文档 8.3 的全部提醒。
- 验收：非成员拿不到邀请链接。

### M5 审计与主网试运行（2–3 周）

- **T5.1** 提交审计材料：文档、本计划、M0 报告、测试和覆盖率。
- **T5.2** 按文档 10.4 第 3 条做主网小额试运行，并逐笔对账。

---

## 5. 文档章节与任务对照

| 文档章节 | 任务 |
|---|---|
| 2.6 待核实 | T0.2 |
| 4.1–4.4 状态、参数、认购 | T1a |
| 4.4 购机、3.2 | T1b |
| 5、13.3 分账与七日批次 | T1c |
| 13.1 份额转让、ShareMarket | T1d |
| 6 出售、3.1 | T1e |
| 13.5 结转复投 | T1f |
| 9、10.3、10.4、13.6 | T1g（贯穿全程） |
| 8.1–8.2、6.4 | M2 |
| 7 | M3 |
| 8.3 | M4 |
| 9.4、10.4 | M5 |
| 13.2 LoanVault、13.7 M6/M7 | **本计划不做** |

---

## 6. 可以直接发给 GPT 的提示词

### 6.1 第一次（M0）

```
你是这个项目的合约与全栈实现方。附件是《开发文档 v0.4》和《GPT 开工计划》。
请严格按开工计划第 0 节的总规则工作。

本次只做任务卡 T0.1 和 T0.2（见开工计划第 4 节 M0），不要写任何业务合约。
要求：
- fork 测试固定在同一个区块号，并在报告里写明
- 逐项回答 Q1–Q9，每项附测试名或交易哈希；无法证实的写「未证实」
- 按开工计划 0.2 的格式交付，最后给出 docs/M0-report.md 全文
- 遇到开工计划 0 第 3 条列出的情况，按 0.1 的格式停工报告
```

### 6.2 后续每张卡通用

```
M0 结论已验收（附 docs/M0-report.md）。本次只做任务卡 T1x，范围和验收标准见开工计划第 4 节。
开工前先复述：本卡要实现的函数清单、要通过的测试清单、你认为不清楚的地方。
等我确认后再写代码。交付按开工计划 0.2 的格式。
```

---

## 7. 开工前请项目方拍板（GPT 不能替你决定）

1. **出售路径**：首期是否接受「只在项目合约内成交、不在 tapeout.market 挂单」（第 1.3 节第 1 条）？接受的话，成员实得约为成交价的 96%（没有市场 1% 手续费）。
2. **「至少 3 人」**：确认按钱包地址计算（文档默认）。
3. **购机路径**：市场购入和卖家直卖是否都要（文档默认都要）。
4. **BEM 的 `mint` 权限**：M0 查清后，是否需要在网站风险提示里写明。
