# 2026-09-26 审计整改与业务规则更新

后续规则覆盖：用户已明确取消 24 小时领取限制并开放代领，详见[无冷却代领说明](permissionless-claims.md)。下文的领取间隔、源码清单和测试数量保留为本轮整改提交的历史证据。

本轮实现提交为 `5c286ad4beaf3a0c002a0724d7ea5d994db63f7a`，后续提交包含旧测试预期修正、验证记录与产物来源信息。

本报告覆盖 PR #8（`codex/deploy-console`）对外部审阅意见的整改。所有验证均为本地测试、隔离 Anvil 或 CI；没有使用真实私钥或部署主网。测试通过不是资产安全保证。此前报告的代码行号、哈希和通过数量只适用于其当时版本。

## 已确认的规则

- 保留单钱包部署及至少 48 小时的升级时间锁，不切换多签。该私钥仍能提议升级全部池子与份额市场，时间锁不保证成员能在升级前退出。
- 取消本项目的挖矿收益销毁、到期收益销毁、整机出售预算换币销毁。挖矿收益扣除原有 1% 平台费后归持有人；整机出售扣除原有 2% 平台费后归持有人。份额市场成交费仍为 1%。除整数取整外，对应比例为 99%、98%、99%。已发生的历史销毁无法恢复。
- 已入账收益永久保留。`claim()` 只结算和支付已入账权益，不再要求外部 Mining claim 成功；新收益仍需 harvest 入账，原每日领取间隔保留。
- 不增加紧急出售。矿机转让、份额转让和份额市场成交继续要求严格结清旧挖矿收益。外部协议故障可能长时间阻塞这些操作，这是项目方明确保留的边界。
- 整机零价提案禁止。价格不低于实际链上购机成本时，沿用份额与持有人地址数双过半；低于购机成本须至少 60/100 份赞成，同时保留地址数过半。门槛比较的是出售总价，平价出售扣费后成员净收仍低于购机成本，不代表保本。`refPrice` 只作披露，不影响价格门槛。地址数不等于独立自然人数，拆分地址的身份问题没有被描述为已消除。

## 逐项整改

| 外部意见 | 处理和边界 |
| --- | --- |
| 替代/原矿机卖家可拿走 110% 募资 | 前端总价 cap 改为参考价 P，链上要求 cap ≤ P；建池从参考 NFT 锁定真实验证权重 H₀。每台原矿机或替代机价格还须 ≤ floor(P × H / H₀)，且不超 cap。降低最低准入权重不改变 H₀。购前、卖方 claim 后、收到 NFT 后均检查。高权重矿机也不能突破总价 cap。 |
| 原目标撤单/改价后操纵替代通道 | 原目标优先检查同时应用质量、型号和上述双重限价；只有原目标不再满足条件才准替代。替代入口保持 permissionless，但每次实际交易受链上规则约束。参考价格本身不是可信预言机，仍需出资人审查建池报价。 |
| 销毁兑换被夹 | 已取消兑换与销毁业务，因此没有引入 TWAP 或新的交易路由。旧函数 ABI 留作明确回滚的兼容入口；Vault 不再链接 BurnOperations，也不再依赖 Router/WBNB 部署检查。 |
| 外部领收益失败卡住 claim | 已入账 BEM 领取与外部 claim 解耦；严格交接保留，未声称完全解决外部协议冻结风险。 |
| 贱卖及提案期间抢买旧挂单 | 按实际购机成本适用普通/60%份额门槛；表决期间禁止普通转账、transferFrom、新挂单和市场成交，仍可撤单解锁。表决结束未执行后恢复交易。 |
| 冻结措施引入轮流提案阻塞 | 复核另发现仅逐地址冷却不足，扩展为全池相邻提案至少 7 天。表决期 1 天，未通过时至少留下其余 6 天交易窗口；仍须遵守原逐地址间隔。 |
| 旧挂单无限期有效 | 新挂单默认 7 天，到期边界即不可成交。卖家可撤单，任何人可 expire 解锁给原卖家。升级前无到期时间的旧单默认不可成交，须撤单重挂。 |
| 源码和部署产物脱节 | CI 独立重新编译并运行 artifacts:check。Vite 构建再次编译 Solidity 与锁定依赖、核对 JSON，并把规范化内容摘要编入 JS。页面加载、恢复及每次签名前核对该摘要；修改 JSON 中 ABI/字节码/源码清单而自行改摘要不能通过。Git sourceCommit 仅作来源信息，不参与摘要。网页 JS 本身及源码发布渠道仍是信任根。 |
| keeper /tmp 锁和 HTTP RPC | 进程锁/钱包指针使用持久私有目录，文件与目录权限受检查。send 模式拒绝公网明文 HTTP，仅允许 loopback 本地隔离测试例外。对旧池缺少参考权重的配置直接拒绝。锁只协调同一台机器，不协调另一台服务器或外部钱包软件。 |
| 代理无限流 | 默认监听 127.0.0.1；按真实 TCP 对端 IP 限流，不信任 X-Forwarded-For；限制全局并发及限流表容量。反向代理共用对端 IP 时会共用额度，仍需部署方设置入口策略。 |

