# Integrated-v2 正式升级：签名前核验与阶段边界

本目录的升级工具准备正式部署交易，**不会替用户签名或向 BSC 主网广播**。部署台使用硬件钱包签署；每一步都以链上已核验图、固定编译产物摘要和确定的 calldata 为准。用户曾提供的 Gas 钱包截图文字不足 40 个十六进制位，不能作为地址输入；正式部署时必须从本机安全保存结果读取并独立核对其**公开地址**，不得把私钥导入网页、脚本或仓库。

## 信任锚与预演

- 旧部署记录：服务器私有 `trusted-product-deployment.json` 的已完成 journal。旧产物由部署时的仓库提交 `697f2e337c67a4fc4615737c07ee6d8cc116c177` 导出，其摘要为 `0x7617c81d718e2127be6b1878abad81d7a3c8bf9c4f8cb35bf85755e42df049d7`。`web/public/data/frontend-manifest.json` 是独立发布的旧地址、代码哈希和初始化交易信任锚。不能仅信任用户上传的 journal。
- 新产物：`deploy/public/deployment-artifacts.json`，摘要 `0x328f8f9323c925551bddae687601594b76d073c96bf5946e3bf142516dfacc99`。部署页面构建时固定该摘要；对十个替换合约依次核验链接后的 creation/runtime、immutable、链 ID 和已终结区块。两个 ShareMarket 实例都切到同一新实现。
- 存储布局：运行 `node scripts/validate-integrated-storage.mjs --output docs/storage/Integrated-v2-upgrade-evidence.json`。它对正式已部署提交 `8c5598cf44fe8fb6174969eba12b3baa13f7942b` 的五种可升级目标（PoolFactory、PoolVault、ShareMarket、BudgetPortfolioFactory、BudgetPortfolioVault）做 OpenZeppelin 布局兼容检查。旧基线在 `docs/storage/Integrated-v2-deployed-*.json`，新编译使用 solc 0.8.24、Shanghai、optimizer runs 1。五种布局均需通过。
- 已在非零池真实 BSC 状态的本地 Anvil fork 演练；命令见下文。此演练不代表主网交易已发生。正式签名前仍须重做链上预检、核对旧池/订单与角色、使用硬件钱包。

## 阶段与签署人

