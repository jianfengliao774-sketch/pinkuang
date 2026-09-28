# BEMine 产品页与合约对接

本分支基于 `codex/deployment-page` 的 `44a5db7`，保留已有合约、部署台和索引服务。中文品牌为「拼矿」，英文为 `BEMine`。没有部署主网合约，也没有发送真实钱包交易。

## 页面入口

- `/`：保留现有墨绿香槟金设计的产品页。钱包、项目、持仓、收益、市场、治理和公开记录使用真实接口；无部署清单时显示即将开放，禁止交易。
- `/preview.html`：完整交互演示；本地 `next dev` 下为 `/preview`。模拟余额与按钮行为只在此入口使用。底栏的「查看分享效果」和 `#share/16928` 可直接打开分享卡；模拟认购完成后也会打开。
- `/#detail/<poolAddress>`：项目永久链接，采用池合约地址，不使用矿机编号识别项目；同一矿机可经历不同项目。
- `/share/<poster>.html`：9 个静态分享落地页，分别提供对应海报的 OG/Twitter 元信息；打开后只跳转到通过白名单校验的本站矿机详情。
- `/posters.html`：海报画廊，可查看 9 种风格和 18 条中英文标语。本地开发路由不带 `.html`。

首页累计项目、历史参与地址使用已确认索引。当前管理数量与预估日产暂未有可靠数据口径，因此显示 `—`。列表筛选和统计仅作用于已加载项目；分页检测区块变化时要求刷新，不拼接来自不同快照的余额。持仓页保留份额已售完但仍有 BEM 或 BNB 债权的项目。收益曲线展示实际归集及本人实际领取，不将它们冒充当日产能或当日应计收益。

## 数据读取与信任边界

1. 运维从现有部署台导出并审查 `frontend-manifest.json`，放到产品站 `data/frontend-manifest.json`。其 schema、ABI 产物摘要、链 ID、合约地址、部署块和代码 hash 必须匹配当前版本。
2. 产品页请求同源 `/api/chain-index` 和 `/api/rpc`。`live-config.mjs` 不接受邀请链接提供的 Factory/RPC，也不从演示数据补空。
3. 索引用于发现项目和历史；资金余额、份额、状态、市场订单与治理资格在索引对应的同一链上区块再次读取。代码、Factory 关系、完整性、时效与区块 hash 不一致时停止相关操作。
4. 每次交易预览再次读取最新区块、检查有效字段并模拟调用；实际发送前再次核对钱包、余额、nonce、Gas 和模拟结果。

读代理只接受有限的只读 RPC；不转发签名、广播、任意 URL、批量请求或状态覆盖。服务器固定选择上游，设置超时、请求/响应大小和并发上限。公网仍需反向代理的按 IP 限流。

## 钱包与交易

当前接入 EIP-1193 注入钱包，可使用浏览器钱包扩展或钱包内置浏览器。未配置 WalletConnect，不展示虚假的二维码连接入口。

用户点击连接钱包后，首次业务操作会要求签署本站登录消息，创建服务器会话。每笔交易必须先获得服务器保存意图的 ACK，再由钱包确认发送一次。交易意图沿用现有持久 SQLite 日志，并与部署台共用同钱包交易槽，避免跨标签页/设备重复操作。

接入的个人操作包括：整数份额认购、撤回募集认购、到期失败退款记账、矿池/市场 BNB 领取、收益归集与个人 BEM 领取、份额挂牌/购买/撤单/过期解锁、整机出售提案/投票/挂牌执行/购买/到期撤销。资金池建立及采购仍使用现有管理端流程。

发送超时、钱包拒签或响应丢失不等于交易失败。页面展示待核对记录，允许补录原始、加速或取消交易 hash。只有服务端从固定 RPC 验证最终回执后才释放槽位。对于无法确定是否发送的原 nonce，用户还可以明确确认 Gas 费用后发起同 nonce 的 0 BNB 自转取消；原交易可能先确认，以最终链上结果为准。页面不会自动取消、重发或替用户签名。

业务口径以本分支合约为准：100 整数份额，可由单钱包全部认购；99% 收益归持有人、1% 平台；份额和整机转让各收取 1%。BEM 领取没有 24 小时间隔，已入账权益不失效。出售表决使用当前合约的地址多数、份额多数及折价门槛。没有引入返利、折扣或奖励合约。

## 分享邀请

`ProjectShare` 支持中英文、Telegram、X、复制项目链接/文案和保存专属分享海报。社交转发入口目前只保留 Telegram 与 X。

- 只有服务器验证原认购意图、最终成功回执与精确匹配的 `Deposited` 事件后，展示「认购已确认」分享卡。
- 未认购也可从项目详情主动分享普通邀请，不标注认购成功。
- 分享前再次读取池状态；满额、已运营、已出售、退款或未知状态改为查看项目，不继续宣传可认购份额。
- 默认链接限定 `https://tapeout.cc.cd/bemine/`。迁域须同步修改可信域名校验及测试；仅设置环境变量不能绕过白名单。
- 分享链接形如 `https://tapeout.cc.cd/bemine/share/anime.html?mode=live&project=0x…&source=tg`。落地页把它恢复成 `https://tapeout.cc.cd/bemine/?source=tg#detail/0x…`。`source` 仅标记入口，不提供返佣、身份权限或金额计算依据。不会接受外部跳转目标、Factory 或钱包参数。
- 文案不含用户钱包、个人投入、交易 hash。不会自动发消息或加载第三方社交 SDK；用户在 Telegram/X 窗口最终确认发送。
- 分享卡保留原海报并新增 8 张。每种海报有独立静态落地页，社交抓取无需 JavaScript 即可得到对应的 1200×630 JPEG。海报不包含募集数字或付款证明；未实现每个项目动态数据海报、邀请排行榜或分享转化追踪。

