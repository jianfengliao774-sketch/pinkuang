# pinkuang 代码审计问题表

- 仓库：https://github.com/jianfengliao774-sketch/pinkuang（审计分支 `codex/t1e-voting-sale`，提交 `6879557`，包含 M0–T1e 全部代码）
- 审计日期：2026-09-24；依据：开发文档 v0.4、GPT 开工计划
- 方法：人工逐行审阅 11 个合约与库；本地 Foundry 1.7.1 复现测试；BSC 主网 eth_call 状态覆盖与固定区块 123728000 的 fork 测试

## 问题清单（按严重度排序）

| 编号 | 严重度 | 问题 | 位置 | 影响 | 证据 | 修复建议 | 谁来决定 |
|---|---|---|---|---|---|---|---|
| 1 | 阻塞上线（未完成） | 整机出售与退出流程还没写 | PoolVault.sol：缺 executeSale / completeSale / cancelExpired / settleSale / executeBurn；Listed、Closed 状态到不了 | 矿机买进来以后，成员除了在二级市场把份额卖给别人，没有任何退出方式；出售款分配、2% 销毁预算都没有 | docs/M1e.md「尚待明确的出售渠道」：实现方在等你确认 | 先由你确认「首期只在项目合约内 completeSale 成交」，GPT 再完成 T1e。完成前不能部署主网 | 项目方（你） |
| 2 | 中 | 矿机被链上举证撤销后，池子永久卡死 | PoolVault._update 第 501 行 _harvest(true)；MiningOperations.claimReward 第 60–87 行（严格模式） | 真实 Mining 对状态不是「挖矿中」的矿机，claim 一律 revert（错误码 0x5f9bb3be）。严格模式把它当成失败：份额转让、二级市场成交永久失败；计划中的 completeSale 也用严格模式，矿机永远卖不掉。已记账的 BEM 仍能领取 | 主网 eth_call 状态覆盖实测（状态 0/2/3 全部 revert）；fork 测试 poc/AuditRevokedFork.t.sol；单元测试 poc/AuditFindings.t.sol 第 1 项 | 严格模式增加分支：getMiner(key).status != 1 且 pending(key) == 0 时视为「没有可结清收益」，允许过户；completeSale 用同样规则；补充撤销、冷静期场景测试 | GPT 修复 |
| 3 | 中 | 1 份持有人可以长期占住唯一的提案位，阻止出售 | SaleGovernance.propose 第 56–71 行 | 冷却按地址算，同时只允许 1 个提案，也不能提前否决。攻击者把 1 份在 7 个地址之间轮转，每次在上一个提案到期的区块抢先提交一个离谱报价，诚实成员始终发不出真正的出售提案 | 单元测试 poc/AuditFindings.t.sol 第 2 项：连续 14 天占住提案位 | 可选组合：①发起提案要求快照持有 ≥5 份；②反对票（人数和份额）已过半时提案立即失效；③允许多个提案并行；④冷却按份额而不是按地址计。属于修改文档 6.1 投票规则，需你批准 | 项目方（你）定规则 → GPT 实现 |
| 4 | 中 | PoolVault 合约体积余量不足 | PoolVault 运行时 21,483 字节 / 上限 24,576 字节（只剩 3,093 字节） | 出售、销毁、结转复投还没加进来，加完大概率超过 EIP-170 上限，合约无法部署 | forge build --sizes（Foundry 1.7.1 本地实测） | 按开工计划 1.3 第 5 条，把出售和复投逻辑拆到 external library；每次交付附 sizes 结果 | GPT 修复 |
| 5 | 低 | 份额可以转给项目合约自身，转进去就永久卡死 | PoolVault._update 第 497 行（只拦截了市场地址） | 误转的份额永远转不出来；这部分的 BEM 收益和出售款没人能领；池合约还会被算成一个投票成员，抬高人数门槛 | 单元测试 poc/AuditFindings.t.sol 第 3 项 | _update 中拒绝 to == address(this)（建议同时拒绝工厂地址） | GPT 修复 |
| 6 | 低 | 恶意「占位后撤资」可以让募集失败 | PoolVault.withdrawDeposit 第 130 行 | 攻击者用 2 个地址占掉 98 份，截止前全部撤回，项目募集失败；成本只是暂时占用资金，可以反复针对每个项目 | 代码阅读 | 截止前 24 小时内禁止撤回，或收取少量撤回费 | 项目方（你） |
| 7 | 低 | 创建项目时截止时间没有上限 | PoolFactory._validateParams 第 184–196 行 | 运营热钱包可以设置很长的募集或购机截止期。募满后到购机截止前，出资人的钱不能取回 | 代码阅读 | 限制 purchaseDeadline ≤ fundingDeadline + 72 小时（文档建议值），fundingDeadline ≤ 创建时 + 30 天 | GPT 修复（期限数值由你定） |
| 8 | 低 | 人数票的分母是「全体成员」，出售可能永远凑不够人数 | SaleGovernance.passed 第 111 行 | 份额可以转让后，成员最多可达 100 个地址，不投票的地址也算在分母里，出售可能一直达不到人数过半 | 规则分析（文档 6.1 原文就是这样规定的） | 决定是否保留；或改成「投票者人数过半 + 全体份额过半」 | 项目方（你） |
| 9 | 低 | 任何合约都能用官方 Beacon 部署「山寨池」 | PoolVault.initialize 第 91 行 | initialize 只检查调用者等于传入的 factory 地址，任何合约都能部署和官方代码完全相同的池，自己充当运营方和市场，可以拿来钓鱼 | 代码阅读 | 实现合约构造时写死官方工厂地址，initialize 只接受该工厂；网站和索引只展示 isPool 为 true 的池 | GPT 修复 |
| 10 | 低 | 缺少部署脚本 | contracts/script/ 目录下只有 Addresses.sol | 部署过程无法复现；如果代理先部署、后初始化，初始化可能被别人抢先调用 | 仓库检查 | 补写 Deploy.s.sol：代理部署和 initialize 在同一笔交易完成，并校验 Beacon、时间锁、工厂之间的关联 | GPT 修复 |
| 11 | 低 | 单元测试用的 Mining 模拟合约和真实协议不一致 | test/utils/PurchaseMocks.sol 中 PurchaseMockMining.claim 第 156 行 | 模拟合约在矿机非挖矿状态下照样能 claim，所以 196 项测试没有发现第 2 项问题 | 和主网状态覆盖实测结果对比 | 模拟合约的 claim 在 status != 1 时 revert（错误码 0x5f9bb3be），补充撤销、冷静期测试 | GPT 修复 |
| 12 | 信息 | 从市场购入时，成交价会被卖家推到 priceCap | buyFromMarket（任何人都能调用） | 卖家知道池子已募满，会按 priceCap 挂单并自己立刻触发成交 | 代码阅读 | 运营按可接受的真实成交价设置 priceCap，不留余量 | 运营注意 |
| 13 | 信息 | 合约只检查矿机「在挖」，不检查「已验证」和门数上限 | PurchaseValidation._activeMinerKey 第 71–76 行 | 可能买到只能分全网 1% 未验证池收益的矿机 | 代码阅读 | 运营上架前核查（文档 9.3），或在链上要求 verifWeight > 0 | 运营注意 / 可选修复 |
| 14 | 信息 | 不拦截零价格挂单和零价格提案 | ShareMarket.list、SaleGovernance.propose | 手误可能按 0 价卖出份额，或发起 0 价的出售提案 | 代码阅读（实现方在 M1d 已说明） | 网站做强提示，或在合约里设价格下限 | 可选 |
| 15 | 信息 | 所有池的份额代币都叫 TapeOut Pool Share（TPS） | PoolVault.initialize 第 97 行 | 钱包里分不清持有的是哪台矿机的份额 | 代码阅读 | 名称里带上矿机编号，比如 TapeOut #16210 Share | 可选 |
| 16 | 信息 | 整数尾差永久留在合约里 | surplusRemainder、关闭到期模式下的 BEM 分数余数 | 金额极小（每个池不到 100 wei，每人不到 1 个 BEM 最小单位），但没有回收路径 | 代码阅读 | 可以接受；或在项目结束后允许 treasury 回收 | 可选 |
| 17 | 信息 | 开发文档有几处和链上实测不一致，需要更新 v0.4 | docs/M0-report.md | 停挖冷却是 1200 个区块，不是 1200 秒；arm 到 start 的窗口是 1–64 个区块；Mining 的 owner=0 且已封存，不能再升级；市场 1% 手续费由卖家承担 | M0 fork 证据 | 按实测结果更新开发文档第 2 节 | 项目方（你） |
| 18 | 进度 | T1e 后半、T1f、T1g、M2–M5 都还没开始；7 个 PR 全部未合并 | main 分支只有初始化提交；代码都在 codex/t0-1 … t1e 这几个叠加分支上 | 网站、索引、keeper、机器人目录都是空的 | 仓库检查 | 按顺序评审并合并 PR #1–#7；确认出售渠道后继续开发 | 项目方（你） |

