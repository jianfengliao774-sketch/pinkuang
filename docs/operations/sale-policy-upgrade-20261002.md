# Firsto 自动参考价与 80% 出售审核规则

这是尚未广播的候选升级。现用部署产物、ABI、manifest 与主产物 digest 保持原值；钱包签名升级后，运行服务必须按独立候选 overlay 识别完整的新图，不能提前声称规则已经生效。

## 行为

- 售价严格低于新鲜 Firsto 参考价的 80% 时，投票通过后仍须人工审核。恰好 80% 或更高无需审核。
- wei 比较为 `price < referencePrice - referencePrice / 5`，精确等价 `5 * price < 4 * referencePrice`，没有乘法溢出或小数截断。参考价 101 wei 时，80 wei 需要审核，81 wei 无需审核。
- 后台 Gas 钱包通过 `ShareMarket.publishSaleReference(address,uint128,uint64,bytes32)` 自动发布参考价。注册矿池、非零价格、非零证据摘要、不得来自未来、最多五分钟的观察时间与原入口保持一致；自动入口额外禁止旧观察时间覆盖新记录。
- Gas 钱包取自当前 Factory.operator 指向的现有 PlatformAuthority，并核对其 `coreFactory()` 与本市场一致。更换 operator/Gas 钱包即时撤销旧发送者。这个入口没有审核、购机、创建项目、领取平台手续费或修改财库的权限。
- 原管理员签名参考价入口与人工审核入口保留。PlatformAuthority 是非代理，无需更换；Factory 与预算份额市场无需升级。

## 最少变更

新建四个合约：`SaleGovernance` 外部链接库、`PoolVault`、`BudgetPortfolioVault`、`ShareMarket`。新 PoolVault 只替换 SaleGovernance 链接，其余八个已部署库保留；构造参数绑定当前 coreFactory。预算 vault 构造参数绑定当前 portfolioFactory。Market 无构造参数。

在同一个 Timelock batch 依次执行 core beacon `upgradeTo(newPoolVault)`、portfolio beacon `upgradeTo(newBudgetPortfolioVault)`、core ShareMarket `upgradeToAndCall(newShareMarket,0x)`。两种 vault 同时升级，避免预算项目执行与子池执行采用不同门槛。主产物 digest 继续表示 genesis 部署，单独的 `candidateArtifactDigest` 绑定候选。

升级后两种 vault 的 `saleReviewThresholdBps()` 返回 8000，core market 的 `automaticSaleReferenceVersion()` 返回 1，`saleReferencePublisher()` 返回当前 Gas 钱包。旧合约缺少这些 getter，前端必须按原 100% 门槛诚实显示。

## 两套现用图

链上只读证据固定于区块 125208091，所有 genesis 链接库、三个旧实现与现用 artifact 的运行字节一致。

| 环境 | core Factory | Timelock proposer | 调度等待 | genesis digest |
| --- | --- | --- | --- | --- |
| 独立主网测试 | `0x7F0681ed1035584b1B3e4f3D43f3c9ddfA4c1f2c` | `0x6F4d78fB59eC938cBAF65b9fc822aD04d00c155E` | 0 | `0x3d386ce28a1898546697d1ee715b5276104894f781e68b785306eac9cde5338b` |
| 正式 | `0xd81dBD0E622447D26405B3576F0C3Fd698AF01B8` | `0x042B23288E2316DFb6503488292FD0Ad2F811Ae7` | 48 小时 | `0x6007118ac4568be4743a99b44b5259518fcf5a73e091469bfdc4d05a7dc4dd75` |

正式管理员 `0x7674…Ea53` / `0xeD2F…FcbB` 负责业务签名，不能据此假定它们有 Timelock 调度权限。两套图均允许任何账户执行已准备完毕的 batch，但调度必须由各自现有 proposer 发起。

候选正式 digest：`0x3bcc4d9d3d9e7a819f8ab52d82803e3254e4937058c6d32e7cd27654a937599e`。候选测试 digest：`0xf162aa46f2edc02b7ae0e6ae13eec32cf0c5a6eb377625eb699f7143666179d7`。

调度 salt 固定为 `keccak256(UTF8("bemine.sale-policy.v1:" + lower(factory) + ":" + lower(candidateArtifactDigest)))`。公开候选目录为 `web/public/data/sale-policy-upgrade.formal.json` 与 `sale-policy-upgrade.full-test.json`；每个网站只发布自己的环境文件。文件包含精确图绑定、旧实现、全部 genesis 库与四个候选 artifact，供新的 fresh 钱包升级入口使用。

旧 `deploy/src/upgrade-release.ts` 固定了 `tapeout.cc.cd`、`/bemine-v2` 和旧 genesis 摘要；它以及旧 integrated security upgrade 计划不能直接复用当前 fresh 图。

## 发布与数据衔接

钱包创建候选合约后先验证运行字节、库链接与 immutable Factory，再构造三目标原子 batch。BNB 主网独立测试版等待值为 0，但仍需要 proposer 的真实钱包签名；后台持有 Gas 钱包不能代签调度或 beacon/UUPS 升级。正式 batch 保留 48 小时。

服务只在三目标的精确候选实现、8000/1 getter、固定 `hashOperationBatch` 与已完成 Timelock 操作全部一致后接管新候选；混合图应暂缓自动操作。旧 factory、authority、lens、portfolioShareMarket 继续与 genesis 绑定。升级记录独立保存，不覆盖 fresh 激活证据。

## 验证证据

所有候选编译、storage layout 与 Foundry 日志存于 workspace `outputs/test-project-repair-20261002/sale-review-candidate/`。Solc 0.8.24、Shanghai、optimizer runs=1、viaIR=false。三种实现的 formal/full-test 六次 OpenZeppelin storage 比较全部兼容，预算 vault 的 30 个原线性字段与全部 ERC-7201 namespace 保留，Market 未新增状态字段。

全部 525 个 Solidity unit tests 通过，其中包含 256 次精确比较 fuzz 与 10 个自动发布权限集成测试。运行大小：SaleGovernance 5163 bytes，PoolVault 24493 bytes，BudgetPortfolioVault 24406 bytes，ShareMarket 13163 bytes，均符合 EIP-170。测试覆盖精确 80%、相邻 1 wei、101 wei 分数边界、高历史 uint256 值、双多数表决、参考价下降后旧审核拒绝不再阻挡，以及 publisher 权限、池注册、证据时间、uint128 ABI 限制、Gas 轮换和购机/审核/财库权限隔离。
