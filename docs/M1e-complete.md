# T1e 完整交付：投票、受控出售与预算销毁

本文件固定记录完整实现提交 `8ba9fb1` 的交付证据。后续项目方审计修复、工厂绑定与部署入口、最新测试数量及体积见 [2026-09-24 审计处理记录](audits/2026-09-24/remediation.md)。

项目方已明确接受首期仅通过本项目 `completeSale` 成交、不在 tapeout.market 挂单。实现保留平台 2% 与销毁预算 2%，没有重复扣市场 1%；成员取得实际成交款扣除这两项后的余额，整数尾差独立记录。本文件是完整 T1e 的交付说明；[投票阶段历史](M1e.md) 和 [中途优化记录](M1e-optimization.md) 保留原始证据。

## 函数与行为

| 入口 | 最终行为 |
|---|---|
| `propose / vote` | 取得矿机满 7 天、同钱包提案间隔 7 天、24 小时投票；上一秒历史人数及份额双过半，每地址一票。既有投票规则保持 |
| `executeSale(id)` | 仅 Active，当前未执行且未过期的提案达到双多数后进入 Listed；固定批准价格、当前实际持有人权益，7 天期限 |
| `relist(id)` | 复用同一执行校验；只能执行新通过的提案，不能复用已执行提案或直接改价 |
| `cancelExpired()` | 任何人在挂牌满 7 天后撤销，回到 Active；清当前挂单字段，保留原提案与投票历史，再出售必须重新投票 |
| `completeSale()` | Listed 且未到期、付款精确等于批准价；严格领取并核对持有人/矿机身份/实际到账/清零 pending，分账后先记 Closed 和 BNB 债权，再安全过户并复核买家所有权。任何失败整笔回滚 |
| `withdrawBnb()` | 累加原退款、直卖矿机款、原购机余款与新出售款；出售份额按 Closed 后永久冻结的当前余额懒结算，同秒挂牌与成交也可领取 |
| `settleSale()` | 明确拒绝未验证的外部成交路线。当前受控入口同笔完成结算，不能在 NFT 已转走后补领或再次分配 |
| `executeBurn(minOut,maxIn)` | 仅 Factory 当前 operator 且 Closed，实际输入不超过 `min(maxIn,burnBudget)`；固定 WBNB→BEM 1% 池路径，仅新买到的 BEM 转入销毁地址 |

Listed 期间份额转让及 ShareMarket 成交被冻结，但卖家仍可取消份额挂单，锁定份额仍属于原持有人。完成整机出售后，旧成员最后 BEM 和 BNB 权利保留，BEM 七日批次与领取间隔不变；原成员 `claim()` 不再调用已售 NFT 的 Mining。买家若原本也是成员，仅保留其已有份额权益，购买 NFT 本身不会获得池份额。

合约不向 CircuitMarket 或其他第三方授权 NFT，不调用 stop。`SaleListed.listingId=0` 表示内部受控挂牌，不能当成外部市场挂单编号。

## 资金与销毁边界

每次实际成交款为 `gross`：平台 `floor(gross/50)` 记入 treasury 待领债权；同额计入 `burnBudget`。其余按 100 份分配，`salePerShareWei=floor(memberNet/100)`、`saleRemainder=memberNet%100`。`totalBnbOwed()` 包含未物化的购机余款和出售款，销毁预算及两类尾差分别保留，不重复计为用户债权。

`SaleCompleted.burnedBem=0` 表示成交时仅预留 BNB、尚未兑换销毁；`SaleBudgetRecorded` 关联批准提案，后续 `BurnExecuted` 记录实际 BNB 支出和实际 BEM 销毁量。交易标识、买家、时间和成交额可通过 sale getters 复核。

Burn 库只包装本次可用预算、只授权该额度，兑换后把授权清零。根据本池 WBNB 余额差计算实际支出，未用输入退回并恢复预算，原 WBNB、BEM、成员 BNB 和收益账保持。不会调用 Router 的 refundETH 或 sweep。真实 Router 可能优先花其原有 BNB；此时本池实际支出可以为 0，原预算必须完整恢复，不能把账面输入当作本池已花资金。

WBNB 的退款使用 2,300 gas。Vault receive 仅在烧币调用预写的上下文中接受固定 WBNB 的精确退款，不写存储、不加重入锁；所有可动资产的外部入口仍共享 nonReentrant。开发期真实退款 trace 测得代理 fallback 消耗 1,214 gas，其中内部 receive 为 270 gas；最终源码的全套 fork 再次通过该场景。

允许 `minOut=0`；operator 决定滑点，合约没有额外定价预言机。这里保证固定用途、输入上限和旧资产保留，不宣称链上强制合理成交价格。实际新增输出必须大于零并与 Router 返回值一致，销毁后 BEM 余额必须回到原值。