演示入口使用单独的 `DemoProjectShare`，文案明确标注样例数据和未发生真实交易，分享链接带 `mode=demo`，最终只指向已知的 `/bemine/preview.html#detail/<演示矿机编号>`。它不构造链上成功回执，不复用正式项目地址，也不能通过参数切换为正式成功文案。

新增 15 条标语与原 3 条一起组成 18 条中英文邀请文案；非募集中、无剩余份额或状态未知时改用 18 条进展文案，不继续邀请认购。9 张海报 × 18 条文案形成 162 种组合。每次打开自动随机抽取，并排除上一组；打开期间切换语言、Telegram/X 或复制内容不重抽。「换一组」再次随机。sessionStorage 仅记海报 ID 和标语索引，存储不可用时采用内存回退，不写入钱包或交易数据。X 精简文案覆盖全部标语和最大矿机编号的加权长度测试。

随机选择完成前只显示等比占位，避免先加载默认海报。600px 及以下屏幕固定请求选中的 640×336 WebP，不因手机高 DPR 改取大图；桌面请求 1200×630 WebP。只在用户保存海报时才请求高清 JPEG，分享卡不预加载其他海报。素材参数及提示词见 `share-art-v11-a.md` 和 `share-art-v11-b.md`。

募集中且本人持有至少一份的项目，在矿机信息里持续显示邀请按钮；正式页面依据已核验持仓判断，不依赖刚付款的临时提示。只有 Active 状态显示出售份额动作，投票冻结和可用份额限制继续生效。

社交按钮打开用户控制的文案/链接编辑窗口，不自动上传图片或发帖。需要图片附件时可先保存海报，再在 Telegram 或 X 中添加。链接卡图片由平台抓取网页元信息并缓存，不将站内预览当作平台已经发帖成功。官方参考：[Telegram 分享按钮](https://core.telegram.org/widgets/share)、[X Post button](https://docs.x.com/x-for-websites/post-button/overview)、[X 字数计算](https://docs.x.com/fundamentals/counting-characters)。

iPhone 优先适配覆盖窄屏表单字号、44px 触控区域、动态视口弹窗、安全区和横屏导航；脚本 `web/scripts/iphone-browser-check.mjs` 使用触控视口仿真检查。仿真不等于 iPhone 真机或 Safari 内核验收，钱包应用回跳和系统键盘仍需真机补测。

## 部署后的配置清单

以下是正式启用链上业务前的配置清单。临时页面预览不启用交易后端或部署合约。

1. 部署并验收 Factory、Lens、Market 等合约，导出对应版本的清单。ABI 漂移检查必须通过。
2. 按 [索引服务说明](../deploy/server/chain-index/README.md) 配置 `CHAIN_INDEX_*` 并从 Factory 部署块开始完整索引。
3. 按 [日志服务说明](../deploy/server/JOURNAL.md) 配置私有 SQLite、可信 BSC RPC、生产 HTTPS origin；设置 `BEMINE_JOURNAL_FACTORIES` 为已审查的 Factory 地址。未列入白名单时拒绝产品交易意图。
4. 设置 `BEMINE_READ_RPC_URL`（可回退 `DEPLOYMENT_JOURNAL_RPC_URL`）和 `BEMINE_INDEX_URL`（默认 `http://127.0.0.1:4180`）。RPC 密钥仅存在服务端。
5. 同一个 HTTPS origin 下，将产品静态文件部署到 `/bemine/`，将精确的 `/api/journal/`、`/api/rpc`、`/api/chain-index/` 产品端点转发到现有 `deploy/server/index.mjs`。当前域名的 `/api/` 属于其他应用，正式启用前必须先核对端点冲突，不能整体替换其反向代理。cookie 路径为 `/api/journal`，不能随意改成 `/bemine/api/journal`。
6. `NEXT_PUBLIC_BASE_PATH=/bemine pnpm build`，保留独立币价缓存文件和已有历史审查目录。部署台与主产品必须提供同版本 ABI；保留既有管理员入口和管理服务。
7. 验收最小金额真实认购、finalized 后分享、朋友打开深链、账户/网络切换、拒签与恢复、退款/领取、份额撤单及过期解锁；确认移动钱包可用后再开放资金入口。

本地 Next 静态开发服务器自身不托管日志 API。联调真实服务时须使用同源反向代理；浏览器测试采用完全隔离的 RPC/索引/日志 fixture，不需要真实账户或私钥。

## 检查方式

```sh
cd web
pnpm check
pnpm contracts:check
pnpm build
```

服务端相关回归：`node --test deploy/server/*.test.mjs deploy/server/chain-index/*.test.mjs`。

可选浏览器检查：启动 `web` 的开发服务，在可用 Playwright 环境运行 `node web/scripts/live-browser-check.mjs`。可通过 `BEMINE_PLAYWRIGHT_MODULE` 指定 Playwright 模块入口，通过 `BEMINE_TEST_BROWSER=chrome` 使用本机 Chrome；`BEMINE_BROWSER_OUTPUT` 指定截图目录。运行 `web/scripts/live-payment-browser-check.mjs` 可再检查认购确认后分享和待定回执恢复。脚本仅允许访问 localhost，不会向真实链广播。fixture 只存在于 `scripts/`，不打包到产品页面。