## 已核实无问题的部分

- **购机「先领后买」原子性**：正确：先为卖家 claim 并核对到账与 pending 清零，再 buy / safeTransferFrom，任一步失败整笔回滚（M0 已在 fork 上证明）
- **收益分账 1/4/95 与七日批次**：逐段推演正确：转让前先严格收矿再结算双方；批次缓存覆盖不会丢失待销毁负债；过期销毁只烧 net-paid
- **投票快照**：正确：按提案前一秒的份额与人数检查点；锁定挂单的份额仍归卖家；卖出后旧快照仍然有效，不能重复投票
- **权限与升级**：正确：工厂/市场 UUPS、池 Beacon，升级只能走 48 小时时间锁；Beacon 所有权不可转移；operator 不能停挖或动资产
- **ERC-7201 存储槽**：5 个命名空间常量全部核对正确
- **测试复现**：本地 Foundry 1.7.1 复现 196 项单元/不变量测试全部通过；另加 4 项审计复现测试也通过（证明问题 2、3、5 存在）
- **工程安全**：CI 权限最小（contents: read），仓库无私钥或助记词

## 复现测试（给 GPT）

1. `poc/AuditFindings.t.sol` 放到 `contracts/test/unit/`，运行：`forge test --root contracts --match-contract AuditFindingsTest -vv`（3 项：问题 2、3、5）
2. `poc/AuditRevokedFork.t.sol` 放到 `contracts/test/fork/`，运行：`forge test --root contracts --match-contract AuditRevokedForkTest --fork-url https://bsc-mainnet.public.blastapi.io --fork-block-number 123728000 --compute-units-per-second 50 -vv`（问题 2，使用真实 Mining 合约，只把矿机状态字节改成 2 = 已撤销）

这些测试现在都「通过」，意思是问题可以复现。修复后应改为断言修复后的行为（例如撤销后允许过户），不要删除测试。

## 给 GPT 的修复顺序建议

1. 等项目方确认出售渠道和第 3、6、8 项规则后，再动 T1e 出售部分。
2. 先修第 2、5、9、11 项（不涉及业务规则），同时处理第 4 项体积问题。
3. 补齐第 10 项部署脚本，再继续 T1f。