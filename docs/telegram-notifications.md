# 拼矿 Telegram 通知接入与运维

机器人：`@BEMineNotifyBot`。本功能仅提供消息和网页入口，不持有资金、不代投票，不改变合约的投票期限或执行条件。邮箱尚未接入。

## 用户流程

1. 认购、付款阶段不要求联系方式。核验为已购机且当前钱包持有份额后，在资产总览或该矿机详情首次提示开启通知；可选择稍后设置。
2. 跳过后保留简洁入口；首次成功领取 BEM 后可再提醒一次。领取、退款和投票不依赖绑定。顶栏铃铛始终提供手动设置入口。
3. 用户点击绑定，沿用网站钱包签名会话验证归属，再获得有效期 10 分钟的一次性机器人链接。签名不付 Gas，不授权资产。
4. 用户在机器人点击开始；网页显示暂存 Telegram 账号，由已认证的钱包再次确认。仅打开链接不会直接完成绑定，转发链接者也不能单独替换绑定。
5. 一个钱包绑定一次，覆盖它持有的多个矿机；同一 Telegram 可接收多个钱包的消息。中英文可切换，其他 Telegram 语言默认英文。`/stop` 暂停这个 Telegram 的通知，网页可解绑。

未绑定、屏蔽机器人、暂停接收或网络失败时，无法保证 Telegram 送达。站内记录与链上投票资格独立；不把“API 发送成功”解释为已读或所有参与者均已获悉。

## 通知规则

| 事项 | 接收范围与条件 |
| --- | --- |
| 出售提案 | 合约快照时有有效份额的地址；迟绑定可补收仍开放的提案 |
| 截止前 6 小时 / 1 小时 | 仍有资格且未对该提案投票；刚收到新提案时不立即重复催办 |
| 投票截止 | 未执行挂牌的提案，区分票数未达标和达标但未执行 |
| 已挂牌 | 链上确认执行挂牌；不表示已成交 |
| 已成交 | 链上 `SaleCompleted` 确认 |

当前合约允许达到门槛后在截止前执行，截止后不能再执行本轮。任一同轮候选提前挂牌后停止整轮催投；通知系统不擅自延长截止时间，也不许诺等所有人收到通知才执行。

名单由 `Transfer`、`SaleSnapshotRecorded` 等事件恢复，再在同一已确认区块核对 `getPastShares`、`getPastMemberCount`、提案、赞成/反对票记录及当前状态。挂单锁定的份额仍归卖家，不把市场地址算作参与者。索引过期、未追平、重组、缺失快照或合约版本不兼容时停止发送，不发送猜测结果。

## 服务与隐私

- 钱包接口位于同源 `/api/journal/notifications/*`，沿用 HttpOnly 会话，并核对 `X-Pinkuang-Account`；修改请求须来自精确网站 Origin。
- 只有 `/api/journal/notifications/telegram/webhook` 例外使用 Telegram 专用密钥头；无法借此访问钱包接口。
- 机器人 Token、加密密钥、Webhook 密钥只读私密文件。联系人和机器人回复队列采用 AES-256-GCM，链接仅存摘要；目录 0700、文件 0600，禁止提交仓库。
- 链上通知索引 `/v1/notifications` 仅走本机回环，不在公开数据代理白名单内。不要另加 Nginx 直通。
- Telegram 或通知配置失败只关闭通知功能，不阻止交易 journal 启动。错误日志不含 Token、聊天 ID 或私密请求 URL。
- 持久 SQLite 保存去重键、重试和站内记录；租约避免多个进程同时取队列。单聊天冷却仅延期该用户，全局 429 才暂停整队。
- 发送成功与本地记账之间若进程崩溃，仍可能重复一次，不能承诺严格恰好一次。失败记录保留，8 次临时错误后停止自动重试；限流等待不计入失败次数。

## 配置与上线

Node.js 24+。在原 journal 服务配置之外增加以下变量，值仅为路径、公开地址和开关：