1. **暂停建池。** 旧 owner `0x6F4d78fB59eC938cBAF65b9fc822aD04d00c155E` 分别对两套 Factory 签 `pauseCreation(true)`。每一笔之前使用 `validateIntegratedUpgradePreparationAgainstChain` 全量核验旧 23 个 runtime（包括已链接库）、两个代理实现 slot、Beacon、owner、Timelock 和全部历史池，不能只验 Factory 地址。当前已有一座历史池和有效订单；不能采用零池迁移捷径。
2. **硬件钱包取得提案权（Stage0）。** 旧 owner 仍是现任 PROPOSER/CANCELLER，故先由旧 owner 安排 48 小时 Timelock batch，向新的硬件钱包授予 PROPOSER_ROLE 与 CANCELLER_ROLE。可执行者按链上 EXECUTOR_ROLE 或开放执行角色签执行。使用 `buildIntegratedProposerBootstrapPlan` 和 `validateIntegratedProposerBootstrapAgainstChain`；此时保留旧角色，直到 Stage2。
3. **部署十个新实现。** 硬件钱包依次部署 PoolFunds、FlexiblePurchase、SaleSettlement、FirstoSale、SaleGovernance、PoolVault、PoolFactory、ShareMarket、BudgetPortfolioVault、BudgetPortfolioFactory。FlexiblePurchase 和 PoolVault 必须重新链接新版 PoolFunds，不能复用旧库或旧实现。每一笔签名前及回执后使用 `validateIntegratedUpgradePartialReplacementsAgainstChain`，阻止被篡改的前序库地址继续进入下一笔。
4. **原子代码升级（Stage1）。** 硬件钱包安排并在 48 小时后执行唯一的六调用 `scheduleBatch/executeBatch`：两个 ShareMarket 代理、PoolFactory 代理、Pool Beacon、BudgetPortfolioFactory 代理、Portfolio Beacon。安排前调用 `validateIntegratedUpgradePlanAgainstChain`，执行前调用 `validateIntegratedUpgradeScheduledAgainstChain`，执行后调用 `validateIntegratedUpgradeResultAgainstChain`；后者必须证明最终代理/Beacon 图和历史状态。`codeUpgradeComplete` 仅表示代码切换，不表示角色、旧池手续费或 keeper 已完成。
5. **部署并接线 PlatformAuthority（Stage2）。** 这是独立新建合约，**不在 Stage1 六调用内**。构造参数为两套 Factory、两个管理员地址 `0x7674fa446D42b1f7f150DC5e678cc525d275Ea53` 和 `0xed2fcbe59ebe1754a3676aeb9ccfba20f193fcbb`、经核对的 Gas 钱包公开地址。`validateIntegratedAuthorityAgainstChain` 核对 creation/runtime、构造参数、部署交易和 EIP-712 domain。旧 owner 逐笔将两套 Factory 的 operator、treasury 指向 Authority；随后硬件钱包安排/执行 48 小时 Timelock 批次撤销旧 owner 的 PROPOSER/CANCELLER；最后旧 owner 分别把两套 Factory owner 转给 **48 小时 Timelock**。硬件钱包保留 PROPOSER/CANCELLER，不直接持有 Factory owner，因 owner 可即时更改 operator/treasury，直接给硬件钱包会绕过延迟。每笔用 `validateIntegratedRoleMigrationActionAgainstChain` 校验链上前置状态和 signer，最终用 `validateIntegratedRoleMigrationStateAgainstChain` 核对。
6. **历史池手续费独立迁移。** Factory.setTreasury 只影响新池。现存 PoolVault 的 treasury 固定在旧 owner，必须对每个历史池单独安排/执行 48 小时 Timelock `migrateTreasury(expectedOld,Authority)`，使用 `buildIntegratedTreasuryMigrationPlan`、`validateIntegratedTreasuryMigrationActionAgainstChain` 和 `validateIntegratedTreasuryMigrationResultAgainstChain`。Active/Listed 池在迁移时须先严格结清收益；若 claim 失败，该池的操作可能失败，不能把别的池迁移当成它成功。**旧地址已累计的 BNB/BEM 欠款仍归旧地址；只有迁移后的未来手续费流向 Authority。** 当前预算组合数为零；若正式执行前出现历史预算组合，因无现存组合 treasury 迁移 setter，应暂停并重新设计。
7. **完成证明与恢复建池。** `validateIntegratedOnChainMigrationCompleteAgainstChain` 核对 Authority、两套 Factory 的 owner/operator/treasury、旧 Timelock 角色已撤销、全部历史池 treasury 已迁移、预算历史项目为零；只有这时 `roleMigrationComplete=true`。它仍返回 `keeperCutoverVerified=false` 和 `deploymentComplete=false`：须另行核验服务端 keeper/Gas 钱包配置与生产发布，然后用 `buildIntegratedCreationResumePlan` 生成两套 Factory `pauseCreation(false)` 的独立 48 小时 Timelock batch，`validateIntegratedCreationResumeActionAgainstChain` 在安排和执行前重核签署人、旧池、角色和链上操作状态。硬件 PROPOSER 负责安排，待到期后由有效 EXECUTOR 执行；`validateIntegratedCreationResumeResultAgainstChain` 必须重查完整代码/角色/手续费图、两个 Factory 的解除暂停状态和确切 Timelock 事件。该链上证明仍返回 `keeperCutoverVerified=false`；页面/运维须独立证明服务端切换完成。硬件钱包不能直接调用 Factory 的 `pauseCreation`。发布新前后端 manifest 必须晚于 Stage1 链上图验证，不能让旧 ABI 页面提前指向新合约。

