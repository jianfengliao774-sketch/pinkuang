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
