# 2026-09-24 审计处理记录

> 后续规则覆盖（2026-09-26）：第 3 项增加全池 7 天提案间隔及表决期间交易冻结；第 8 项保留全体快照地址数过半，折价另需 60% 份额；第 12 项增加单位权重限价、额外募资不抬高购机 cap；第 14 项禁止零价整机出售，零价份额赠与仍允许。销毁已按项目方要求取消。当前结果见 [最新整改报告](../2026-09-26/remediation.md)，下表保留历史处理过程。第 6、7 项并未由本次指示改变。

输入为项目方提供的 [18 项问题与原 PoC](source/README.md)，审计对象是 `6879557`。本次从完整 T1e 实现 `8ba9fb1` 及证据归档 `66e6f81` 继续修复，仍使用 PR #7。所有结论区分当前代码缺陷、业务选择和后续里程碑；不以旧清单中的进度描述覆盖后来已完成的实现。

## 逐项处理

| # | 处理 | 证据或边界 |
|---|---|---|
| 1 | 已由完整 T1e 实现 | 项目方已接受内部成交路线；[完整交付](../../M1e-complete.md) 有受控出售、分账、预算销毁与远端 CI，毋须重复确认渠道 |
| 2 | 已修复并通过本地验证 | 仅已知非挖矿状态 0/2/3 且 pending=0 可做零结清；仍校验 NFT 所有权、矿机身份与 key、BEM 实际余额及最终 pending；运行中 claim 失败、非零 pending 和未知状态仍回滚 |
| 3 | 业务决定待答复 | 建议快照至少 5 份才可提案，反对人数与份额双过半可提前失效。该方案提高占位门槛、支持双多数解锁；不能宣称消除地址轮转或交易排序竞赛。批准前保留 v0.4 原规则 |
| 4 | 已通过体积检查 | 完整出售已拆为八库，本轮 Vault 24,084 B，距硬上限尚有 492 B；后续复投仍须继续拆库。22KB 是拆分触发点，24,576 B 是硬上限 |
| 5 | 已修复并通过本地验证 | `_update` 在 mint/transfer/transferFrom/市场成交共用路径拒绝本池及工厂作为接收人；失败交易保持持仓、人数、授权、旧收益、订单与付款 |
| 6 | 建议保留原退款权，待答复 | 原规则允许 Funding 募满前全额撤资；加锁定期/撤回费会限制正常出资人。不能把规则允许的撤资改写为已被代码消除的攻击 |
| 7 | 期限数值待答复 | 建议 fundingDeadline ≤ 创建时 +30 天，purchaseDeadline ≤ fundingDeadline +72 小时；未批准前不擅自新增数值 |
| 8 | 建议保留全体快照人数分母，待答复 | 低参与率与地址人数拆分风险依然存在；仅改为投票者人数分母会改变 v0.4 明确的出售门槛 |
| 9 | 已修复并通过本地验证 | Vault 实现 immutable 绑定本项目 Factory，只接受该工厂初始化；空克隆不能利用零配置免费 mint。Beacon 升级候选必须保持同一 Factory 绑定。复制源码部署其他实现无法被禁止，官方身份仍以指定 Factory 的 `isPool` 为准 |
| 10 | 已补齐并通过本地模拟 | 单次原子协调器创建并初始化治理、Beacon、Factory/Market 代理；脚本只读公开地址并支持本地模拟，未使用私钥或广播主网 |
| 11 | 已修复并通过本地验证 | Mining mock 对非运行状态返回真实 `0x5f9bb3be`；新增状态覆盖 fork 明确标注人工状态，不伪称自然链上撤销 |
| 12 | 运营约束保留 | `priceCap` 是已授权的最高总支出；任何人触发都不能越过该值。创建时应填写实际可接受价格，不把多募余额当成抬高 cap 的理由 |
| 13 | 保留原准入规则，列入上架检查 | 购机仍要求正确系列、编号、owner、正在挖矿与原子结清；运营另核 verifWeight、gateCount 和实际收益类别。直接强制 verifWeight>0 会排除文档允许的未验证矿机，本轮不自行改变产品范围 |
| 14 | 保留零价，前端提示待 M2 | 原文未设价格下限；完整 T1e 保留零价及严格投票/付款规则。后续网站对零价份额挂单、零价整机提案做明确确认，并显示最终实收；不冒称尚未开发的网站已修复 |
| 15 | 已加入矿机识别名称 | 新池名称为 TapeOut/Behemoth #编号 Pool Share，symbol TPS、零位小数保持；已初始化旧池的名称不被升级自动覆盖 |
| 16 | 保留并说明 | BNB 整数尾差单独记账，旧 BEM 分数余数继续按原模型保留；不增加 treasury/owner 任意扫款入口，不能把成员未领债权当无主款 |
| 17 | 已更新配套勘误 | [v0.4 勘误](../../spec-v0.4-corrections.md) 纠正区块单位、arm 窗口、Mining 封存/owner 和市场收费，保留原始需求文件及哈希 |
| 18 | 更新进度，不擅自合并 | T1e 出售后半已完成；T1f/T1g、网站、索引、keeper、bot 仍为后续工作。堆叠 PR 的合并不等于审计修复，本轮未合并或部署 |