## 管理员签名与 Gas 钱包权限

`PlatformAuthority.executeOperation(target,data)` 的无管理员签名白名单仅限已经注册的单机池 `mine(bytes)`。Gas 钱包不能独自建池、建预算项目、建预算子池、暂停存款或选择预算采购订单。下列非日常操作均用 BSC chainId 56、当前 Authority 地址作为 EIP-712 domain，由**任意一位**管理员签名，再由 Gas 钱包代付调用；管理员本人也可自行支付 Gas 提交同一签名。`deploy/scripts/authority-relay.mjs` 提供受保护命令文件的只读预检/代发路径，并校验当前管理员、nonce、到期、Gas 钱包地址和交易状态。

| 外部函数 | Action.kind | target | 签名 paramsHash |
| --- | --- | --- | --- |
| `executeApprovedOperation(target,data,nonce,deadline,signature)` | `APPROVED_OPERATION` | Factory/矿池的精确地址 | `keccak256(data)`，完整 calldata 含所有建池、预算、子池或暂停参数 |
| `buyBudgetOfficial(portfolio,child,listingId,maxCost,nonce,deadline,signature)` | `BUY_BUDGET_OFFICIAL` | 精确预算池 | `keccak256(abi.encode(child,listingId,maxCost))` |
| `buyBudgetFirsto(portfolio,child,encodedOrder,maxCost,nonce,deadline,signature)` | `BUY_BUDGET_FIRSTO` | 精确预算池 | `keccak256(abi.encode(child,keccak256(encodedOrder),maxCost))` |

`maxCost` 用 wei 表示，预算池购买后按 `spentWei` 增量在**同一笔链上交易**校验 0 < 实际成本 ≤ `maxCost`，超额则整笔回滚，不消耗签名 nonce。管理员可直接调用 `invalidateNonce(next)` 使自己所有较低 nonce 的未使用签名失效。低于市场参考价的审核仍按用户选择实行“任意一位管理员”规则，不改成 2/2；同一提案首个有效上链的审核结果终局，冲突签名以链上交易顺序决定，签名前应避免同时签发相反决定。

Gas relay 的私有命令文件还必须携带 `expectedCodehash`，取自部署页已核验的 Authority 运行时代码哈希；发送模式会先比对链上 runtime，缺失或不符一律拒绝。这与 artifact 摘要不同：后者固定编译产物，前者包含构造参数写入的 immutable 地址。服务端仍须核验订单/报价和 maxCost，并等待管理员签名；不可由 Gas 钱包自拟签名参数。

预算份额挂单会锁定卖家的相应份额；只要该钱包仍有锁定份额，`claimBem` 就拒绝领取。挂单前尚未领取的 BEM 会在成交时按份额转给买家，卖家可在订单取消、到期解锁或完全成交后领取其剩余权益。前端仍不得把挂单时的 `claimableBem` 当作成交时的固定收益，因为新挖矿收入和其他份额转让会改变该值；交易预览需重新读取链上状态。

已知剩余风险：活动矿池的份额转移、整机出售交割，以及活动旧池 treasury 迁移均要求先严格结清矿池收益。若上游 Mining 的 `pending` 为正而 `claim` 持续失败，这些操作会一直回滚。不能简单跳过 claim，否则旧持有人应得但未领取的 BEM 可能随份额/矿机交给新持有人。现有 PoolVault 运行时 24,304 字节，距 EIP-170 上限仅 272 字节，尚无经审计的旧收益债权快照/逃生机制。本升级只证明**正常 claim 路径**和本地 fork 当前状态，不能宣称永久冻结风险已消除；出现上述链上状态时须保持建池暂停并进行单独设计与升级。

自动预算购机服务在未取得上述对应订单的管理员签名时必须停止该动作，不能退回到 `executeOperation` 或 Gas 钱包直接调用预算池。完成签名收集/续期、服务端重试去重和端到端测试前，`keeperCutoverVerified` 仍为 false，不能恢复建池。私钥、管理员签名和未播报的交易 journal 只存受保护目录，不进入前端 bundle 或版本库。