默认多筹 10% 继续用于资金预留，不授权提高矿机单价或总价。购机剩余款按购机时份额计入各人的 BNB 可领取余额，不是后台自动向钱包转账。整数尾差固定分配，全部余款守恒。

## 升级与旧权益

现有 ERC-7201 字段及嵌套结构不重排，只在命名空间尾部增加必要状态。真实历史基线、五字段 FlexiblePurchase 基线与不兼容负例都继续验证。布局兼容不等于所有历史业务状态自动兼容：

- 缺少新参考权重的旧 flexible 池停止购机，保留超时退款，不允许管理员任意补写定价承诺。
- 新池不再启用收益过期。旧有限期奖励只有在历史负债仍可由保留的 8 日环形槽完整恢复、且检查点不超过 64 条时自动固定迁移切点；任何无法无损还原的状态以 `LegacyRewardMigrationRequired` 拒绝，不抹除债务。已有复杂老池若升级，必须另做经审阅的状态迁移。本项目目前未部署，因此该限制不影响此次新部署，但不能据此声称任意旧池升级即用。
- 历史出售尚未花出的 burnBudget 和整数余款变成独立的持有人额外权益，已领过旧出售款的地址也可领取这部分；已花出的历史预算不重复分配。
- 新整机出售的全部成员净款纳入债务，最后一个固定持有人领取不足 100 wei 的整数尾差。Closed 时持仓不可变。

## CI 失败溯源

