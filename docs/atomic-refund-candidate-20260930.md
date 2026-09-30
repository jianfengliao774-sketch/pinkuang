# 原子撤回退款候选 · 2026-09-30

**状态：未部署、未安排主网升级、未转账；与当前前端发布隔离。** 基于 `67a551dfb0ba5edc79ea38c6c510ff9a3a092f88`。此候选尚未运行远端 CI，也未更新正式部署产物或前端能力清单。

## 变更

- PoolVault 和 BudgetPortfolioVault 新增 `withdrawDepositAndWithdrawBnb()`：在募集阶段撤销本人全部认购，并在同一笔交易中支付本人的全部 BNB 欠款。
- BudgetPortfolioVault 新增 `claimFailedFundingAndWithdrawBnb()`：募集失败已经结算后，同笔兑换份额并退款。
- 原有记账撤回、失败认领与独立提现接口保留；旧、新入口共用私有 helper。拒收 BNB 的合约钱包仍可选择旧记账撤回方式。
- 没有新增或重排 storage。各外部入口保持 `nonReentrant`；接收失败则烧份额、认购金额、成员数和欠款全部回滚。已有本人欠款一起支付，其他成员的资金与欠款独立保留。

单矿机在 `finalizeFailure()` 后，已有 `withdrawBnb()` 就是一笔退款。预算项目购机失败须走原 `finalizeAcquisition()` / `withdrawBnb()`，不能冒充募集失败使用新入口。所有用户退款 Gas 由用户钱包支付。

## 已完成本地验证

七个合约与测试文件从验证目录逐字复制到独立工作区，SHA-256 一致。

- Solidity 0.8.24，optimizer runs=1，Shanghai：干净构建与 `forge fmt --check` 通过。
- CI profile 全量非 fork：**51 套、545 项通过，0 失败、0 跳过**；fuzz 256 轮，invariant 128 轮 × 64 深度。含 16 项新增原子退款专项，以及加入原子撤回的资金守恒随机序列。
- OpenZeppelin **26 项升级验证**通过，包括正确拒绝故意破坏布局的负例；五套已部署 integrated storage 基线检查通过。
- PoolVault runtime **24,474 字节**，BudgetPortfolioVault **24,470 字节**，均低于 24,576 字节限制；没有放宽大小限制。
- **本地 Slither 未运行**：本地没有可用执行文件，后续正式 CI 仍须完成其安全检查。当前验证不代表已完成主网业务测试。

本地证据目录为 `outputs/pinkuang-formal-readiness-20260930/atomic-refund-contracts/`，包括 `forge-test-ci.log`、`upgrade-checks.json`、`integrated-storage.json`、`validation-summary.json`、`isolated-worktree-hashes.json`。`atomic-refund-candidate.json` 明确标记 `not-deployed`，SHA-256 为 `ee2ca67682543fbd2dab9ce5a0fe27625107f109df166a398ae24ac330de3781`。这是编译模板，含库链接或 immutable 待填部分，不是已部署 runtime codehash。

初次升级验证因增量编译残留多个 build-info 被拒绝，随后干净重编译并完整通过；一次未指定 CI profile 的长 invariant 运行主动停止，不能计为通过，已由上述完整 CI profile 结果替代。

## 两套 Beacon 的正式升级步骤

1. 完成独立审阅、远端 CI、Slither、安全产物构建及现网身份检查。分别读取现有单机与预算 Factory 的 Beacon、Beacon 当前实现与 owner 时间锁。
2. 部署两个新实现，构造参数 `OFFICIAL_FACTORY` 必须各自绑定当前正式 Factory；单机使用经验证的库链接。部署后核验工厂绑定、链接地址和完整 runtime codehash。
3. 由治理钱包通过各自时间锁排期 `Beacon.upgradeTo(newImplementation)`；若两者属于同一合法时间锁，可使用 batch。等待以链上 `getMinDelay()` 为准，合约要求至少 48 小时。
4. 到期执行后，核验两套 Beacon 新实现、既有份额、余额、欠款、项目登记及权限。无需重新初始化或迁移 storage。
5. 更新与部署证据匹配的后端 manifest 和前端能力清单，只有完整 codehash 核验通过的合约才开放单笔退款。仅新增 ABI 或前端按钮不能让旧实现支持新函数；未升级的合约保持原能力。
6. 完成小额主网撤回到账、失败退款和重复调用拒绝测试后再正式开放。