## 文件变更

| 文件 | 作用 |
|---|---|
| `contracts/src/PoolVault.sol` | 集成挂牌、撤销、交割、出售款领取和仅 operator 的预算销毁；保留统一重入保护和 NFT 校验 |
| `contracts/src/PoolSaleState.sol` | 在原 5 个投票字段后追加 16 个挂牌、成交、懒结算及销毁字段 |
| `contracts/src/PoolVaultState.sol` | 原 Vault 25 个字段及固定 ERC-7201 槽的共享声明，顺序和类型保持 |
| `contracts/src/libraries/PoolFunds.sol` | 等价搬移已交付的失败退款、购机记账、余款懒结算和提款 CEI |
| `contracts/src/libraries/SaleGovernance.sol` | 加入执行当前有效提案和挂牌到期撤销 |
| `contracts/src/libraries/SaleSettlement.sol` | 成交款分配、冻结权益物化、安全过户及最终所有权复核 |
| `contracts/src/libraries/BurnOperations.sol` | 固定路径兑换、精确授权、退款及预算/旧资产守恒 |
| `contracts/src/interfaces/IPoolVault.sol` | 完整出售/销毁 ABI、错误和事件 |
| `contracts/src/interfaces/IPancakeBurnRouter.sol` | 经验证的七字段 V3 Router 参数及 WBNB 接口 |
| `contracts/test/utils/SaleTestBase.sol` | 真实内部流程及恶意买家测试夹具 |
| `contracts/test/utils/BurnMocks.sol` | 明确标注的单位测试兑换端点及故障注入 |
| `contracts/test/unit/PoolSale.t.sol` | 25 项交割边界、原子回滚与分配测试 |
| `contracts/test/unit/PoolBurn.t.sol` | 23 项预算、退款、旧资产、权限和异常输出测试 |
| `contracts/test/invariant/PoolSaleInvariant.t.sol` | 4 项基于独立持仓/资金账的随机生命周期及成交后 BNB 守恒测试 |
| `contracts/test/fork/PoolSaleFork.t.sol` | 4 项真实购机→投票→出售→领取、买家新收益和失败回滚验证 |
| `contracts/test/fork/PoolBurnFork.t.sol` | 3 项真实兑换、过高 minOut 回滚、Router 预充及真实 WBNB 退款验证 |
| `scripts/audit-linked-libraries.mjs` | 八库链接、源码/字节码模板与 AST 检查；仅新增允许向原 caller 提取已清零债权的固定提款 CALL |
| `scripts/validate-upgrades.mjs` | 增加已交付 T1e 投票版的真实布局比较，固定核对完整出售命名空间 21 个字段 |
| `docs/storage/T1eVoting-PoolVault.json` | 来自提交 7e988a3 真实 compiler input/output 的布局基线，保留原 5 个投票字段 |
| `docs/storage/T1e-{PoolFactory,PoolVault,ShareMarket}.json` | 来自完整实现提交 8ba9fb1 的真实编译基线；核对已提交源码与 compiler input 一致，供后续升级验证使用 |
| `.github/workflows/contracts.yml` | 验证名称更新为完整出售与销毁；沿用 PR 去重、fork 队列与有界重试 |

资金搬移已独立逐项与 7e988a3 核对：检查及写入顺序、错误、事件、债权累加和提款 CEI 等价。library delegatecall 保留原 caller、Vault 余额与事件来源。没有使用任意 delegatecall、跳过存储校验或绕过时间锁的新入口。

## 验证结果与原始证据

