# BEMine 链上工作台服务

`/live/` 是静态页面，`server/live-server.mjs` 是仅支持 **schema1 原生部署**的独立同源 API。当前 BSC 已有旧版本项目地址，但新源码尚未升级到该地址；不能把新编译摘要套用到旧实现。新版原生部署须从部署台分别导出“合约清单”和“完整部署记录”。本 API 启动时要求两份文件的源码产物摘要相同，且等于本次网页构建摘要；每次开放交易前再次核验 Factory、Market、Lens、Beacon、Timelock 与三份实现的运行代码哈希、升级槽位和绑定关系。旧地址完成升级后的混合部署只由 `deploy/server` 的 schema2 产品图证明支持，不得用本服务绕开该证明。

环境变量：

| 名称 | 内容 |
| --- | --- |
| `LIVE_MANIFEST_PATH` | 部署台“核验并导出合约清单”的服务器本地绝对路径 |
| `LIVE_DEPLOYMENT_RECORD_PATH` | 同一部署的完整记录 JSON，本地绝对路径 |
| `LIVE_ORIGIN` | 页面精确来源，如 `https://example.com`（无末尾斜线） |
| `LIVE_RPC_URL` | 可信 BSC 主网 HTTPS RPC，只供服务端使用，不出现在页面 |
| `LIVE_INDEX_URL` | 本机事件索引地址，例如 `http://127.0.0.1:4180` |
| `LIVE_JOURNAL_DB` | SQLite 文件绝对路径，直接父目录须为服务账号独占 `0700` |
| `LIVE_PUBLIC_BASE_PATH` | 与网页构建的 `NEXT_PUBLIC_BASE_PATH` 一致；根路径留空，`/bemine` 部署填 `/bemine`，用于会话 Cookie 路径 |
| `LIVE_PORT` | 可选，本机监听端口，默认 `4190` |

```sh
cd web
pnpm start:live-api
```

服务只监听 `127.0.0.1`。HTTPS 反向代理须把同一网站的 `/api/live/` 转发到本服务，把 `/bemine/` 静态路径指向 `out/`（若网站部署在根路径则用根路径）。如果使用 `/bemine`，还须把 `/bemine/api/live/` **去掉 `/bemine` 前缀**后转发到本服务，并设置 `LIVE_PUBLIC_BASE_PATH=/bemine`。**不要让静态站和 API 使用不同 origin**，也不要公开 4190 端口。独立的链上索引服务按 `deploy/server/chain-index/README.md` 配置；API 只从固定索引地址取历史数据，并核对其 Factory/Market 和完整状态。反向代理负责访问速率限制。生产服务账号持有数据库和证据文件，数据库目录不可被其他账户写入；备份 SQLite 时包含 WAL 或使用在线备份。

API 仅接受固定 Factory 下真实注册的矿池及经核验的 ShareMarket。矿池个人操作为 `deposit`、`withdrawDeposit`、`harvest`、`claim`、`withdrawBnb`；市场操作为 `list`、`fill`、`cancel`、`expire`、`withdrawBnb`；整机出售治理为 `propose`、`vote`、`executeSale`、`cancelExpired`、`completeSale`。市场订单、卖方、池、单价、数量和精确付款会在保存及准许签名前分别复核；挂单或买入还须链上 `buyerFeeBps() = 100`，买方付款精确等于成交额加买方 1%，卖方另从成交额扣 1%。旧市场不满足版本门槛时拒绝新增挂单与买入，撤单及领取已记账 BNB 仍可走原规则。整机出售付款必须等于实时链上挂牌价。市场 BNB 与池内 BNB 分别领取。钱包挑战签名只用于登录服务器，不授权交易；服务器没有私钥、不会发交易。每钱包在矿池、市场与治理操作之间共用一条待确认意图。服务器先保存 `prepared`，随后独立重新核验并转成 `armed`，网页只有收到 `armed` 才向钱包请求交易。`prepared` 尚未向钱包发送，可无 Gas 放弃，10 分钟后也会在下次读取时自动关闭；`armed/submitted` 不按超时清除。已广播、替换、撤销或拒签后不自动重发；只有同账户、同 nonce、规范链、达到 `finalized` 的回执才结束已准许签名的意图，无法判断时继续锁定。页面提供用**同一 nonce 的 0 BNB 自转**取消并记录哈希的入口；这笔取消需要钱包签名和 Gas，最终确认后才解除原意图。

钱包交易发生在部署证据匹配、同链钱包、最新合约快照、模拟和服务器持久化全部通过后；服务器索引提供完整的矿池与订单发现数据。一个钱包可以认购全部 100 份；多个钱包争同一剩余份额时，后到交易会被链上总量检查回滚。页面预模拟减少失败请求，但最终以合约原子条件为准。

验证：`pnpm check` 包含客户端发送顺序、同钱包满额、竞买后状态变化、市场订单与价格复核、治理门槛与整机付款、服务器故障、拒签、错误账户/nonce、原交易与取消交易最终确认、服务器 SQLite 意图隔离等测试。上线前还需用真实钱包及 BSC 小额池验证浏览器/移动端钱包行为和目标环境的 `finalized` RPC 支持；若 RPC 不支持最终区块，服务保留待确认意图，不能自动清除。
