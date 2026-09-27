# Firsto 升级后的混合部署证据

此工具只读核验已经完成的升级，在本地生成可信记录和前端清单。它不部署、不提案、不执行时间锁、不签名、不更改正式服务。开发代码和产物已经更新，不表示主网已经升级。

## 为何需要两份编译包

原主网 Factory、Market、Lens、Beacon、Timelock 和 AtomicDeployment 不会因编译新版本而重新部署。新版产物可能连未改业务逻辑的合约元数据都不同，不能把新包的运行时代码摘要套到旧地址上。

`product-graph.mjs` 的 schema1 原部署校验保持有效。schema2 原四项固定类型为 `firsto-permanent-unique-upgrade-v1`；份额市场双边收费增加独立的五项固定类型 `firsto-permanent-unique-share-fee-upgrade-v1`。两者都必须从服务器本地分别配置旧可信记录、旧编译包和新编译包；浏览器请求不能提交或替换信任依据。旧记录整体摘要、两份构建摘要均需一致，旧四项记录仍按原路径验证。

原四项类型的替换范围不变。新五项类型仅多允许 ShareMarket 实现升级；不能通过记录中的任意地址/代码摘要扩大范围：

| 节点 | 验证来源和链接 |
| --- | --- |
| PurchaseValidation | 新包、新部署，无外部库链接 |
| FlexiblePurchase | 新包、新部署；链接新的 PurchaseValidation 和旧 PoolFunds |
| PoolVault | 新包、新部署；链接新的 FlexiblePurchase 和其余旧库，构造参数绑定原 Factory 代理 |
| PoolFactory | 新包、新部署，无外部库链接；原 Factory 代理只改变实现槽 |
| ShareMarket（仅五项类型） | 新包、新部署，无外部库链接；原 Market 代理只改变实现槽，`feeBps()` 和 `buyerFeeBps()` 均须为 100 |
| 其它库、AtomicDeployment、两代理、Lens、Beacon、Timelock，以及四项类型的 Market 实现 | 保留旧地址，按旧编译包和旧记录运行时代码摘要核验 |

四项类型的四笔、五项类型的五笔部署须为原部署账户直接发送的零值 CREATE 交易；逐笔核对链号、发送人、nonce 推导地址、创建回执、完整链接后的 initcode 与构造参数。全部部署与时间锁交易的 transaction/receipt 索引须一致，且 canonical 区块的该索引必须对应同一交易哈希；结束时重读最终确认锚点。不能只检查代码存在，也不能把记录里的 `codehash` 当成新信任依据。

## 支持的时间锁批次和迁移范围

原四项类型的同一个 `executeBatch` 必须按顺序、零 BNB 执行：

1. 原 Factory：`upgradeToAndCall(newFactoryImplementation, 0x)`。
2. 原 Beacon：`upgradeTo(newPoolVaultImplementation)`。
3. 原 Factory：`beginMachineRegistryMigration()`。

五项类型在第 2 与第 3 步之间增加原 ShareMarket 代理的 `upgradeToAndCall(newShareMarketImplementation, 0x)`。计划必须声明 `kind: "firsto-permanent-unique-share-fee-upgrade-v1"`，`deployments` 必须恰好包含原四项与 `ShareMarket` 五项。证明逐笔核对 Market 的 CREATE 地址、initcode、同一时间锁批次中的第 3 条调用、CallScheduled/CallExecuted 事件、Market 代理发出的 Upgraded 事件、新实现槽及双边费率。批次目标、顺序、值、calldata 或事件任何一项变化均拒绝。

**五项同批路径只适用于原四项升级尚未执行的原始部署。** 如果四项已经上链，不能把既有执行记录和后续 Market 升级拼成这份五项同批证明；必须另做两阶段、Market-only 的严格证据路径。未完成该路径前，升级 Market 后的产品签名服务会按混合图核验拒绝授权，不应绕开证明。

提案必须由原 owner 地址直接调用时间锁，延迟至少 172800 秒；执行者仍可依合约的公开执行角色完成。前序操作固定为零。工具重算 operation ID，逐字匹配 schedule/execute calldata、按类型恰好三条或四条的 CallScheduled/CallExecuted 事件、Factory/Beacon 及五项类型的 Market Upgraded 事件与迁移开始事件，并要求链上 operation 已完成。所有部署/提案/执行回执均须成功、canonical 且已 finalized。

**本版自动证据导出仅支持升级时历史池数为 0。** 升级前一块池数须为零，执行交易内迁移 cutoff 须为零；核验时 initialized/ready 均为真、cursor/cutoff 均为零。之后创建新池不会改变历史 cutoff，不会使证据失效。存在任何历史池、迁移冲突或未就绪均拒绝导出；不能把此工具描述为已支持任意数量旧池迁移。合约中的分批迁移功能另有测试，不等于这里已支持该运维路径。

本版也不接受钱包辅助合约或委托账户把部署/时间锁调用包在另一笔 calldata 中。遇到此情况须提供单独经过审查的精确包装调用证明，不能跳过目标或 calldata 校验来放行。

## 只读生成流程

先保存未经覆盖的旧部署记录和旧包。升级完成并最终确认后，准备一份本地 plan JSON，填入四个新地址及实际交易哈希：

