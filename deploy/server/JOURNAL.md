# 部署台操作日志服务

此服务保存钱包操作恢复所需的部署步骤、市场交易意图与报价草稿。它不持有私钥、不代钱包签名或广播。资金池、订单和余额仍以 BSC 链上状态为准；`chain-index/` 是另一套只读、可重建的公开历史索引，不能替代本日志。

启动 `npm start` 时始终必须显式设置以下生产配置，即使没有设置 `NODE_ENV`：

```sh
NODE_ENV=production \
DEPLOYMENT_JOURNAL_DB=/private/pinkuang/journal.sqlite \
DEPLOYMENT_JOURNAL_ORIGIN=https://your-deploy-console.example \
DEPLOYMENT_JOURNAL_RPC_URL=https://your-trusted-bsc-rpc.example \
npm start
```

数据库**直接父目录**须仅本服务账号可访问（权限 `0700`）；启动会拒绝共享目录和数据库符号链接。数据库及 SQLite WAL/SHM 文件都应留在受保护目录内，备份时复制主数据库和 WAL，或使用 SQLite 在线备份机制。主文件设为 `0600`、WAL 模式与 `synchronous=FULL`。数据库、会话 cookie、RPC URL 不要提交仓库。开发默认 `http://127.0.0.1:4173` 和 `deploy/.local/journal.sqlite`，需要把 `deploy/.local/` 加入 Git 忽略；开发时未配置 RPC 则市场日志删除返回 503。

浏览器先 `POST /api/journal/challenge` 提交 `{account}`，再用当前钱包签响应中的原始 `message`，`POST /api/journal/session` 提交 `{account,nonce,signature}`。挑战 5 分钟有效且只能使用一次；同钱包在有效期内重复请求会得到同一挑战，不会使先前消息失效或耗尽登录名额。登录设置 12 小时 `HttpOnly; SameSite=Strict` cookie；生产 cookie 还带 `Secure`。写请求必须携带与配置完全相同的 `Origin`，不开放 CORS。会话绑定规范化账户；部署台在每次业务请求中附带 `X-Pinkuang-Account`，服务端在同一次请求里核对所选钱包和会话，避免重复请求 `/session`，也防止其他标签页切换钱包后读写错账户。公网流量应由反向代理按真实客户端 IP 限流。

| 接口 | 请求与结果 |
| --- | --- |
| `GET /api/journal/session` | `{account}`，无有效会话返回 401 |
| `GET /api/journal/build` | `{artifactDigest}`；返回此服务器当前实际提供的合约产物摘要。开发服务还会核对当前 Solidity、依赖与构建输入；漂移时返回 503。每笔部署交易向钱包发送前页面再次请求此接口，不额外读取链上状态 |
| `GET /api/journal/deployment` | `{record,revision,archives,archiveNextCursor,latestCompleted}`；归档只返回最近 100 条，最近一次完成部署独立返回，均仅属于当前登录账户 |
| `GET /api/journal/deployment/archives?cursor=<rowid>&limit=20` | 本钱包更早的完整部署记录，返回 `{items,nextCursor}`；游标是服务端归档序号，单页上限 100 |
| `PUT /api/journal/deployment` | `{record,expectedRevision}` → `{revision}`；一个账户只容许一个活跃部署 ID，版本冲突 409。新部署及新步骤签名前，记录摘要与源文件必须与服务器当前构建一致；构建更新后仍可补记原有交易的哈希与回执 |
| `POST /api/journal/deployment/archive` | `{id,expectedRevision}` → `{revision,archives,archiveNextCursor,latestCompleted}`；`aborted` 须核实终止步骤的同账户、同 nonce 最终链上结果；`complete` 须核实全部 13 笔原交易、回执及记录内声称通过的图校验。两种状态都由固定 BSC RPC 确认 finalized 后，原子归档完整记录并清活跃指针，才能用同钱包新建部署 |
| `POST /api/journal/deployment/import-archive` | `{record}` → `{id}`；仅导入本钱包旧版 `aborted` 记录，同 ID 同内容幂等 |
| `GET /api/journal/market` | `{record,revision}`，一账户仅一条活跃意图，覆盖同钱包所有市场 nonce |
| `PUT /api/journal/market` | `{record,expectedRevision}` → `{revision}`；初始意图须在钱包签名请求前落盘，之后只能单调补充交易哈希 |
| `DELETE /api/journal/market` | `{expectedRevision,hash}` → `{revision}`；服务端从固定 BSC RPC 验证同钱包、同 nonce 的规范链交易至少 2 次确认且位于 finalized 后才清除。`hash` 可以是原交易、加速、取消或替换交易；纯客户端“拒签”不构成删除证明 |
| `POST /api/journal/quote` | `{record}` → `{id}`；只保存本钱包报价草稿，不授权采购 |
| `GET /api/journal/quotes?cursor=0&limit=20` | 本钱包已保存报价草稿，新到旧分页；单页上限 100 |

