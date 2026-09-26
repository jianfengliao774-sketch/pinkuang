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
| `GET /api/journal/deployment` | `{record,revision,archives}`，只返回当前登录账户 |
| `PUT /api/journal/deployment` | `{record,expectedRevision}` → `{revision}`；一个账户只容许一个活跃部署 ID，版本冲突 409 |
| `POST /api/journal/deployment/archive` | `{id,expectedRevision}` → `{revision,archives}`；仅在固定 BSC RPC 确认终止步骤的同账户、同 nonce 交易已进入规范链并 finalized 后，归档当前 `aborted` 记录，原子清活跃指针 |
| `POST /api/journal/deployment/import-archive` | `{record}` → `{id}`；仅导入本钱包旧版 `aborted` 记录，同 ID 同内容幂等 |
| `GET /api/journal/market` | `{record,revision}`，一账户仅一条活跃意图，覆盖同钱包所有市场 nonce |
| `PUT /api/journal/market` | `{record,expectedRevision}` → `{revision}`；初始意图须在钱包签名请求前落盘，之后只能单调补充交易哈希 |
| `DELETE /api/journal/market` | `{expectedRevision,hash}` → `{revision}`；服务端从固定 BSC RPC 验证同钱包、同 nonce 的规范链交易至少 2 次确认且位于 finalized 后才清除。`hash` 可以是原交易、加速、取消或替换交易；纯客户端“拒签”不构成删除证明 |
| `POST /api/journal/quote` | `{record}` → `{id}`；只保存本钱包报价草稿，不授权采购 |
| `GET /api/journal/quotes?cursor=0&limit=20` | 本钱包已保存报价草稿，新到旧分页；单页上限 100 |

金额、nonce、calldata、交易哈希和构建摘要以 JSON 中的原始精确值保存。部署记录的链 ID、账户、部署 ID、构建身份、已写入的步骤 nonce/dataHash/hash 不可改写；费额只允许增加。市场记录的账户、Factory、Market、nonce、动作和 calldata 不可替换，哈希列表单调追加。服务端使用 SQLite 事务与修订号比较后写入，客户端必须收到成功 ACK 后才能请求钱包签名；跨浏览器 Web Locks 不能代替服务端版本控制。服务端关闭或 RPC 故障时应停止新的签名。

**恢复边界：** 钱包已接收交易但尚未返回 hash 时，服务端只能保存签名前意图，不能凭“链上暂未看到”证明未广播，也不能按超时自动删除或重发。用户需要补录钱包交易 hash 并等待最终回执；如果确实没有交易，需单独设计受控恢复流程。旧浏览器 `localStorage` 日志迁移时先确认钱包/链/构建身份，活跃记录只在服务端无冲突时导入；每条记录获得服务端持久化 ACK、留下可核对备份后才移除本地副本。状态为 `aborted` 的旧记录走导入归档接口。

测试：`cd deploy && node --test server/journal-api.test.mjs`。测试使用临时 SQLite、随机测试钱包和模拟 RPC，不连接 BSC 主网或发送交易。
