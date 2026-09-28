# Integrated-v2 正式升级：签名前核验与阶段边界

本目录的升级工具准备正式部署交易，**不会替用户签名或向 BSC 主网广播**。部署台使用硬件钱包签署；每一步都以链上已核验图、固定编译产物摘要和确定的 calldata 为准。用户曾提供的 Gas 钱包截图文字不足 40 个十六进制位，不能作为地址输入；正式部署时必须从本机安全保存结果读取并独立核对其**公开地址**，不得把私钥导入网页、脚本或仓库。

## 信任锚与预演

- 旧部署记录：服务器私有 `trusted-product-deployment.json` 的已完成 journal。旧产物由部署时的仓库提交 `697f2e337c67a4fc4615737c07ee6d8cc116c177` 导出，其摘要为 `0x7617c81d718e2127be6b1878abad81d7a3c8bf9c4f8cb35bf85755e42df049d7`。`web/public/data/frontend-manifest.json` 是独立发布的旧地址、代码哈希和初始化交易信任锚。不能仅信任用户上传的 journal。
- 新产物：`deploy/public/deployment-artifacts.json`，摘要 `0x514ce9de54b07fb0bab71733bb92a513006918a7d4161334493ced5d16fc352d`。部署页面构建时固定该摘要；对十个替换合约依次核验链接后的 creation/runtime、immutable、链 ID 和已终结区块。两个 ShareMarket 实例都切到同一新实现。
- 存储布局：运行 `node scripts/validate-integrated-storage.mjs --output docs/storage/Integrated-v2-upgrade-evidence.json`。它对正式已部署提交 `8c5598cf44fe8fb6174969eba12b3baa13f7942b` 的五种可升级目标（PoolFactory、PoolVault、ShareMarket、BudgetPortfolioFactory、BudgetPortfolioVault）做 OpenZeppelin 布局兼容检查。旧基线在 `docs/storage/Integrated-v2-deployed-*.json`，新编译使用 solc 0.8.24、Shanghai、optimizer runs 1。五种布局均需通过。
- 已在非零池真实 BSC 状态的本地 Anvil fork 演练；命令见下文。此演练不代表主网交易已发生。正式签名前仍须重做链上预检、核对旧池/订单与角色、使用硬件钱包。

## 阶段与签署人

1. **暂停建池。** 旧 owner `0x6F4d78fB59eC938cBAF65b9fc822aD04d00c155E` 分别对两套 Factory 签 `pauseCreation(true)`。每一笔之前使用 `validateIntegratedUpgradePreparationAgainstChain` 全量核验旧 23 个 runtime（包括已链接库）、两个代理实现 slot、Beacon、owner、Timelock 和全部历史池，不能只验 Factory 地址。当前已有一座历史池和有效订单；不能采用零池迁移捷径。
2. **硬件钱包取得提案权（Stage0）。** 旧 owner 仍是现任 PROPOSER/CANCELLER，故先由旧 owner 安排 48 小时 Timelock batch，向新的硬件钱包授予 PROPOSER_ROLE 与 CANCELLER_ROLE。可执行者按链上 EXECUTOR_ROLE 或开放执行角色签执行。使用 `buildIntegratedProposerBootstrapPlan` 和 `validateIntegratedProposerBootstrapAgainstChain`；此时保留旧角色，直到 Stage2。
3. **部署十个新实现。** 硬件钱包依次部署 PoolFunds、FlexiblePurchase、SaleSettlement、FirstoSale、SaleGovernance、PoolVault、PoolFactory、ShareMarket、BudgetPortfolioVault、BudgetPortfolioFactory。FlexiblePurchase 和 PoolVault 必须重新链接新版 PoolFunds，不能复用旧库或旧实现。每一笔签名前及回执后使用 `validateIntegratedUpgradePartialReplacementsAgainstChain`，阻止被篡改的前序库地址继续进入下一笔。
4. **原子代码升级（Stage1）。** 硬件钱包安排并在 48 小时后执行唯一的六调用 `scheduleBatch/executeBatch`：两个 ShareMarket 代理、PoolFactory 代理、Pool Beacon、BudgetPortfolioFactory 代理、Portfolio Beacon。安排前调用 `validateIntegratedUpgradePlanAgainstChain`，执行前调用 `validateIntegratedUpgradeScheduledAgainstChain`，执行后调用 `validateIntegratedUpgradeResultAgainstChain`；后者必须证明最终代理/Beacon 图和历史状态。`codeUpgradeComplete` 仅表示代码切换，不表示角色、旧池手续费或 keeper 已完成。
5. **部署并接线 PlatformAuthority（Stage2）。** 这是独立新建合约，**不在 Stage1 六调用内**。构造参数为两套 Factory、两个管理员地址 `0x7674fa446D42b1f7f150DC5e678cc525d275Ea53` 和 `0xed2fcbe59ebe1754a3676aeb9ccfba20f193fcbb`、经核对的 Gas 钱包公开地址。`validateIntegratedAuthorityAgainstChain` 核对 creation/runtime、构造参数、部署交易和 EIP-712 domain。旧 owner 逐笔将两套 Factory 的 operator、treasury 指向 Authority；随后硬件钱包安排/执行 48 小时 Timelock 批次撤销旧 owner 的 PROPOSER/CANCELLER；最后旧 owner 分别把两套 Factory owner 转给硬件钱包。每笔用 `validateIntegratedRoleMigrationActionAgainstChain` 校验链上前置状态和 signer，最终用 `validateIntegratedRoleMigrationStateAgainstChain` 核对。
6. **历史池手续费独立迁移。** Factory.setTreasury 只影响新池。现存 PoolVault 的 treasury 固定在旧 owner，必须对每个历史池单独安排/执行 48 小时 Timelock `migrateTreasury(expectedOld,Authority)`，使用 `buildIntegratedTreasuryMigrationPlan`、`validateIntegratedTreasuryMigrationActionAgainstChain` 和 `validateIntegratedTreasuryMigrationResultAgainstChain`。Active/Listed 池在迁移时须先严格结清收益；若 claim 失败，该池的操作可能失败，不能把别的池迁移当成它成功。**旧地址已累计的 BNB/BEM 欠款仍归旧地址；只有迁移后的未来手续费流向 Authority。** 当前预算组合数为零；若正式执行前出现历史预算组合，因无现存组合 treasury 迁移 setter，应暂停并重新设计。
7. **完成证明与恢复建池。** `validateIntegratedOnChainMigrationCompleteAgainstChain` 核对 Authority、两套 Factory 的 owner/operator/treasury、旧 Timelock 角色已撤销、全部历史池 treasury 已迁移、预算历史项目为零；只有这时 `roleMigrationComplete=true`。它仍返回 `keeperCutoverVerified=false` 和 `deploymentComplete=false`：须另行核验服务端 keeper/Gas 钱包配置与生产发布，再由新硬件 owner 分别签 `pauseCreation(false)`，核对后才能称正式上线。发布新前后端 manifest 必须晚于 Stage1 链上图验证，不能让旧 ABI 页面提前指向新合约。