金额、nonce、calldata、交易哈希和构建摘要以 JSON 中的原始精确值保存。部署记录的链 ID、账户、部署 ID、构建身份、已写入的步骤 nonce/dataHash/hash 不可改写；费额只允许增加。市场记录的账户、Factory、Market、nonce、动作和 calldata 不可替换，哈希列表单调追加。服务端使用 SQLite 事务与修订号比较后写入，客户端必须收到成功 ACK 后才能请求钱包签名；跨浏览器 Web Locks 不能代替服务端版本控制。服务端关闭或 RPC 故障时应停止新的签名。

已完成部署的归档核实原始交易与 finalized 回执，但图校验结果和合约地址来自先前保存的记录，服务端不独立读取并证明当前部署图。部署台在导出前端清单前，会只读核实原子初始化交易及 finalized 回执，再用当前钱包、同一固定区块的代码、存储槽和合约调用重新核对地址、权限及构建摘要；不会签名或修改日志。升级后运行代码可能合法改变，旧构建对应的清单可能无法通过重新核对；此时需另行核实升级后的实现与配置。使用方仍须独立按链核实清单，不能只凭历史记录接入资产。

**恢复边界：** 钱包已接收交易但尚未返回 hash 时，服务端只能保存签名前意图，不能凭“链上暂未看到”证明未广播，也不能按超时自动删除或重发。用户可以补录钱包交易 hash 并等待最终回执；v1 市场或 v2 产品记录也可以使用下述独立点击确认的 nonce 取消流程。部署步骤的未知结果仍需按其专用流程核对。旧浏览器 `localStorage` 日志迁移时先确认钱包/链/构建身份，活跃记录只在服务端无冲突时导入；每条记录获得服务端持久化 ACK、留下可核对备份后才移除本地副本。状态为 `aborted` 的旧记录走导入归档接口。

部署过程中若服务器更换了合约产物，旧页面的下一笔签名会被拒绝。若版本变化恰好发生在签名前意图保存后，页面会明确记录“本页尚未请求钱包签名”，但仍保留签名前意图，不会自动重试；其他页面或钱包是否广播过同一 nonce 无法仅凭此页面判定。恢复时须核对链上交易，并由管理员恢复匹配原记录的构建或走受控人工处理，不能用新字节码继续原部署计划。

测试：`cd deploy && node --test server/journal-api.test.mjs`。测试使用临时 SQLite、随机测试钱包和模拟 RPC，不连接 BSC 主网或发送交易。

## BEMine 主站产品交易（v2）

主站通过同一 `/api/journal/market` 活跃槽保存 `version: 2` 的资金池及份额市场意图，和部署台的 v1 市场记录共享钱包锁。服务端 CAS 在 SQLite 事务内执行；有活跃产品/市场意图时不能开始部署或新部署签名步骤，有未归档部署时不能新建产品/市场意图。兼容现有 v1 记录及其单调更新、恢复路径，不能用切换页面或改版本来覆盖待处理交易。

启用主站签名之前，另外配置：

```sh
BEMINE_JOURNAL_FACTORIES=0xYourIndependentlyVerifiedFactory
```

该值为独立核验过的 BSC Factory 地址列表（逗号分隔，最多 32 个）。空列表拒绝所有新 v2 产品交易。它必须与公开部署清单中的 Factory 一致；不得从用户输入、浏览器请求或商城报价自动生成。v1 部署台记录保持原有兼容边界，新产品入口使用 v2，不把 v1 日志校验当作产品调用白名单。

v2 必填字段为 `{version:2,chainId:56,account,factory,target,targetType,nonce,action:{kind},data,value,submittedAt}`。`targetType` 为 `pool` 或 `market`；`value` 为 wei 十进制字符串；后续只可补充原交易 `hash` 及追加 `recoveryHashes`。服务端初次 ACK 前使用固定 RPC、同一区块验证：

- 资金池须在已启用的 Factory 登记，且 `factory()`、`OFFICIAL_FACTORY()` 双向一致。
- 市场须为 Factory 的 `shareMarket()`，并反查其 Factory；相关挂单中的 pool 也须登记。
- 仅允许完整、规范编码的产品 ABI：资金池 `deposit`、`withdrawDeposit`、`finalizeFailure`、`harvest`、`claim`、`withdrawBnb`、`propose`、`vote`、`executeSale`、`cancelExpired`、`completeSale`；市场 `list`、`fill`、`cancel`、`expire`、`withdrawBnb`。不允许审批、升级、管理员或任意 calldata。
- 仅认购、份额购买和整机购买允许附带 BNB，分别核对 `unitPriceWei × shares`、`pricePerUnit × amount`、批准的 `salePrice`。其余调用必须为零 BNB。
- 钱包的 latest/pending nonce 必须均等于意图 nonce，再以相同账户、目标、数据及金额执行只读模拟；任何不可验证状态拒绝新签名。已经存在的意图仍可在 RPC 故障或 allowlist 改变后补存 hash，避免丢恢复线索。