旧 `PoolLens` 无 factory setter，本次原地址和 runtime 哈希保持不变。其整机出售治理 `passed/requiredYesShares` 仍反映旧 60 份阈值，已过时；新前端不得信任这两个字段，必须按新合约状态读取。若未来产品必须让 Lens 自身显示新阈值，需另设计可验证迁移，不能在本计划中假装它已切换。

## 真实状态的本地 fork 演练

只在本机启动 Anvil，第二个命令将事务发送给 `127.0.0.1:8547` 的 fork。脚本强制检查 `web3_clientVersion` 包含 Anvil，且 chain ID 为 56；它没有主网私钥或主网写 RPC。以下三份 JSON 应从已核验的旧完成 journal、其旧产物、新产物准备，不进入仓库；不要打印私有 journal 或凭据。

```sh
./deploy/node_modules/.bin/anvil --fork-url https://bsc-mainnet.public.blastapi.io --port 8547 --host 127.0.0.1 --chain-id 56 --silent

node deploy/scripts/rehearse-integrated-upgrade.mjs \
  --genesis-record /private/tmp/pinkuang-integrated-genesis-record.json \
  --genesis-bundle /private/tmp/pinkuang-integrated-genesis-bundle.json \
  --upgrade-bundle deploy/public/deployment-artifacts.json \
  --trusted-manifest web/public/data/frontend-manifest.json
```

该脚本在两笔暂停前做完整旧图校验；随后证明 Stage0、十个新 runtime、Stage1 六调用及后置图、Stage2 Authority 与权限、每个旧池的独立手续费迁移，再独立安排/执行 48 小时恢复建池 batch 并重查解除暂停后的完整链上图。它逐字节比较旧订单、池 state/params、份额总量和旧 owner 余额、募集金额、旧 treasury 的 BNB 欠款在代码升级和手续费迁移前后的值。终态输出包括 `roleMigrationComplete=true` 和本地 fork 中两套 Factory 已解除暂停的断言；由于真实 keeper 切换未在 fork 中验证，`deploymentComplete=false`。

2026-09-29 的真实 BSC 单池 fork 结果保存在 `docs/storage/Integrated-v2-fork-rehearsal-cb7b.jsonl`。Anvil 从主网区块 `124584261` 分叉，两笔本地暂停交易后，校验快照为 `124584263`，哈希 `0xd0ae60f130e55f76ac60315e6e53b5347c9e072d5ef104daabc76e4f72b09272`；已有 1 池、0 预算项目、2 个历史订单。候选产物摘要为 `0xcb7bb22596c33558a3f3060fffeb8b3f6c63521e9195f59eaa6a6df7618d116c`，演练日志 SHA-256 为 `7da5a60ddb92a7b8d081e9a70306f1e03e9ccb8496a7112bb6cf5c0d1cdb0b30`。Stage0、十个替换实现、Stage1、Authority/角色迁移、历史池独立 treasury 迁移及恢复建池 batch 均在**本地 fork**成功；旧池仍有 100 份、旧 owner 99 份、旧 BNB 欠款 0 wei，订单原字节不变，treasury 转向 fork 中的 Authority 地址，两套 Factory owner 均变为 48 小时 Timelock。此前摘要为 `0x98ed53dbb171c960aa6423c45f51bc563ffae0ebe614ccb9e1a80c3d57c6de84` 的演练另存 `docs/storage/Integrated-v2-fork-rehearsal.jsonl`，不能替代新候选证据。`keeperCutoverVerified` 和 `deploymentComplete` 仍为 false，不能据本地演练宣称主网上线。

正式部署若签名/发送结果不明，先按 operationId、tx hash、nonce 和链上状态恢复；不得盲目重发。每次签署前重新校验最新已终结区块，不靠浏览器保存的旧 preflight 直接授权。