```json
{
  "deployments": {
    "PurchaseValidation": { "address": "0xNEW_LIBRARY", "txHash": "0xCREATE_HASH" },
    "FlexiblePurchase": { "address": "0xNEW_LIBRARY", "txHash": "0xCREATE_HASH" },
    "PoolVault": { "address": "0xNEW_IMPLEMENTATION", "txHash": "0xCREATE_HASH" },
    "PoolFactory": { "address": "0xNEW_IMPLEMENTATION", "txHash": "0xCREATE_HASH" }
  },
  "operation": {
    "scheduleTxHash": "0xSCHEDULE_HASH",
    "executeTxHash": "0xEXECUTE_HASH",
    "salt": "0x32_BYTE_SALT",
    "predecessor": "0x0000000000000000000000000000000000000000000000000000000000000000"
  }
}
```

五项类型的 plan 还需增加 `"kind": "firsto-permanent-unique-share-fee-upgrade-v1"`，以及 `"ShareMarket": {"address": "0xNEW_MARKET_IMPLEMENTATION", "txHash": "0xMARKET_CREATE_HASH"}` 部署记录；其余字段与上述格式相同。不要将占位地址用于实际验证。

以上为格式占位示例。生成命令在 `deploy/` 下执行，输出文件必须尚不存在：

```sh
node scripts/verify-firsto-upgrade.mjs \
  --genesis-record /private/genesis-record.json \
  --genesis-bundle /private/genesis-artifacts.json \
  --upgrade-bundle /reviewed/new-deployment-artifacts.json \
  --plan /private/upgrade-plan.json \
  --rpc https://YOUR_REVIEWED_BSC_RPC \
  --out-record /private/verified-upgrade-record.json \
  --out-manifest /private/verified-upgrade-frontend-manifest.json
```

节点必须支持所需历史交易、回执、区块和历史 `eth_call`，以及 finalized 标签。工具不读取钱包密钥。只有全部检查成功才输出文件，使用排他创建，不能覆盖原始部署证据或正式清单。两个输出文件本身不启用任何线上功能。

上线配置中，当前可信记录路径改指 schema2 文件，当前产物路径指新包；另加 `BEMINE_GENESIS_RECORD_PATH` 和 `BEMINE_GENESIS_ARTIFACT_PATH` 指向保留的旧文件。`productGraphConfiguration` 对应参数为 `genesisRecordPath`、`genesisBundlePath`。签名许可仍需新鲜核对完整混合图、角色、实现槽、原 Factory 不变量和升级证明。

## 前端、索引和旧服务

生成的公开 manifest 保持 schema1：五个原代理/辅助地址和 codehash 保留，`deployment` 仍是原初始化交易和原区块；`artifactDigest/sourceCommit` 绑定新 ABI 构建，`verifiedBlockNumber` 为升级之后的已最终确认核验块。摘要仍不包含提交号，以兼容相同产物不同提交；加载时对外来源取当前可信编译包的提交号，原记录元数据保留作历史参考。附带的 upgrade 字段仅描述来源，不是可绕过核验的授权开关。

索引的 Factory、Market 和 `CHAIN_INDEX_START_BLOCK` 必须保持原始部署历史起点；不能把起点改为升级块而漏掉既往认购与成交。索引加载新 ABI、保留旧兼容事件，并为新增 FirstoPurchased 留存详细费用，购机总额仍只计 Purchased。当前 indexer 不直接导入部署记录；产品签名授权以同源部署后台的严格混合图校验为准。

实际使用的是 `/bemine/api/journal` 对应的 `deploy/server` 后台。旧的独立 `web/server/live-api.mjs` 仍只支持 schema1 原部署记录，不支持此升级记录，不能换用该进程规避新图校验。

升级执行后、可信记录与前端新清单尚未切换时，旧图检查会拒绝新签名。这是版本不一致的正常保护；不要关闭运行时代码检查来消除错误。服务切换、用户钱包授权和主网小额验收均须另外执行。

份额市场升级前还须独立验证存储布局：仓库根目录运行 `npm run validate:upgrades`，确认 OpenZeppelin 对交付的 ShareMarket 基线与当前编译布局的报告通过，且 ERC-7201 MarketStorage 的七个既有字段顺序、类型和槽保持一致。公开部署 bundle 只有 ABI/字节码，没有 `storageLayout`；链上证明不能代替布局验证。若正式旧实现与交付的布局基线不是同一版本，必须取得其对应编译布局再比较，不可仅凭这份静态报告上线。

2026-09-27 的只读探针在 BSC 区块 **124352524** 读取公开测试清单中的 Factory `0xcB24E7F96D81037086A268d6ea63c53f91D412A2`、Market `0x0B274eFD3E33139209D1C62512F7e2345F16dD3c`：`poolCount()` 为 0，Factory `machineRegistryStatus()` 回滚，Market `feeBps()` 为 100、`buyerFeeBps()` 回滚。它表明这两个代理当时未显示五项版本，且 Factory 尚未显示含无条件只读 `machineRegistryStatus()` 的新实现；这只是当时的 RPC 观察，不能替代正式 genesis 记录、最终确认块及完整升级证明，也不表示升级已经执行。

## 可复现测试

```sh
node --test server/product-graph.test.mjs server/product-graph-upgrade.test.mjs
```

覆盖旧 schema1 回归、混合包、严格链接/构造参数、错误 CREATE 身份、篡改 calldata/批次顺序/目标、最终确认与重组、非零旧池、迁移状态、权限/实现槽、失败后排空读取，以及生成清单不改变原历史起点。测试使用模拟 RPC，不代表已完成真实主网升级。