`DELETE /api/journal/market` 在 finalized 证明满足后返回 `{revision,result}`，并在同一 SQLite 事务中保存结果后清待处理槽。`result.status` 为 `confirmed`、`reverted`、`cancelled` 或 `replaced`；不同内容的同 nonce 替换不得被报告为原操作成功。v2 认购的 `confirmed` 还要求最终回执中恰有一个来自目标 Pool 的 `Deposited` 事件，且 user、shares、amount 与签名前意图完全相符。缺事件、错误事件、未最终确认或重组都保留待处理记录，不给出认购分享依据。

新增 `GET /api/journal/market/result?hash=0x...` 返回 `{result}`（不存在为 null），仅可读取当前认证钱包的已验证结果。可在清除请求的响应丢失后恢复结果，无需重签或重发。认购结果含 `action:'deposit'`、`status:'confirmed'`、`finalized:true`、`poolAddress`、`account`、`shares`、`amountWei`、`transactionHash`、`receipt`；其中份额和金额保持十进制字符串。

旧浏览器可能再次导入已经核销的 v1 待定记录。再次核销仍须重新取得 finalized 证明；同钱包、同 hash 的完整结果与既有证明严格一致时，原子复用既有结果并清除待定槽。任何字段不一致都返回 409，保留原证明和待定记录，不允许覆盖历史结果。

主站适配器位于 `web/lib/live-transactions.mjs`。`connectWallet()` 与 `authenticate()` 只能由用户点击调用；读页面、恢复交易和发送业务交易不自动触发登录签名。`sendProductTransaction()` 接受已经由 ABI 编码的精确交易，模拟并校验钱包/链/nonce/余额/Gas 后，先获得服务端意图 ACK，再请求一次钱包交易；不自动重试。`recoverPending()` 不签名不广播，只核对已有 hash/用户补录 hash。钱包拒绝或响应丢失也保留意图，不能仅凭客户端取消或超时清除服务器记录。

主站配置使用 `journalBase:'/api/journal'`，即使静态页面位于 `/bemine/`；反向代理应把根 `/api/journal/` 指向此服务，并将 `DEPLOYMENT_JOURNAL_ORIGIN` 设为主站的精确 origin。此路径与 HttpOnly cookie 的 Path 一致，不允许外站 API URL。服务没有私钥，也没有任何广播接口。

新增测试：`node --test server/product-journal.test.mjs` 与在 web 下执行 `node --test scripts/live-transactions.test.mjs`。仅使用临时数据库、一次性 loopback HTTP 服务及模拟钱包/RPC。

### 用户主动取消待定 nonce

`cancelPendingNonce({provider,config,account,onState})` 只能接在独立的用户确认按钮上。界面必须事先说明：取消会请求钱包发送一笔 **0 BNB 自转**，仍需支付 Gas；原交易可能先被矿工确认，取消请求不保证胜出。读页面、交易恢复、钱包拒签与超时都不得自动调用此函数。

`POST /api/journal/market/cancel-intent` 接收 `{expectedRevision}`，只处理当前会话钱包已有的 v1/v2 活跃记录，不接收任意目标或 nonce。固定 BSC RPC 必须核实：latest nonce 等于该记录 nonce，pending nonce 只能相同或高一位，账户没有合约代码，且余额足够。服务端依据当前费用和已知原交易/取消 hash 的费用上调 20%，上限 3 gwei；超出上限、账户已消耗 nonce、还有其他排队交易、委托账户或 RPC 不可用均拒绝。服务端模拟零额自转后，以 CAS 追加不可改写的 `cancellationRequests`，返回 `{revision,record,transaction}`；每条记录最多 16 次取消意图。

客户端收到持久化 ACK 后再次核对钱包、BSC、nonce、记录版本、EOA 状态、余额和费用，构造固定 `to=from`、`value=0`、`data=0x`、`gas=21000` 的同 nonce 交易，仅请求一次钱包确认。签回的 hash 先追加到 `recoveryHashes`，原交易 hash 和业务意图不改写；钱包切换也不会主动丢弃已返回的 hash。拒签或响应丢失保留记录，不自动重试。

最终清理仍由原有 finalized 验证完成：只有成功的零额自转才是 `cancelled`；其他同 nonce 交易分别按原操作成功、失败或替换核实。取消函数不会返回原业务 `confirmed`，也不会提供认购分享确认；原操作若抢先确认，用户应补录其 hash 走只读恢复。这里的取消 API 不签名、不广播、不能替用户清掉尚无最终证明的记录。
