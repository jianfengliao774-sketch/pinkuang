# 整合版后台、恢复与索引交付说明

本说明对应 `integrated-v2` 新部署源码。旧线上地址与服务不因此自动升级。文档中的命令、开关与地址字段是部署资料，不表示已经运行签名器或发布服务。

## 部署图与恢复

`schemaVersion: 1, kind: integrated-v2` 共 16 笔：原八个库、FirstoSale、AtomicDeployment、PoolVault、PoolFactory、ShareMarket、BudgetPortfolioFactory、BudgetPortfolioVault、initialize。最后一笔为 `deployIntegratedSingleOwner`，单笔原子建立核心和预算两张图；预算市场代理与核心市场共享 ShareMarket 实现，各绑定自己的 Factory。

记录保留原字段，新增 `portfolioFactory`、`portfolioBeacon`、`portfolioShareMarket`、`portfolioVaultImplementation`、`portfolioFactoryImplementation`；后两个必须与部署步骤地址相同。产品清单将市场和 Vault 实现分别映射为 `portfolioMarket`、`portfolioImplementation`。后台验证两张图的每个运行时代码、链接库、实现槽、immutable Factory、owner/operator/treasury、48 小时 Timelock 和双边 1% 份额费。客户端不能通过额外 target 或自行提供 manifest 放行任意合约。

旧无 kind 的 13 步部署与旧四/五节点升级证据保留只读核验及 nonce 恢复兼容，不能拿新版编译产物冒充旧产物。冻结的旧编译 fixture 位于 `deploy/scripts/fixtures/legacy-deployment-artifacts.json.gz`，来自 `5f160c579e9d3d382df199cb29dc1573f5ae992e:deploy/public/deployment-artifacts.json`，仅用于旧路径回归。

部署 record 的 kind、产物摘要、账户、交易 data、nonce 与预览字段不可改变。集成初始化被钱包包装时，必须核对五个按序的协调器事件、两个预测 Factory、协调器部署者、真实运行时代码和最终图。已广播结果不明时依然禁止自动重发。

## 采购、出售和资金流

1. 单台项目沿用核心 Factory 建池、100 份募集。官网 CircuitMarket 采购由 Pool 合约支付，NFT 接收者为 Pool。Firsto V2 采购也从 Pool 付款并将 NFT 留在 Pool。
2. 预算项目由 BudgetPortfolioFactory 创建，整个父项目只有 100 份。运营者为候选矿机创建尚无成员的核心子池，然后从父项目调用 `buyOfficial(child, listingId)` 或 `buyFirsto(child, encodedOrder)`。父项目取得子池全部 100 份，子池拥有 NFT。质量、预算与单机上限由合约复核；完成后 `finalizeAcquisition()` 结算官网采购服务费与募集余款。
3. 子池 Harvest 后通过父项目 `collectChildBem(child)` 收入，再由父份额持有人领取。不能把父项目和子池看作两次募集或两笔独立 BEM 收入。
4. 出售入口为 Pool 的 `completeFirstoSale(expectedProposalId, expectedSalePrice, expectedFeeBps, expectedFeeEpoch)`。买方总付为价格加 Firsto 买方费（整数除法），NFT 接收人是买方。后台重新读取固定 Firsto 代理及实现哈希、当前费率及 epoch、批准提案、售价和期限，并模拟精确 calldata/value；旧 `completeSale` 禁止产生新签名许可。
5. 售前严格结清 BEM 与冷却条件由新合约在同笔交易保证。Firsto 的 payout 指向子池，售款先到合约。预算售出后 `settleChildSale()` 收取子池 99% 净款并记入父项目成员债权，不再次扣平台销售费。份额转移时未领 BEM 跟随份额，既有 BNB 权益由合约结算并保留给原成员。

当前受控出售不等于已经支持 Firsto 原生网页刊登。外部订单发布 API、合约卖家签名受理与官方路由兼容尚需实际验收；没有这些证据时保持入口关闭，不能用普通静态 ERC-1271 签名绕过售前结清。

## 索引与前端数据

索引新增可选成对配置 `CHAIN_INDEX_PORTFOLIO_FACTORY`、`CHAIN_INDEX_PORTFOLIO_MARKET`。配置预算图时使用新的独立索引数据库；身份包含核心和预算地址，禁止复用不匹配数据库。签名服务 `BEMINE_JOURNAL_FACTORIES` 须同时配置经审核的核心和预算 Factory，可信 record/bundle 仍由服务器本地提供。

新增只读接口：

- `/v1/portfolios`：父项目目录。
- `/v1/accounts/:wallet/portfolios`：当前及历史关联的父项目，转出全部份额仍保留查询债权的入口。
- `/v1/portfolios/:portfolio/children`：逐台矿机及实际成本。
- `/v1/portfolio-orders`：独立预算份额市场，与旧市场订单 ID 隔离。
- 现有 `/v1/activity?pool=:portfolio` 与 `/v1/yield?pool=:portfolio` 支持父项目。

所有接口保留 `source` 的确认块、哈希、时间和完整性信息，预算图额外公开 `portfolioFactory`、`portfolioMarket`。事件发现不代替链上余额；签名前仍重新读取、校验和模拟。历史缺失、计数不匹配、RPC 错链或重组时返回不可用，不伪造零余额。

`/v1/pools` 不再把已被父项目持有的子池作为独立项目展示，历史账户查询不删除旧债权。stats 保留 `registeredPoolCount`（全部核心池），新增 `standalonePoolCount`、`portfolioCount`、`childPoolCount`、`topLevelProjectCount`。产品首页应使用 topLevelProjectCount。子池 Purchased 只计一次采购成本，父 ChildPurchased 不再重复累加。

## 通知和无人值守边界

原 Telegram 绑定、加密存储、同意/解绑、去重、限流重试、持久发送租约和双语文案保留。预算通知使用父份额持有人，按提案创建块的历史 `balanceOf/memberCount` 独立核对重放名单，再核对提案和已投票状态；不把子池的单一父合约地址当作用户。链接使用 `#portfolio/<父项目地址>`。历史 RPC 不可用、事件不完整或同块成交解冻后转份额造成快照无法核对时不发送该页，不能以当前余额替代历史权重。

采购 keeper、mining keeper/supervisor、treasury collector 的发送开关没有自动启用，也没有配置密钥或启动服务。单台采购 `--venue auto` 保留“完整官网扫描优先，之后 Firsto 回退”，直接 Firsto-signed 新发送仍禁用。预算 `budget-acquisition` 与 `budget-official-discovery` 当前是只读发现/规划器；父项目的逐步钱包操作已受 journal 保护，但不能把它们声称为已上线的持久无人值守预算采购执行器。任何后续预算执行器仍需完整采购覆盖、限价、父子归属、全局钱包 nonce 锁、持久意图和异常恢复，不得靠超时推断未广播。

后台依赖 POSIX 私有目录/文件权限，Linux 为验收运行环境。Windows 不绕过 0700/0600 检查。回归只使用独立临时副本和模拟 RPC/通知适配器，不会发真实链上交易或 Telegram 消息。