[旧 run 36229082731](https://github.com/jianfengliao774-sketch/pinkuang/actions/runs/36229082731) 的完整下载证据显示：332 项合约测试、格式、体积、升级检查已成功，失败阶段是 Slither `--fail-medium` 返回 255。主日志末尾被截断，源于检查脚本缓存大量输出后立即 `process.exit()`。当前改为流式保存和输出、正常排空退出；仍保留中/高风险失败门槛。修复 FlexiblePurchase 的四个未显式初始化局部变量，并逐项检查其余静态分析结果；不通过降低门槛来使 CI 变绿。

## 验证记录

整合检查已通过。检查在本地提交前执行，用下列源码与验证输入清单绑定；原日志 sourceCommit 是检查开始时的 HEAD，不能单独当作被测工作区的源码版本：

| 检查 | 结果与证据 |
| --- | --- |
| 合约单元/不变量 | [324/324，28 suites](../../../deploy/evidence/remediation-final-contracts/forge-test.log)，CI fuzz=256、invariant=128×64，零失败、零跳过 |
| 升级与链接 | [22 项达到预期](../../../deploy/evidence/remediation-final-contracts/upgrade-checks.json)，包含故意不兼容负例被拒绝；[8 库审查](../../../deploy/evidence/remediation-final-contracts/library-link-audit.json) |
| Slither | [--fail-medium exit 0](../../../deploy/evidence/remediation-final-contracts/slither.log)，56 条低风险/信息提示仍完整保留 |
| 尺寸 | [Vault 24,152 B](../../../deploy/evidence/remediation-final-contracts/forge-build-sizes.log)，距离 EIP-170 上限 424 B；后续升级仍须检查体积 |
| 页面/部署/市场/报价 | [32/32](../../../deploy/evidence/remediation-final-deploy-tests.log)，包括完整隔离 Anvil 单钱包部署、恢复、摘要篡改阻断 |
| 其他脚本 | 同日志第二组 [71/71](../../../deploy/evidence/remediation-final-deploy-tests.log)，含 keeper 52、代理 6、产物 7、真实 Anvil 恢复 3、原生 Forge 启动器 3 |
| 产物与页面构建 | [artifacts:check](../../../deploy/evidence/remediation-artifacts-check.log) 与 [build](../../../deploy/evidence/remediation-final-build.log) 均通过 |
| BSC 固定区块分叉 | 区块 123728000，[52/52，11 suites](../../../deploy/evidence/remediation-release-fork/forge-test.log)，零失败、零跳过；[运行参数与 exit 0](../../../deploy/evidence/remediation-release-fork/summary.json) |
| 清单 | [合约/config SHA-256](../../../deploy/evidence/remediation-final-contracts/source-sha256.json)、[验证脚本/布局/依赖 SHA-256](../../../deploy/evidence/remediation-final-contracts/verification-input-sha256.json) |

固定块 fork 首轮 46 通过、1 个 suite 的 setUp 失败，原因是旧 expiryEnabled=true 断言；失败证据保留在 `deploy/evidence/remediation-final-fork/`。修正该测试预期后，收益分叉专项 6/6 和完整分叉 52/52 均通过，包括 24 小时领取边界、长期未领取收益以及真实 Mining 兼容性。

最终[分叉源码清单](../../../deploy/evidence/remediation-release-fork/source-sha256.json)的 75 项、[验证输入清单](../../../deploy/evidence/remediation-release-fork/verification-input-sha256.json)的 25 项均与当前文件一致。与 324 项本地整合测试的清单相比，仅 `test/fork/PoolRewardsFork.t.sol` 修正了上述断言与说明；业务合约、其他测试和验证输入全部相同。部署产物补记来源提交时只改动 sourceCommit，没有更换 ABI、字节码或内容摘要。

发布状态：GitHub 拒绝含 `.github/workflows/contracts.yml` 的推送，原因是当前 OAuth App 缺少 `workflow` scope。当前远端仍为旧提交 `8ce9535`，本轮源码与报告已在本地提交，等待用户补充授权；未冒称最新远端 CI 已通过。针对性采购测试 44/44、报价测试 12/12、市场页面逻辑测试 13/13、表决与市场专项 56/56、收益与迁移独立复核 38/38 已通过；这些局部结果不替代最终整合检查。

第一轮整合发现 3 个收益测试仍按旧 95% 计算，1 个投票不变量在已冻结窗口执行转份额；测试已按新规则修正后重跑。同时发现本地 NPM 的 Foundry 包装器不传播子进程失败退出码；验证入口改用真实平台二进制，CI 保持原生 forge。第一轮失败日志保留，不把包装器返回 0 当成测试通过。新增的 Slither 中风险提示涉及固定每份整数取整、旧环形槽身份相等判断、零新增收益，以及忽略已内部记账的返回值；逐行注明原因并精确抑制误报，不关闭整个检测器。

## 当前未交付的业务路径

Firsto 目前用于参考报价与候选发现；Firsto signed/batch 采购及拼矿自收采购服务费未接入实际购机执行。完整建池、募资、退款业务页面也未因此次修复自动完成。当前可执行采购渠道仍是官方 CircuitMarket。不得将本次修复描述为已完成这些路径或已经主网上线。
