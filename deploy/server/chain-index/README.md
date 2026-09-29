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

默认仅监听 `127.0.0.1:4180`；公开提供时应通过受限流的反向代理。RPC 必须是可信 BSC 主网节点。服务检查链 ID 56、Factory/Market 互相绑定与代码存在；fresh-v4 模式还在首次同步及此后每推进 20 个安全区块时，比对清单中 11 个地址的运行时代码哈希（包含 Authority）。哈希不符使索引与展示快照失效，RPC 临时失败则按同步失败重试。每轮只读取最多 500 个区块，每次 `eth_getLogs` 默认 100、最多 500 区块，以及最多 20 个池地址。默认等待 12 个确认；即使达到该深度，历史重组仍可能发生，服务会比较保存的区块哈希、回滚分叉事件并重放。SQLite 每批区块、事件和池登记在一个事务中提交；重启后要重新核链才提供数据。追到安全区块后，还会核对 Factory `poolCount` 和 Market `nextOrderId`，发现起始区块过晚或缺日志时返回未知，不会把不完整历史当成零。

`CHAIN_INDEX_LOGS_RPC_URL` 可将日志读请求分流到独立的已核验 BSC 节点。`CHAIN_INDEX_LOGS_TIMEOUT_MS` 默认 `12000`，仅允许 `12000..30000` 的精确整数毫秒；确认节点存在尾延迟时可显式配置 `30000`。它只延长日志 provider 的请求期限，primary 的区块头、代码和合约调用仍为12秒；即使两者使用同一URL也保持期限分离。不自动重试HTTP `Retry-After`，由原同步退避控制重试。服务停机先停止排队请求并等待正在执行的请求收尾，部署仍保留45秒 `TimeoutStopSec`，不可因为延长日志请求而缩短这一限制。

每段的 core Factory/Market 与 portfolio Factory/Market 全局日志并发读取，全部请求结束后才处理结果或抛错；新发现矿池与预算项目的动态日志仍在注册校验后读取。`CHAIN_INDEX_SCAN_RANGE` 默认100、可配置1..500，因此实际日志范围随配置变化，不超过500块；完整性、末端canonical块复核和整段SQLite事务保持不变。

私有故障诊断应只记录固定角色（primary/logs）、方法白名单、数字区块范围、耗时、受限错误码（如 TIMEOUT/SERVER_ERROR、数字JSON-RPC码）和HTTP状态码；不要记录RPC URL、请求/响应body、headers、错误message或堆栈。对外 `/health` 继续只报告 `sync_failed` 等既有有限原因，不把失败当空列表或沿用未验收快照。

每个响应的 `source` 含固定合约身份、已索引区块号/哈希/时间、安全头和 `complete`。正常同步开始时保留上一轮成功状态；发现更高安全头后，未追平的实时读返回 HTTP 503。`/v1/pools`、`/v1/portfolios`、`/v1/stats`、`/v1/orders` 可在同步或 RPC 故障时返回最近 30 分钟内的已验证展示快照，`source.readMode=verified_snapshot`、`source.stale=true`，并以 `source.refreshing` 标示当前是否正在同步；缺少对应完整快照仍为 503。快照的 `complete=true` 只说明其历史固定块曾完整核验，所有快照都标 `transactionReady=false`，不能作为交易授权。其他读接口及签名前核验保持新鲜度门禁。短暂的 RPC 安全头回退报告 `rpc_lagging`，不会仅凭低高度删除已提交历史。金额、NFT 编号、订单编号都是十进制字符串；时间戳为秒。分页上限 50。