```dotenv
BEMINE_NOTIFICATIONS_ENABLED=1
BEMINE_TELEGRAM_BOT_USERNAME=BEMineNotifyBot
BEMINE_TELEGRAM_TOKEN_FILE=/private/bemine/telegram-bot-token
BEMINE_NOTIFICATION_KEY_FILE=/private/bemine/notification-encryption-key
BEMINE_TELEGRAM_WEBHOOK_SECRET_FILE=/private/bemine/telegram-webhook-secret
BEMINE_NOTIFICATION_DB=/private/bemine/notifications.sqlite
BEMINE_NOTIFICATION_FACTORY=<已验收的 Factory 地址>
BEMINE_NOTIFICATION_MARKET=<已验收的 ShareMarket 地址>
BEMINE_NOTIFICATION_PUBLIC_URL=https://example.org/bemine/
BEMINE_NOTIFICATION_INDEX_URL=http://127.0.0.1:4180
```

Factory 必须属于 `BEMINE_JOURNAL_FACTORIES`，公共 URL 必须与 `DEPLOYMENT_JOURNAL_ORIGIN` 同源且为 HTTPS。加密密钥是随机 32 字节的十六进制，Webhook 密钥是 32–128 字符随机 URL-safe 字符串。不要在 shell 参数、聊天或日志里直接填写 Token。

先部署接口，确认公开 capabilities、未经认证的拒绝响应与健康状态，再在已注入上述私密文件路径的环境中运行：

```sh
node deploy/scripts/configure-notification-bot.mjs
```

脚本核验机器人用户名，设置中英文简介与命令，注册带专用密钥的 HTTPS Webhook，保留待处理更新。它不改头像、不发送群发消息。`getWebhookInfo` 成功只证明配置生效，真实验收还需要用户自行 Start、钱包确认绑定，以及后续真实提案。

旧索引没有 `SaleSnapshotRecorded` 时，应保留原库，在新文件从原部署块重建，追平并核对后再切换。不能把扫描起点移到最新块。唯一可省略回扫的情况是：复制一致的旧库后，在复制游标的规范区块独立证明 Factory `poolCount=0`、Market `nextOrderId=1`，本地也没有池或池事件；因此过去不可能存在待补的出售投票。必须留存区块号、哈希和零历史核验记录。已有任意池时不适用此例外。

加密密钥与数据库须同时加密备份；直接换密钥会拒绝打开旧库。先验证可恢复再轮换。回滚时关闭通知开关、恢复先前服务与网页发布目录，保留新通知库及密钥；不覆盖旧交易 journal 或旧索引。若临时关闭 Webhook，保持待处理更新，不主动丢弃用户绑定消息。

## 验收与容量边界

专项覆盖绑定过期、转发/重放、错误钱包、群消息伪造、Webhook 重复与事务回滚、私密文件权限、加密存储、重启、限流、取消订阅、链上重组、遗漏反对票、提前挂牌、页面中英文和 iPhone 布局。浏览器测试使用本地模拟账户，不能充当主网资金验收。

```sh
node --test --test-concurrency=1 deploy/server/notifications/*.test.mjs deploy/server/notification-integration.test.mjs deploy/server/chain-index/notifications.test.mjs deploy/scripts/configure-notification-bot.test.mjs web/scripts/notifications.test.mjs
```

当前每池最多恢复 50,000 条相关事件，最多验证近 10 天内 200 个提案、100 个权益人；每轮最多 200 页 × 5 池，来源读取总时限 45 秒。超限会暂停，而非遗漏部分人继续发送。队列每轮最多 50 条，机器人全局限速 20 次/秒、单聊天约 1 次/秒，真实吞吐取决于 RPC、队列和 Telegram 延迟。不是无限容量承诺。

规模扩大时，先引入按新增事件推进的快照验证、批量合约读取和监控告警，再分片发送队列。不能只提高上述边界。私密绑定与已送达记录尚无自动清理策略，须纳入运维容量和隐私保留周期；本轮不自动删除历史。
