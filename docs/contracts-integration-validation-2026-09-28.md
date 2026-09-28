# 合约整合实现与验证记录（2026-09-28）

本记录对应以 `5f160c579e9d3d382df199cb29dc1573f5ae992e` 为基线的 `codex/contracts-v2-integration` 整合版本，范围为合约源码、部署图兼容性及本地验证。记录与变更随仓库版本保存；部署时应以实际构建清单的 sourceCommit 和源码哈希确定版本。以下本地、固定块 fork 结论不等于线上验收：不代表旧地址已升级，也不代表已发布 Firsto 原生页面卖单。本轮验证未签名、广播或部署任何主网交易。

## 已实现的资金与 NFT 路径

1. 官网与 Firsto 购入沿用已审查的 `FlexiblePurchase/PurchaseValidation`：用矿池余额付钱，转移前实际 claim 卖家 BEM，核实 NFT/矿机身份和购机资格，NFT 进入子池。官网挂单优先、矿机唯一登记、价格上限/份额权利没有被新出售逻辑替换。
2. `PoolVault.completeFirstoSale(expectedProposalId, expectedSalePrice, uint16 expectedFeeBps, expectedFeeEpoch)` 是新受控出售入口；确认参数和当前治理结果/源费用必须相等。买家支付 `price + floor(price * sourceFeeBps / 10000)`，NFT 归发起该调用的钱包。
3. PoolVault 持有重入锁，先严格领取并记入旧成员 BEM，再生成仅本笔交易有效的精确 ERC-1271 hash 许可，给固定 Firsto V2 交易所该 NFT 的单 token 授权。同笔成交后要求：交易所精确支付售价一次、池余额差精确、NFT 最终归买家、源 nonce 已消费、费率和 epoch 未变。任一失败全部回滚。
4. **真实 Firsto 有 SelfTrade 限制**，maker 不能直接调用 `fillSignedAsk`。真实 fork 首轮在这里拒绝（`firsto-sale-real-trace.log`）；因此最终通过 `FirstoSaleExecutor` 的一次性构造器转发到固定 V2。该 helper 没有管理者、可复用调用入口、存储授权或留款；它不持有 NFT。临时签名许可、付款窗口和历史权益始终由池控制。此安排不增加独立部署步骤，但每次成交有一次 CREATE 成本。
5. Firsto 的实际买方费不进入项目卖款。池收到完整批准售价后记 1% 平台 BNB 债权、99% 成员债权，继续使用本人提款。`completeSale()` 明确 `UnverifiedSaleRoute()`，不保留悄悄绕开 Firsto 的内部直售入口；`controlledFirstoSaleVersion() == 1` 供旧版本识别。平时 `isValidSignature` 返回无效，且没有持久 Firsto NFT 授权，因此不把本站 Listed 冒充外部已发布卖单。
6. 多机预算 `_finishChild` 只在实际存在 BNB 债权时提款，修复成交价（含 Firsto 买方费）恰好等于子池募集额时 `NothingToClaim` 导致整个购机回滚。子池卖出后，成员治理的预算项目实际领取其 BEM/BNB，不再扣第二次整机出售费。

## 预算治理防持续冻结

保留“逐台、串行单候选”模式；没有声称实现单机 PoolVault 的同轮多候选。新增独立 `erc7201:tapeout.storage.BudgetGovernance`，只有 `uint64 nextRoundAt`，不挪动旧普通字段。

- 首次提案开启 24h 投票，下一轮最早为开启时间+7天，少数地址轮换也不能绕过全局冷却。
- 未执行提案到期后，份额交易立即自动解冻；`activeProposalId` 可能仍保留历史 ID，页面/后台应读取 `shareTradingAllowed()` 并核对截止时间，不能单看 ID 非零。
- 已通过且已执行的子池出售仍冻结，直到真实成交结算或七天挂牌期满取消。
- 七天后新提案可自动清理旧未执行提案，并发 `ChildSaleExpired(oldId)`。旧提案不能再投票或执行。
- 升级前已有轮次而新 namespace 为零时，`nextRoundAt()` 由最近提案 `endsAt+6days` 保守恢复，避免升级本身重置冷却。

## 存储、依赖与体积

- PoolVault 原有命名空间和账本保留；新增独立 `erc7201:tapeout.storage.FirstoSale`：`orderHash / expectedProceeds / active / received`。每笔交易结束清空，异常由 EVM 全回滚。
- 新链接依赖 `PoolVault → FirstoSale → SaleSettlement`。PoolFunds 的原初始化校验/赋值被原样抽入既有库，以控制体积；旧代理初始化权限、参数、字段没有改变。
- 最终编译设置保持 Solidity 0.8.24、optimizer 200、非 viaIR、Shanghai。PoolVault runtime **24,414 bytes**，BudgetPortfolioVault **22,638 bytes**，FirstoSale **5,848 bytes**；没有放宽 EIP-170 大小限制。
- 5f 预算真实编译的全部生产依赖 metadata keccak 与固定快照匹配后，提取了 Factory 9 字段、Vault 30 字段基线。最新 OZ 比较仍为 9→9、30→30，新增 namespace 独立。真实基线已纳入 `docs/storage/Budget-v1-BudgetPortfolioFactory.json` 和 `docs/storage/Budget-v1-BudgetPortfolioVault.json`，由 `scripts/validate-upgrades.mjs` 常驻校验。
- 原子部署图包括 core Factory/Beacon/Vault、预算 Factory/Beacon/Vault 和分别绑定各 Factory 的两个 ShareMarket；旧六字段部署 Config 和旧部署方法保留，新增 `deployIntegratedSingleOwner(IntegratedConfig)` 同笔初始化完整新图。真实预算 fork 已使用该新图，没有另造不一致的简化部署。