## 验证

最终源码提交为 `312a605d9312e5d9edbd2853458f0b988ac28d0d`。本地验证如下，原始证据目录为 `docs/logs/audit-2026-09-24/`：

| 检查 | 当前结果 |
|---|---|
| 单元与不变量 | [289 passed / 0 failed / 0 skipped](../../logs/audit-2026-09-24/contracts-final/forge-test.log)，原有 256 项加 33 项审计/部署回归 |
| 固定块 fork | [54 passed / 0 failed / 0 skipped](../../logs/audit-2026-09-24/fork-release/forge-test.log)，BSC 123728000；其中 7 项显式人工状态覆盖，1 项本地持有人调用真实 stop，余下 46 项为原有回归 |
| 升级兼容性 | [20 项达到预期](../../logs/audit-2026-09-24/contracts-final/upgrade-checks.json)，包含完整 T1e 三份真实布局及故意不兼容负例 |
| 静态链接库 | [八库审查 ok=true](../../logs/audit-2026-09-24/contracts-final/library-link-audit.json)，保留源码、字节码模板及 AST 调用边界 |
| Slither | [--fail-medium exit 0](../../logs/audit-2026-09-24/contracts-final/slither.log)，53 条 Low/Info，无未处理 High/Medium |
| 合约尺寸 | [完整 sizes 输出](../../logs/audit-2026-09-24/contracts-final/forge-build-sizes.log)：Vault 24,084 B，Factory 10,782 B，AtomicDeployment 16,883 B，Beacon 868 B；生产 runtime 与 initcode 都未越界 |
| 远端 CI | 修复提交 `312a605` 的 [CI 36029854878](https://github.com/jianfengliao774-sketch/pinkuang/actions/runs/36029854878) 两个任务全部 success；[contracts 原始日志](../../logs/audit-2026-09-24/github-job-107735613730.log)、[fork 原始日志](../../logs/audit-2026-09-24/github-job-107736845425.log) |

远端再次通过 289 项单元/不变量及 54 项 fork、升级和静态检查。runner 恢复了真实 Foundry 链状态缓存，测试结果不表示每条状态读取都重新联网。后续仅文档及证据归档提交的状态以 PR checks 为准，源码与本次 manifest 保持一致。

两份最终 [contracts summary](../../logs/audit-2026-09-24/contracts-final/summary.json) / [fork summary](../../logs/audit-2026-09-24/fork-release/summary.json) 都指向上述已提交源码。各自的 68 项 Solidity/config 哈希与 21 项验证输入哈希逐项核对一致。没有省略失败用例或降低断言后将它们冒记为通过。

一次补充回归最初错误地预期空克隆 `deposit(1)` 抛 Unauthorized，但原有截止校验更早抛 DeadlinePassed；已经纠正断言并移除后置的冗余 factory 非零判断。完整 [本地失败日志](../../logs/audit-2026-09-24/contracts-initial-regression-failure/forge-test.log)、[远端失败 artifact](../../logs/audit-2026-09-24/github-initial-failure-artifact/forge-test.log) 及 [各轮说明](../../logs/audit-2026-09-24/README.md) 保留，真实工厂绑定与误转禁令没有放松。

复现命令（PowerShell）：

```powershell
$env:VALIDATION_EVIDENCE_ROOT = Join-Path (Get-Location) 'docs/logs/audit-2026-09-24/contracts-final'
node scripts/check-local.mjs T1e
$env:VALIDATION_TASK = 'T1e'
$env:VALIDATION_EVIDENCE_ROOT = Join-Path (Get-Location) 'docs/logs/audit-2026-09-24/fork-release'
$env:BSC_RPC_URL = 'https://bsc-mainnet.public.blastapi.io'
$env:FORK_BLOCK = '123728000'
node scripts/run-fork.mjs
```

原 PoC 中“测试通过”代表缺陷存在，已经原样归档。新测试反向断言修复后的行为，保留原问题编号与可追溯性。

## 修改文件

| 文件 | 修改目的 |
|---|---|
| `contracts/src/libraries/MiningOperations.sol` | 增加可证明无欠款的非挖矿状态零结清，不吞运行中领取失败 |
| `contracts/test/utils/PurchaseMocks.sol` | 非运行状态按真实协议拒绝 claim，支持未知后置状态故障注入 |
| `contracts/src/PoolVault.sol` | 固定工厂初始化、拒绝本池/工厂接收份额，初始化可识别矿机名称；空代理原有截止保护另有回归验证 |
| `contracts/src/libraries/PoolFunds.sol` | 生成矿机系列及编号名称，避免扩大 Vault 的字符串处理代码 |
| `contracts/src/interfaces/IPoolVault.sol` | 增加明确的 InvalidShareRecipient 错误 |
| `contracts/src/PoolBeacon.sol` | 记录固定 Factory，升级时强制候选实现保持绑定 |
| `contracts/src/PoolFactory.sol` | 增加仅初始化时可达的原子 Market 创建登记；原初始化及时间锁登记接口保留 |
| `contracts/src/AtomicDeployment.sol` | 单次部署协调器、角色及关联图验证、失败全图回滚和公开 codehash 记录 |
| `contracts/script/Deploy.s.sol` | 使用公开配置的 BSC 部署模拟入口 |
| `contracts/test/unit/AuditMiningSettlement.t.sol` | 12 项安全零结清、未知状态/欠款拒绝、转让与完整出售回归 |
| `contracts/test/unit/AuditShareRecipient.t.sol` | 4 项认购/转让/授权/市场成交误转回归，各含 256 次 fuzz |
| `contracts/test/unit/AtomicDeployment.t.sol` | 15 项官方绑定、空克隆、原子失败/重试、多签配置、登记、升级延迟和代码限制回归 |
| `contracts/test/unit/DeploymentScript.t.sol` | 在本地 VM 执行真实脚本，另验证错误 chainId 在部署前拒绝 |
| `contracts/test/fork/AuditMiningStateFork.t.sol` | 3 项明确覆盖状态字节的真实协议分支测试 |
| `contracts/test/fork/AuditMiningSettlementFork.t.sol` | 4 项状态覆盖退出/拒绝测试及 1 项真实 stop 调用后的退出测试 |
| `contracts/test/utils/{FundingTestBase,RewardsTestBase,ShareTransferTestBase}.sol`、`contracts/test/unit/PoolGovernance.t.sol` | 既有部署/升级夹具传入相同官方 Factory，不改变旧业务断言 |
| `contracts/test/fork/Pool{Purchase,Rewards,ShareTransfer,Sale,Burn}Fork.t.sol` | 既有五套真实 fork 采用固定 Factory 的构造参数，保留原业务验证 |
| `scripts/validate-upgrades.mjs` | 加入完整 T1e 三份真实布局对照，检查从 17 项增至 20 项 |
| `scripts/audit-linked-libraries.mjs` | 明确 immutable 与链接模板的边界，保留八库 AST 和源码哈希审查 |
| `.github/workflows/contracts.yml` | 更新检查名称以反映完整 T1e 基线 |
| `.env.example`、`README.md`、`docs/deployment.md` | 公开部署配置、当前进度和模拟/部署核验流程 |
| `docs/spec-v0.4-corrections.md`、`docs/audits/2026-09-24/` | 已批准的协议勘误、原审计输入和逐项处理说明 |

## 与原文档的差异

业务费率、投票规则、原募集撤资权及期限参数规则保持不变。已确认的出售渠道与协议事实按现有批准实施；状态 0/2/3 的零结清是针对已无可领取收益的协议分支修复，不为活动矿机放松最后领取要求。其他四项业务选择见上表，仍未替项目方决定。

部署构造参数新增官方 Factory；这是新实现及后续部署脚本的必填值，存储兼容验证不检查该值，另由协调器及 Beacon 绑定检查和回归覆盖。新部署在初始化内登记 Market；已有 Factory 仍保留原受时间锁控制的单次登记接口，不能重复或替换已登记地址。

## 上线与产品约束

运营创建项目时核对系列及编号、验证权重/门数、矿机状态、实际市场价格和可接受总价 cap；网页和索引只认配置的官方 Factory 及其 `isPool`。克隆代码、相似名称或借用官方 Beacon 地址都不是项目官方身份的证明。

部署时复核实际多签地址及实现代码。接口返回“2/3”只表示读取到的配置，不证明该合约真是可信多签。编译器产物、部署记录、链接地址和实际 codehash 必须对应；源码模板哈希不能替代部署核验。
