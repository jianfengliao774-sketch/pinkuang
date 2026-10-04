# 固定目标所有者升级：2026-10-05 公开状态

本页只记录已发生的链上事实和执行前缺口，不是执行授权。BSC 主网候选 artifact 摘要为 `0xc9be5208ec97a0513d29c5f1d35a9e89f54c998b5994d2a291c09e5e496881e5`；现行已部署 artifact 摘要为 `0xbe37228e94095440e9cde68ae7b5e605b75154a5c7453d58b796ddb2925ec927`。

- 新 `PoolFunds` 库 `0x1bE05BE7D954F780E768d931fA0207739F80421D`、`FlexiblePurchase` 库 `0x63A5941b7228efb499c01a58495a5bCd56d5d254` 和 `PoolVault` 实现 `0x40bab6bdDBA9aFb2CCd6Ddc44678997284173579` 均已有链上代码，并与候选编译 runtime 及相互链接逐字节匹配。另有未选用的重复 `PoolFunds` 部署 `0x00eB4BE0695db8d93685C8f04F1676D67318571b`。
- 时间锁 `0x2c0AaE63302A7bF7caF5322Cdfc9da67d4ec8F97` 已在成功交易 [`0xb9357d5e…`](https://bscscan.com/tx/0xb9357d5e109556eed8f613add88b30b40bbc9a24ea4a00f8f8df731ac2da76f8) 中排程 Beacon `0x326Ef311677d4e2952B7C83D7fc28EF9088d94a9` 的 `upgradeTo(0x40bab6bdDBA9aFb2CCd6Ddc44678997284173579)`。操作 ID 为 `0x4f29ead20ca5a72a93712bd2c589f261ad81a33afe09befa1c43626c5a0630f4`，等待期为 172800 秒，**最早 2026-10-06 18:00:33 CST**。截至核验区块 125708684，该操作 `pending=true`、`done=false`，Beacon 仍指向旧实现 `0x9c359621a531629a43565166f87db7d3ae78310d`。部署和排程不等于升级生效。
- 候选合约只锁定原始 ERC-721 `ownerOf` 并在所有权变化时阻止认购或触发提前退款。**同一持有人撤单、官网下架或 Firsto 挂单失效，未改变 NFT 所有权时，这次升级不覆盖。**网页过滤无法阻止合约直调。需另行确定链上可验证的可购性来源与具体修补版本，不能把当前候选描述为“撤单自动退款”。
- 执行 Beacon 升级前，正式目录、索引、采购及挖矿 worker 均需安装和验证识别新 `targetOwnerVersion` / 未配置旧池的配套 runtime；当前服务器正式 release 和相关环境键仍是旧图，尚未完成。11 个现存池中有 9 个 Funding；升级后这些历史池最初未配置原始所有者，新 `deposit` 会拒绝直调。历史池逐一读取原始所有者、经 **两位现任管理员分别签名** 的一次性 `configureTargetOwner` 迁移、签名域与 nonce/期限核验及链上结果复查也尚未完成。上述是执行前缺口，不应以已排程代替验收。

只含公开链上数据的完整哈希、地址、链接及 calldata 核验记录：`/private/tmp/bemine-target-owner-activation-status-20261005.json`。以上状态是 2026-10-05 00:31 CST 的只读快照；执行前必须刷新链上状态。