## 验证结果与证据

证据目录为本次工作环境中的 `outputs/pinkuang-rewrite-handoff-20260928/`；以下目录名均相对该目录。这些日志属于本地验证产物，不保证随仓库发布，更不是线上运行回执。关键测试、固定块参数、布局基线和校验脚本保存在仓库，可按相同源码重跑。

完整本地门禁 `final-contracts-v2/summary.json`：**482 个单测/模糊测试/不变量全部通过**（CI 不变量 128 runs × 64 depth），OZ **26 项**通过（包含故意破坏布局必须拒绝的负向用例），Slither `--fail-medium` 退出0。Slither 仍报告低级/信息类提示，不能称“没有任何报告”。原先一项手工提案测试没有传递新入口要求的 proposalId，已补测试期望 ID，未据此改业务校验。

最终统一格式化源码在真实 Firsto 固定区块 **124308679** 的整合 suite 共 **12 项通过**，证据 `firsto-final-current/summary.json`。使用真实 V2/NFT/Mining/BEM，以及公开真实卖单签名；没有替换外部协议 bytecode。包括：

| 路径 | 真实验证 |
| --- | --- |
| Firsto 购入 | 原卖家 pending=28,313 atoms，实际领取28,421，NFT进真实新 PoolVault，实际支出0.0505 BNB含源费。 |
| 严格 Firsto 卖出 | 本次NFT过户交易实际新增领取38,983 atoms；平台389 atoms、旧成员38,594 atoms；旧成员BEM不转给NFT买家，后续矿币只给买家。 |
| 出售收款 | 池收到批准的0.1 BNB，买家另付0.001源费；1%/99%债权和逐成员提款守恒，拒收NFT则BEM mint、NFT、款项和记录全部回滚。 |
| 预算两来源 | 原子整合图购买官网#16210和真实Firsto#5788，两子池精确成本、零余款都成功；两矿登记不冲突，批准出售其中一台后真实卖款回预算合约，另一台保持不动。 |
| 已停挖边界 | 真实 owner stop 的本地模拟与明确标注的status0/2/3覆盖已核验零结清；未知status拒绝。生产operator仍无任意stop接口。 |

预算 BEM 账本既有整数原子单位尾差（小于100 atoms）仍留在项目，等待下一笔归集；真实预算测试明确核对这笔尾差，不把它当损失或改成额外手续费。

原 **123728000** 官网/Mining 基准 fork 另有 **42项通过、0失败、5个明确跳过的后期suite**，证据 `protocol-fork-final/summary.json`。这些跳过的5个suite均在上述124308679执行，共12项，不能以旧块的显式跳过代替新出售验证。

最新脚本再次执行的 OZ 26项证据在 `upgrade-final/`，包含该次真实 `verification-input-sha256.json`；5f预算实际布局独立比较在 `budget-layout-comparison.json`。`final-source-consistency.json` 对完整本地门禁与两块fork的清单逐项比较，且重新核对当前34个生产源码文件：**无差异**。初轮 SelfTrade 失败及修正前日志仍保留供复核。最终再次单独执行 `scripts/audit-linked-libraries.mjs` 通过，证据 `linked-audit-final/library-link-audit.json`：8 个直接链接库、递归共 9 个库，源码哈希与编译 metadata 一致；`FirstoSaleExecutor` 的 constructor-only、零 storage、固定 V2 目标、禁止任意低级调用及销毁等 AST 门禁通过。该门禁验证编译模板和限定结构，不代替实际上链后的字节码与链接地址验收。

## 未开放与部署边界

- Firsto 原生页面发布/外部原生直接成交仍关闭；用户已明确同意先用本站受控成交。没有伪造 Firsto native 挂单接受、batch 协议兼容或网页上线证据。
- 固定 proxy 的外部升级是持续依赖；源身份/implementation/hash和手续费必须由部署与交易预检继续核验，本次历史 fork 不是未来代码不变的保证。
- 新 Factory 图不自动覆盖旧 Factory 地址；跨旧新图矿机唯一性、旧资产入口、现有池数和实际升级/迁移须由部署验收明确处理。单一新 core Factory 内的唯一登记与预算子池复用已保留。
- 主网实际 runtime、权限角色、16笔部署记录、费用上限和前后端 manifest 仍需在实际部署环境验收。上述本地/fork结果不足以声称可以无条件投入真实资金。

## 复现入口

在已安装锁定依赖、Foundry 和 Slither 的受支持环境，从仓库根目录执行：

```sh
node scripts/run-forge.mjs fmt --root contracts --check
node scripts/run-forge.mjs build --root contracts --sizes
node scripts/run-forge.mjs test --root contracts --no-match-path 'test/fork/**' -vv
node scripts/validate-upgrades.mjs
node scripts/run-fork.mjs
node scripts/run-firsto-fork.mjs
```

不变量使用 CI 配置的 128 runs × 64 depth。完整门禁及 Slither 参数见 `scripts/check-local.mjs`；两套 fork runner 使用各自固定区块和源码/校验输入哈希，要求可用的 BSC 历史 RPC。环境变量、RPC 来源和日志位置按相应脚本及仓库部署说明配置。fork 使用本地模拟账户、余额和时间，不能将这些命令的模拟成功当成主网交易已发送或已确认。

新增针对性测试入口包括 `contracts/test/unit/FirstoSale.t.sol`、预算治理单测、`contracts/test/unit/IntegratedDeployment.t.sol` 及 `contracts/test/fork/BudgetPortfolioFork.t.sol`。Firsto 的旧块 suite 显式跳过必须与新块 12 项全通过结果一起审阅。