# Telegram 通知接入发布记录

日期：2026-09-28（北京时间）。不包含合约升级、钱包广播或对用户的测试群发。

## 版本边界

开发代码基于远端 `codex/operator-miner-selection` 的 `8fc8480`，以独立 `codex/telegram-notifications` 分支交付，保留已有官网/Firsto 采购及份额手续费开发改动。当前主网尚未升级到仓库所有新合约功能，因此线上采用**通知功能差异补丁**：

- 线上网页原目录：`/var/www/bemine-preview/releases/bemine-live-20260927T110903Z`；源码基线 `b4c8a7c`。
- 网页保留该基线的 ABI、构建摘要与公开部署清单，只加入通知组件、路由、语言链接、入口及移动端布局；最终目录为 `/var/www/bemine-preview/releases/bemine-notify-20260927T1605Z-r2`。
- 原后台目录：`/srv/pinkuang-deploy/releases/pinkuang-live-20260927T072017Z`。
- 后台复制为 `pinkuang-notify-20260927T1605Z`；仅加入通知模块、通知 HTTP 路由、启动故障隔离与索引快照事件。保留原生产交易 journal、签名条件、产物与私有部署记录。
- 生产编译摘要仍为 `0xf48637de6a1c988b92d21347662b724b1ee7d59b09f66aaca9c7fe81b9a3b9ce`。不能将仓库新 ABI 的摘要改成旧值来绕过版本校验。

原服务、数据库、发布目录都保留。systemd 使用独立 `90-bemine-notifications.conf` drop-in，完整旧配置另备份于服务器私有 root 目录。

## 配置与核验

通知数据库、机器人 Token、联系人加密密钥、Webhook 密钥保存在服务器 `/var/lib/pinkuang-notifications/`，目录 0700、文件 0600，属运行账号；密钥内容不在本文件或 Git 中。通知配置文件只保存路径与公开参数。

本次有安全的空历史迁移条件：SQLite 一致备份中无池和池事件；独立 BSC 调用在区块 **124361372** 核对 `poolCount=0`、`nextOrderId=1`，规范哈希为 `0xf2229d024410b01c2045a87e916053d1fbbb386c883e2b07abcc8c72d1419e16`。原索引未修改，新库继续同步并开始记录 `SaleSnapshotRecorded`；该方法不适用于已有池的部署。

线上检查结果：

- Bot 身份是 `BEMineNotifyBot`；HTTPS capabilities 返回 `enabled:true`。
- 不带 Webhook 密钥返回 403，带正确密钥的空更新返回 200，未产生用户消息。
- 中英文简介、命令及 Webhook 已配置；回调为 `https://tapeout.cc.cd/bemine/api/journal/notifications/telegram/webhook`，配置时待处理更新为 0。
- 2026-09-27 16:07:30 UTC：新索引 `complete=true`、`unknownReason=null`，已追平区块 **124362002**。私有通知 feed 返回已核验空列表。
- 交易后台、索引和原币价服务均处于 active；没有变更 Solidity 或提交链上交易。

## 验证范围

| 验证 | 结果 |
| --- | --- |
| 通知、路由、配置与前端专项 | 43/43 |
| journal、产品交易、公开代理及通知相关回归 | 82/82；与专项有交叉，不相加 |
| 索引与启动服务回归 | 24/24 |
| 前端与旧 live API 回归 | 211/211 |
| Linux 生产差异补丁的通知/路由回归 | 31/31 |
| 仓库最新版及线上基线的 Next 生产构建 | 均通过 |
| 本地真实浏览器 + 模拟账户 | 7 项交互检查；375/390/430 px、中英文、深色、跳过、二次确认、无自动签名 |

生产浏览器可打开通知中心，未替用户连接、签名或绑定真实钱包。目前没有实际矿池，因此**真实出售事件的端到端消息送达未验收**；上述测试不能替代真实业务验收。下一步由用户连接自己的钱包，打开机器人点击 Start，再返回网页确认账号。之后用真实合法提案验证提醒和结果，无需改变现有投票规则。

## 回滚

先关闭通知开关或停止通知后台，保留 Token、加密密钥、队列库和待处理更新。恢复旧服务 ExecStart、旧索引路径、后台及网页 current 指向，检查已有 journal 与索引健康后再开放。勿覆盖旧 journal、删除新队列或改合约地址；Webhook 关闭/恢复不得丢弃待处理更新。
