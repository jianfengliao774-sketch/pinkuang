# 项目创建成功但列表未更新（2026-10-02）

## 证据

测试交易 `0x0c8621f8580767e98cdbb9eb5fd62755cc5589f58ae2066619ad27a609584908` 回执状态为 1，创建区块 125194512，矿机编号 16736。项目地址 `0x0d776f099fe694e07a7509334067b1f92f68cd0e`。测试索引停在 125194496，展示缓存仍为空。

公共 BSC 节点在旧区块的 isPool/designatedSubscriber 返回 missing trie node；独立日志节点返回 CUPS 吞吐上限错误，备用公共节点不提供历史状态。CUPS 错误不等同月度额度耗尽。最新 confirmed 区块的永久登记可读取。

## 修改

只对 manifest 绑定并通过 codehash 验证的 fresh required 模式，将永久创建登记、指定认购者、项目绑定、子矿机购买身份的读取固定在本轮 confirmed safe head。FreshPoolFactory 的 isPool 和 designatedSubscriber 只在创建时写入；预算项目的绑定和 childInfo 的购买身份字段亦无后续修改入口。

创建/购买发生时间仍来自原始链上事件，逐块验证 canonical headers、创建 blockHash 和最终扫描 tip；confirmed 登记证明的区块 hash 在提交前再次检查。childInfo 的可变 sold 字段不参与身份验证；余额、份额、售价、收益等可变数据不因此改为 latest。未绑定 fresh manifest 的旧模式继续按历史区块读取。没有删除数据库、手工插入项目、修改合约、签名或广播交易。

正式版索引当时已同步，但有同样的历史登记读取代码，因此同一修复在独立正式分支实施；不替换正式合约、管理员、Gas 钱包或测试配置。

## 验证

链索引测试 111 项通过，覆盖 pruned 历史状态下新项目/预算子机补齐、预约回填、未绑定图保留旧行为、证明 head 改变及伪造创建日志拒绝提交；原有重组、历史完整性、RPC 超时/降级等测试通过。服务更新只重启各自的索引服务，保留静态站点和财务服务。

## 日志读取配置

测试站 rpc.env 原先覆盖激活默认配置，把扫描批次从 500 降到 50，以适应 public.1rpc.io 的 50 区块上限。实测该备用节点仍间歇失败，bsc.publicnode.com 对同一项目 500 区块日志可返回 3 条实际日志。测试站备用日志节点调整为 bsc.publicnode.com、扫描批次恢复为 500；付费主日志节点保持原配置；主状态读取节点最初保留原配置。服务原有 chain ID、末端区块 hash 跨节点检查继续执行；失败不提交历史。不将新备用配置覆盖到同步正常的正式版。受保护 rpc.env 原文备份只留在服务器 operations 目录，不入仓库。每 500 区块全局日志批次从 10 组降到 1 组，减少重复证明与请求；逐块 header 验证保留。

补历史完成后，测试站原 bsc-dataseed.bnbchain.org 在 latest header 连续报 SERVER_ERROR，展示仍保留新项目缓存。测试索引的 CHAIN_INDEX_RPC_URL 后续改为已验证可读的 bsc.publicnode.com；只改索引读取配置，不修改签名/Gas/购机/挖矿节点配置或正式版节点配置。重启后继续从已提交 cursor 同步，保留数据库；所有 chain ID、manifest、canonical/header 与完整性检查保持。

## 恢复结果

测试索引追至 125199939，complete=true、unknownReason=null；独立正式索引也在补丁后恢复同步。测试公网配置、项目展示、统计接口均 200，通过实际前端 data client 读取 1 个已登记项目；断言 poolAddress=0x0d776f099fe694e07a7509334067b1f92f68cd0e、tokenId=16736、state=0（募集中）。显示读取无浏览器 RPC；项目/统计缓存读取约 0.75 秒。正式公网缓存仍返回原来的 1 个项目，没有混入测试项目。公共节点同步期间的短暂 latest/eth_getCode 错误由既有有界重试恢复，已有新项目缓存保留。