旧 `PoolLens` 无 factory setter，本次原地址和 runtime 哈希保持不变。其整机出售治理 `passed/requiredYesShares` 仍反映旧 60 份阈值，已过时；新前端不得信任这两个字段，必须按新合约状态读取。若未来产品必须让 Lens 自身显示新阈值，需另设计可验证迁移，不能在本计划中假装它已切换。

## 真实状态的本地 fork 演练

只在本机启动 Anvil，第二个命令将事务发送给 `127.0.0.1:8547` 的 fork。脚本强制检查 `web3_clientVersion` 包含 Anvil，且 chain ID 为 56；它没有主网私钥或主网写 RPC。以下三份 JSON 应从已核验的旧完成 journal、其旧产物、新产物准备，不进入仓库；不要打印私有 journal 或凭据。

```sh
./deploy/node_modules/.bin/anvil --fork-url https://bsc-mainnet.public.blastapi.io --port 8547 --host 127.0.0.1 --chain-id 56 --silent

node deploy/scripts/rehearse-integrated-upgrade.mjs \
  --genesis-record /private/tmp/pinkuang-integrated-genesis-record.json \
  --genesis-bundle /private/tmp/pinkuang-integrated-genesis-bundle.json \
  --upgrade-bundle /private/tmp/pinkuang-final-upgrade-bundle.json \
  --trusted-manifest web/public/data/frontend-manifest.json
```

该脚本在两笔暂停前做完整旧图校验；随后证明 Stage0、十个新 runtime、Stage1 六调用及后置图、Stage2 Authority 与权限、每个旧池的独立手续费迁移。它逐字节比较旧订单、池 state/params、份额总量和旧 owner 余额、募集金额、旧 treasury 的 BNB 欠款在代码升级和手续费迁移前后的值。终态输出包括 `roleMigrationComplete=true` 的链上断言；`deploymentComplete=false` 直到 keeper 切换和解除暂停被单独核验。

2026-09-29 的真实 BSC 单池 fork 结果保存在 `docs/storage/Integrated-v2-fork-rehearsal.jsonl`。起点区块 `124581763`、哈希 `0xf05e8bfc5517aa8d83ca2c37e41238ef08a9a69776e4140088d0b42cf22e774f`；已有 1 池、0 预算项目、2 个历史订单。Stage0、十个替换实现、Stage1、Authority/角色迁移、历史池独立 treasury 迁移均在**本地 fork**成功；旧池仍有 100 份、旧 owner 99 份、旧 BNB 欠款 0 wei，订单原字节不变，treasury 转向 fork 中的 Authority 地址。该结果是在上面列出的 M-3 追加修复前的候选产物上取得；修复后必须重新生成产物并重演，不能把旧摘要当作最终候选。

正式部署若签名/发送结果不明，先按 operationId、tx hash、nonce 和链上状态恢复；不得盲目重发。每次签署前重新校验最新已终结区块，不靠浏览器保存的旧 preflight 直接授权。