页面可按需单独请求 `GET /v1/snapshot/pools|portfolios|stats|orders`；每区从同一次完整核验后预计算的安全区块读取，不会为单次请求访问 RPC，也不会因其他区超限而失效。有可用快照时，即使单区超限返回 503，响应仍含 `source` 和 `block:{number,hash,timestamp}`；`source` 保留合约身份、`checkedAt`、精确计数和各区 `poolsAvailable`、`portfoliosAvailable`、`ordersAvailable`，并明确标记 `readMode=verified_snapshot`、`stale=true`、`transactionReady=false`。池、预算、订单区返回 `data:{items,nextCursor,...}`，每页最多 50 行；池目录按创建区块与地址降序展示新池，统计区直接返回 `data:{...}`。单池深链可调用 `GET /v1/snapshot/pools/{address}` 精确查找，不受目录分页或 500 行上限影响；它返回同源证明和 `data:{items:[pool]|[],nextCursor:null,lookupAddress,...counts}`，未登记时是 200 与空数组。池行只含登记时的地址、NFT 身份和区块，不代表当前池状态；订单候选的 `executable` 始终为 `false`。池和预算目录各最多预计算 500 行；任一区超过上限时仅该区返回 503，其他区照常可读。历史 `OrderListed` 累计超过 500 时 `/v1/snapshot/orders` 返回 503、`data:{items:null,nextCursor:null,ordersAvailable:false}`，不能把它解释为无挂单；现有 `/v1/orders` 分页接口仍可独立读取。全部快照超过 30 分钟，或错误链、重组导致快照失效时，各区返回 503，且不提供历史 `block`。

| 接口 | 数据范围 |
| --- | --- |
| `GET /health` | 索引覆盖与未知原因 |
| `GET /v1/pools?cursor=0&limit=20` | 已注册池地址、初始 NFT 身份，供页面再用同块 Lens 读取当前状态 |
| `GET /v1/stats` | 已确认历史口径：注册池数、去重曾参与地址数、实际购机花费、份额市场成交总额、池级归集净额；估计日产和当前活跃池数为 `null` |
| `GET /v1/accounts/{wallet}/pools?cursor=0&limit=20` | 曾认购、持有、交易或领取的池，包括现已零份额的钱包；**不是当前持仓** |
| `GET /v1/orders?pool=&seller=&active=true&cursor=&limit=20` | 历史订单重放后的未成交/未过期候选；`executable:false`，任何成交前必须重新读取市场订单与池状态；索引不能保证交易执行成功 |
| `GET /v1/activity?pool=&account=&cursor=&limit=20` | 区块、交易、日志索引和原始精确字段；游标形如 `block:transactionIndex:logIndex` |
| `GET /v1/yield?pool=0x...&account=0x...&days=30` | `scope=pool` 的每日池净归集，及可选钱包**实际领取** BEM；个人未领的每日应计收益为 `null` |

收益按 `Harvested` 所在区块的北京时间入账日归类，不声称是矿机实际产出的日期。单个钱包的每日应计收益需要按交易顺序重放份额与累计奖励，当前服务不推测；`BemClaimed` 只代表本人实际领取。第一方参考日产能属于带时间戳的外部估计，不能替代实际收益。市场事件中的 `OrderFilled` 不重复写池和卖家，索引通过先前 `OrderListed` 关联；因此起始区块必须覆盖完整市场历史。

`/v1/stats` 的金额单位分别为 BNB wei、BNB wei、BEM 最小单位，全部以十进制字符串返回；地址数也为字符串。曾参与地址来自 `Deposited.user` 与份额 `Transfer.to`，排除零地址、Factory、Market 和矿池自身，不能解读为当前活跃人数或独立自然人。市场成交总额只统计本协议份额市场的 `OrderFilled.gross`（挂牌基价），不把新增的买方 1% 手续费加到成交额；`OrderFilled.fee` 仍是卖方 1% 手续费，升级后的 `BuyerFeeCharged.buyerFee` 单独记录买方 1% 手续费。历史旧市场没有 `BuyerFeeCharged`，重放时不可推断它曾收过买方费用。矿机采购成本只统计 `Purchased.cost`，不是当前设备估值。

页面用于签名前，应从已验收配置独立取得 Factory 地址，在同一链区块再次读取 `PoolLens`、`ShareMarket.orders/orderExpiresAt` 与 `PoolVault.shareTradingAllowed`，检查钱包/链/合约身份并执行 `staticCall`、估 Gas。索引服务的订单和余额展示不能成为交易授权依据。`PoolVault.bnbOwed` 与份额市场 `bnbOwed` 是两笔不同债权，前端应分开显示和领取。公开流水中的 BNB 提款事件不细分来源；不能把混合债权提现强行标成单一“余款”或“售款”。

测试：`cd deploy && node --test server/chain-index/*.test.mjs`。测试仅用模拟区块、事件和临时 SQLite 文件，不连接主网。
