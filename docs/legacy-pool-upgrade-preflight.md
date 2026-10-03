# F04：旧收益池升级前只读预检

`RewardAccounting._validateLegacy` 对旧到期收益账本实行安全拒绝：超过 64 个 checkpoint、超过 7 日仍未领取/销毁的旧批次，或批次未付总额与 `bemAccounted` 不一致，都会阻止第一次切换为永久收益。**不能通过删除校验、清零账本或重新记入已销毁 BEM 来“修复”。**

目前仓库没有已核实的 BSC 主网 Factory 部署地址或创建区块，所以下述预检**尚不能对生产旧池执行**，也不能据此宣称旧池已安全迁移。取得部署记录后，升级 Beacon 之前先运行：

```bash
cd deploy
BSC_RPC_URL="$BSC_ARCHIVE_RPC" node scripts/legacy-pool-preflight.cli.mjs \
  --factory "$FACTORY_ADDRESS" --factory-codehash "$FACTORY_PROXY_CODEHASH" \
  --from-block "$FACTORY_DEPLOY_BLOCK" \
  > legacy-pool-preflight.json
```

工具只使用 `eth_chainId`、`eth_call`、`eth_getCode`、`eth_getStorageAt`、`eth_getLogs`、`eth_getBlockByNumber`；不需要私钥或钱包，也不发送交易。它要求链 ID 为 56，Factory 的部署前一区块无代码、部署区块和固定快照区块有相同代理代码，并且该代码哈希与经审阅的部署记录 `--factory-codehash` 完全一致；所有读数固定在距链头至少 12 个区块的同一区块。`--from-block` 必须是 Factory 的实际部署区块，需要归档 RPC；历史状态不可用时直接失败。默认确认深度 15，`--confirmations` 可增加，`--scan-range` 可调低以适应 RPC 的日志页限制。

默认从 Factory 的 `poolCount/allPools` 枚举**全部**池。可用 `--pools 0xA,0xB` 缩小诊断范围，但只检查子集时 `releaseGate` 一定是 `BLOCKED`。每个池都核对 Factory 注册、反向绑定、合约代码和公开收益 getter 与 ERC-7201 原始存储的一致性。对含旧 checkpoint 或旧迁移标记的池，报告记录每个历史 epoch 的净收入、已付、已销毁、燃烧标记和未付；历史 `Transfer` 中出现过的持有人（包括当前 0 份者）的份额、旧槽、待领款与奖励债务；以及池中 BEM 余额、总账和代码哈希。日志重新计算的份额余额必须与链上余额及总供应量吻合。

退出码 `0` 只表示在完整扫描范围内未发现 **F04 旧到期收益阻断**，**不是**升级授权或完整安全审计。发现 `expiryEnabled`、旧 checkpoint、旧迁移标记时，结果一律为 `BLOCKED`，即使报告中的 `hypotheticalAutomaticCutoverCheck` 为 `true`；该字段只是复核合约当前有界条件的诊断。子集、未知状态、缺失代码、RPC 错误和读数冲突同样阻断。`BLOCKED` 输出 JSON 并以退出码 `2` 结束；无法固定可信快照时以 `1` 结束。不要把命令返回非零理解为可以跳过的提示。

旧池的下一步是逐池审核源版本和存储布局、核实全部历史债权和资产余额，设计并单独审计可恢复的迁移方案，明确第一次 cutover 的执行时点与链上结果。验收应覆盖新老持有人、已清仓的旧持有人、部分领取、转份前后、已出售池、64/65 checkpoint 边界、旧出售预算、整数尾差和重复调用，并核对任何时点总债务不超过实有 BEM。**此工具不执行迁移，也无法从单一链上状态证明历史 RPC 从未遗漏日志；运营方仍需留存部署和事件证据。**