| 检查 | 结果 |
|---|---|
| 全树单元及不变量 | [256 passed / 0 failed / 0 skipped](logs/T1e/complete/contracts/forge-test.log)，包含全部原有 204 项及本轮 52 项 |
| BSC 固定块 fork | [46 passed / 0 failed / 0 skipped](logs/T1e/complete/fork/forge-test.log)，区块 123728000，39 项原有回归加 7 项实际出售/兑换 |
| 升级兼容性 | [17 项达到预期](logs/T1e/complete/contracts/upgrade-checks.json)，含 T1a–T1d、T1e 投票真实布局及故意不兼容负例 |
| 链接审查 | [八库 ok=true](logs/T1e/complete/contracts/library-link-audit.json)，记录源码、未链接模板及限定 AST 调用范围 |
| Slither | [--fail-medium exit 0](logs/T1e/complete/contracts/slither.log)，无未处理 High/Medium；44 条 Low/Info 保留 |
| 合约体积 | [完整原始输出](logs/T1e/complete/contracts/forge-build-sizes.log)，所有生产合约低于 24,576 B |
| 远端 CI | 实现提交 `8ba9fb1541e82cff8bced3c9caff0159748e33d6` 的 [PR CI 36016301028](https://github.com/jianfengliao774-sketch/pinkuang/actions/runs/36016301028) 两项任务 success；[contracts 原始日志](logs/T1e/complete/github-job-107689592493.log)、[fork 原始日志](logs/T1e/complete/github-job-107690939818.log) |

远端再次通过 256 项单元/不变量、46 项 fork、17 项升级检查及 Slither。fork runner 恢复 Foundry 的真实链状态缓存，不能把新 runner 等同于无缓存读取。完整实现基线导出在本地验证之后进行，因此上述本地验证输入清单为 18 份，未包含新导出的 3 份基线；它们保留真实编译输入和输出，不回写或替换被测文件。

新增 4 项 BNB 不变量各运行 128 轮、8,192 次调用，模型由原始募集/退款/购机/出售金额和独立持仓计算，未从 production owed/perShare 反推预期。销毁单测另有 256 次实际支出/部分退款 fuzz；输入超额、旧资产变动、错误输出、退款错误、销毁失败和有真实权限的回调重入均验证回滚。

真实主闭环最后领取 gross 39,272 BEM atoms、原成员净额 37,310 atoms，之后新增 39,273 atoms 归买家。0.1 BNB 出售将 0.096 BNB 分给原成员，0.002 BNB 留作销毁预算，原购机余款和直卖方债权仍可分别提款。拒收 NFT 的真实调用中，已发生的 Mining mint、成员收益账和销售记录一并回滚，随后原挂牌可重新正常成交。

真实兑换花费 0.0002 BNB，取得并销毁 242,631 BEM atoms。另一个 Router 预充场景中，本池支出 0、预算完全恢复、同量新 BEM 销毁，Router 尚余 0.0004 BNB 没有被扫走。以上都是固定块本地 fork，使用本地原生币供资和地址 impersonation，没有替换真实协议代码/存储/ERC20 余额，也没有主网广播。

本地元数据：[contracts](logs/T1e/complete/contracts/summary.json)、[fork](logs/T1e/complete/fork/summary.json)。两次运行均核对了 [60 份源码](logs/T1e/complete/contracts/source-sha256.json) 和 [18 份验证输入](logs/T1e/complete/contracts/verification-input-sha256.json) 与当前文件一致；运行时 sourceCommit 是当时 HEAD，最终实际被测内容以这些哈希为准。

开发过程的 [burn preflight](logs/T1e/burn-preflight/README.md) 保留初始 Slither 发现、mock/fork 调试和真实退款 trace；一次测试 prank 被参数求值消耗已修正，最终所有 46 个 fork 在一次正式运行中全部通过。新余额检查的精准 Slither 说明基于外层锁和实际余额守恒，不是全局屏蔽检测器。

复现命令：

```powershell
$env:VALIDATION_EVIDENCE_ROOT = Join-Path (Get-Location) 'docs/logs/T1e/complete/contracts'
node scripts/check-local.mjs T1e
$env:VALIDATION_TASK = 'T1e'
$env:VALIDATION_EVIDENCE_ROOT = Join-Path (Get-Location) 'docs/logs/T1e/complete/fork'
$env:BSC_RPC_URL = 'https://bsc-mainnet.public.blastapi.io'
$env:FORK_BLOCK = '123728000'
node scripts/run-fork.mjs
```

## 体积、偏差与后续边界

完整入口初版为 24,671 B，超过硬上限；等价拆出 PoolFunds 后最终 Vault 为 **23,729 B**，剩余 **847 B**。八库分别为 BurnOperations 3,460、MiningOperations 5,911、PoolFunds 2,143、PurchaseValidation 3,532、RewardAccounting 5,565、SaleGovernance 3,564、SaleSettlement 2,149、ShareCheckpoints 1,466 B；Factory 9,020 B、ShareMarket 6,259 B。

开工计划 22KB 是拆分触发条件，本次已经将出售、批次、检查点和资金记账拆入外部库；24KB 是验收硬上限。后续新增入口必须继续量体积。模板哈希不代表已部署库 codehash，部署时还须核验实际链接地址和代码。

业务规则偏差：无。96% 是项目方已确认的受控渠道实际到账结果；`settleSale` 作为保留入口拒绝未验证外部成交路径，符合开工计划默认方案。旧 Vault/奖励命名空间未改序；Sale 命名空间仅追加字段，原投票记录升级后保留。

本次没有新的待项目方决定项。T1f 结转与自动复投、T1g 最终覆盖率验收、索引、网站及主网部署不包含在本次 T1e 验收内；不能据此声称整个 M1 或项目已经完成。
