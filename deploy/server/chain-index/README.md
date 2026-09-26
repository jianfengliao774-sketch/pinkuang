# BSC 只读事件索引

此服务只为产品页面提供可核对的**历史发现和展示数据**。它没有签名、发送交易或管理钱包的入口，不替代 `PoolLens`、`ShareMarket` 的最新状态读取。当前项目尚未主网部署；没有验收过的地址时不要启动或填入示例地址。

使用 Node.js 24+，先按 `deploy/package-lock.json` 安装依赖。准备一个仅用于索引的 SQLite 文件路径，并从已验收的部署记录填写准确的 Factory、ShareMarket 和 Factory 首次部署区块：

```sh
CHAIN_INDEX_RPC_URL=https://your-trusted-bsc-rpc.example \
CHAIN_INDEX_FACTORY=0xYOUR_REVIEWED_FACTORY \
CHAIN_INDEX_MARKET=0xYOUR_REVIEWED_SHARE_MARKET \
CHAIN_INDEX_START_BLOCK=123456789 \
CHAIN_INDEX_DB=/private/path/bemine-index.sqlite \
npm run start:chain-index
```

默认仅监听 `127.0.0.1:4180`；公开提供时应通过受限流的反向代理。RPC 必须是可信 BSC 主网节点。服务检查链 ID 56、Factory/Market 互相绑定与代码存在；每轮只读取最多 500 个区块，每次 `eth_getLogs` 最多 100 区块、20 个池地址。默认等待 12 个确认；即使达到该深度，历史重组仍可能发生，服务会比较保存的区块哈希、回滚分叉事件并重放。SQLite 每批区块、事件和池登记在一个事务中提交；重启后要重新核链才提供数据。追到安全区块后，还会核对 Factory `poolCount` 和 Market `nextOrderId`，发现起始区块过晚或缺日志时返回未知，不会把不完整历史当成零。

每个响应的 `source` 含固定合约身份、已索引区块号/哈希/时间、安全头和 `complete`。追赶、RPC 错误、重组或身份不匹配时，除 `/health` 外返回 HTTP 503，`data:null`。金额、NFT 编号、订单编号都是十进制字符串；时间戳为秒。分页上限 50。

| 接口 | 数据范围 |
| --- | --- |
| `GET /health` | 索引覆盖与未知原因 |
| `GET /v1/pools?cursor=0&limit=20` | 已注册池地址、初始 NFT 身份，供页面再用同块 Lens 读取当前状态 |
| `GET /v1/stats` | 已确认历史口径：注册池数、去重曾参与地址数、实际购机花费、份额市场成交总额、池级归集净额；估计日产和当前活跃池数为 `null` |
| `GET /v1/accounts/{wallet}/pools?cursor=0&limit=20` | 曾认购、持有、交易或领取的池，包括现已零份额的钱包；**不是当前持仓** |
| `GET /v1/orders?pool=&seller=&active=true&cursor=&limit=20` | 历史订单重放后的未成交/未过期候选；`executable:false`，任何成交前必须重新读取市场订单、池状态并模拟 |
| `GET /v1/activity?pool=&account=&cursor=&limit=20` | 区块、交易、日志索引和原始精确字段；游标形如 `block:transactionIndex:logIndex` |
| `GET /v1/yield?pool=0x...&account=0x...&days=30` | `scope=pool` 的每日池净归集，及可选钱包**实际领取** BEM；个人未领的每日应计收益为 `null` |

收益按 `Harvested` 所在区块的北京时间入账日归类，不声称是矿机实际产出的日期。单个钱包的每日应计收益需要按交易顺序重放份额与累计奖励，当前服务不推测；`BemClaimed` 只代表本人实际领取。第一方参考日产能属于带时间戳的外部估计，不能替代实际收益。市场事件中的 `OrderFilled` 不重复写池和卖家，索引通过先前 `OrderListed` 关联；因此起始区块必须覆盖完整市场历史。

`/v1/stats` 的金额单位分别为 BNB wei、BNB wei、BEM 最小单位，全部以十进制字符串返回；地址数也为字符串。曾参与地址来自 `Deposited.user` 与份额 `Transfer.to`，排除零地址、Factory、Market 和矿池自身，不能解读为当前活跃人数或独立自然人。市场成交总额只统计本协议份额市场的 `OrderFilled.gross`；矿机采购成本只统计 `Purchased.cost`，不是当前设备估值。

页面用于签名前，应从已验收配置独立取得 Factory 地址，在同一链区块再次读取 `PoolLens`、`ShareMarket.orders/orderExpiresAt` 与 `PoolVault.shareTradingAllowed`，检查钱包/链/合约身份并执行 `staticCall`、估 Gas。索引服务的订单和余额展示不能成为交易授权依据。`PoolVault.bnbOwed` 与份额市场 `bnbOwed` 是两笔不同债权，前端应分开显示和领取。公开流水中的 BNB 提款事件不细分来源；不能把混合债权提现强行标成单一“余款”或“售款”。

测试：`cd deploy && node --test server/chain-index/*.test.mjs`。测试仅用模拟区块、事件和临时 SQLite 文件，不连接主网。
