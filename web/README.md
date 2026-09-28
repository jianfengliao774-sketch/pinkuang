# 拼矿 BEMine · 产品前端与历史设计

当前入口：主产品 `/`（部署路径 `/bemine/`），历史设计演示 `/preview/`。源码构建成功不代表线上部署已更新。

中文品牌「拼矿」，英文「BEMine」。墨绿香槟金主色，支持中文/英文、日常/深色外观，以及手机响应式布局。首页、资产总览、参与拼矿、矿机详情、矿机转让、收益中心、共同决策和公开记录均可交互预览。首页芯片及金币为独立前景动效，背景静止，提供暂停与减少动态效果支持。

## 开发和构建

使用 Node.js 24 与 pnpm 11.5.2。构建校验 ABI 需要先安装仓库根目录和 `deploy/` 的锁定依赖；详见[对接说明](../docs/frontend-contracts.md)。

```sh
cd web
pnpm install --frozen-lockfile
pnpm dev
# http://127.0.0.1:3108
pnpm check
pnpm build
# 静态产物 out/；部署在 /bemine/ 时：
NEXT_PUBLIC_BASE_PATH=/bemine pnpm build
```

真实合约部署使用仓库的独立 `deploy/` 服务。主产品页使用真实链上工作台；`/live/` 保留为早期独立工作台，只有服务器提供经过验收的部署清单、完整部署记录、事件索引和交易日志时才启用。没有部署配置时它显示不可用，不填演示地址，也不发链上交易。只有在构建时设置 `NEXT_PUBLIC_DEPLOY_CONSOLE_URL`，主产品页才显示“管理员 · 合约部署”入口；公网地址必须是 HTTPS，本地开发可用 `http://localhost:4173/`。该地址必须指向有持久服务器操作日志的部署服务，不能指向静态 Vite 文件或演示页。例如本地联调：

```sh
NEXT_PUBLIC_DEPLOY_CONSOLE_URL=http://localhost:4173/ pnpm build
```

部署台的运行条件见 [deploy/README.md](../deploy/README.md) 和 [服务器日志配置](../deploy/server/JOURNAL.md)。

当前源码不附带可直接启用的生产合约清单。完成新部署台 **16 步**及链上验收后，导出新的 `integrated-v2` 前端清单，放到站点 `data/frontend-manifest.json`；缺少清单时正式页面显示“项目尚未开放，等待部署核验”，真实 RPC 或版本核验错误仍显示独立的不可用状态。不得把旧地址与新产物摘要手工拼接启用。2026-09-27 的旧清单已原样归档于 [历史清单](../docs/deployments/legacy-frontend-manifest-20260927.json)，仅用于审计追溯。

发布新静态产物时，还须检查服务器 `/data` 的旧软链接、共享目录或 nginx 挂载：源码移除旧 JSON 不会自动清理外部挂载。尚未导出新清单时，此 URL 应返回真实 HTTP 404，不能继续提供旧清单，也不能由 SPA 回退返回 HTTP 200 的 HTML。部署完成后再核对该 URL 返回的新地址、摘要与部署记录一致。

`out/`、`.next/`、`node_modules/` 和本地环境文件不入库。Next.js 使用静态导出，部署由静态服务器提供 `out/`，不使用 `next start`。

## 数据与合约边界

主产品页面从核验后的部署清单、链上读取与服务器索引展示真实项目，钱包仅在用户确认时请求签名。`/preview/` 的钱包、矿机、资产和投票为演示，不发送交易；刷新恢复初始状态。没有链上来源的数据保持未知，不使用演示数据补空。矿机质押、质保等筹备服务仍为说明入口。

主产品与 `/live/` 从服务器事件索引发现矿池、订单和历史持有人，从链上按同一区块读取当前金额。它支持真实认购（单钱包可买满 100 份）、撤回募集期认购、任何人归集收益、本人领取已入账 BEM 与池内 BNB；份额市场支持挂单、买入、撤单、清理过期单及独立领取市场 BNB；整机出售支持提案、投票、执行挂牌、过期撤销及按链上价格购买。每笔交易都先重读、模拟、估 Gas，再把精确目标、calldata、金额、账户和 nonce 存入服务器 SQLite；只有服务器确认“已准备→准许签名”后才请求钱包。哈希和最终确认可跨标签、刷新后恢复。准备记录未准许签名时可无 Gas 放弃；钱包拒签或广播结果不明时保留已准许意图，必须补录原交易、加速或取消的哈希并核对最终区块。受控 Firsto 出售绑定链上提案、售价、手续费及 epoch，并分别展示 Firsto 买方费、平台费和成员卖款；不开放 Firsto 外部网页原生挂单。

链上工作台不使用 `localStorage` 保存资金状态。当前余额以链为准，历史发现和交易意图保存在服务器；浏览器内存只保留当前显示与输入。运行配置和部署门槛见 [真实工作台部署说明](server/LIVE.md)。

最新确认规则：100 个整数份额、单地址可认购全部100份；参考产能价加默认10%预留筹资，每份金额为募集额÷100，余款按购机时份额退回。矿机产出99%归持有人、1%平台费；份额市场买方在成交价外支付1%、卖方从成交价扣除1%，均记给金库；整机出售另从成交价扣除1%。收益先归集入池，权益钱包再各自领取，无冷却、无到期、无销毁。低于实际购机价的出售至少60%份额同意且人数过半，其余严格双过半；投票期间冻结份额交易，仍可撤单，挂单7天到期。当前已部署的旧 ShareMarket 尚未执行双边费升级，真实新增挂单与买入须等待时间锁升级及服务端证据核验。

本轮合约已同步这些规则，新增 `PoolLens`、checked 建池接口及独立的矿池、市场、出售治理只读适配器。主产品页面与 `/live/` 使用真实钱包和服务器日志；`/preview/` 明确保留演示。演示中的浮点数据不能用于签名；交易金额使用精确整数。`pnpm build` 和 CI 强制独立重编核对 ABI；修改合约后先更新部署产物，再执行 `pnpm contracts:sync`。历史记录、全局聚合和二级市场成本需事件索引，不用演示数据补空。

首页币价独立于演示统计，是 PancakeSwap V3 BEM/WBNB 与 WBNB/USDT 同区块换算的 USDT 参考价。后台每15秒刷新；来源不符、失败或过期显示不可用。运行与部署见 [报价服务说明](ops/bem-price.md)。本地静态预览没有报价文件时显示不可用，不伪造价格。

## 主要文件

- `components/LivePlatform.jsx`：真实产品入口、钱包、通知、链上业务和统一交易日志。
- `components/LivePortfolios.jsx`、`lib/live-portfolios.mjs`：预算项目、子矿机、父层权益、份额市场与逐台治理。
- `components/FirstoMarketBoard.jsx`：只读市场报价与日产能价；报价本身不授予交易权限。
- `components/Platform.jsx`：`/preview/` 工作台、详情、弹窗和演示操作。
- `components/SiteOverview.jsx`、`HeroScene.jsx`：首页、愿景、轻量前景动效。
- `components/PoolCatalog.jsx`、`lib/catalog.js`：分类列表、搜索、筛选与排序。
- `lib/demo-data.js`、`economics.js`：演示数据与统一计算口径。
- `lib/i18n.jsx`、`*-en.js`：中英文文案。
- `components/BemPriceStat.jsx`、`scripts/update-bem-price.mjs`：币价展示及只读缓存服务。
- `public/`：标志、原始/压缩图像、本地字体与许可。
- `app/design/`：品牌候选历史对比页；`app/review/`：v5审查工具源码，非最新设计验收基线。

中文字体为已提交的 WOFF2 子集，新增字符可运行 `scripts/subset-preview-font.py /path/to/NotoSansSC.ttf`；需 Python fonttools 和 brotli。图片压缩脚本为 `scripts/optimize-hero.mjs`，默认运行已提交的 WebP 无需重生成。

## 历史发布与版本保留（2026-09-26 记录）

v7 静态目录为 `/var/www/bemine-preview/releases/20260926-brand-v7`，`current` 指向当前发布。更新采用新目录完整上传后切换软链接，保留旧版回滚。

每次发布保留 `data` 软链接指向独立报价缓存，以及 `review-20260926` 指向历史v5审查册。历史审查地址：https://tapeout.cc.cd/bemine/review-20260926/review.html。

本次提交以远端 `codex/deploy-console` 的 `8ce9535` 为基础，只新增前端目录内容。原合约、部署控制台及已绑定源码的部署产物保持不变。详细桌面修改与定名记录见 [v6审查记录](design-notes/desktop-review-v6.md) 和 [v7定名记录](design-notes/brand-v7.md)。


## 本轮整合与验收

本轮将通知、真实市场板、容量报价、手机历史审查与分享说明合并到同一源码树。历史 v8 审查册在 `/mobile-review/`，显式标记旧规则、样例金额和不签名；保留旧反馈存储键和意见导出，不作为当前产品规则。完整来源和逐项状态见 [前端整合说明](../docs/frontend-integration-20260928.md)。

多矿机预算项目仅在 `integrated-v2` 清单含完整 5 个预算地址和代码摘要、关联核验成功时开放。父项目共 100 份；子矿机不各自重复计算用户份额。未领取 BEM 随转出份额按比例移动，历史 BNB 余款和卖款保留原地址。预算治理每轮仅一台、七天周期间隔，与单机池同轮多候选不同。已转走全部份额的历史持有人仍可领取自己的 BNB 债权。

Windows 可运行静态页面构建和纯前端测试；`server/live-api.test.mjs` 依赖 POSIX 0700 日志目录，应在 Linux 执行，不通过放宽权限获得假通过。钱包二维码跨设备连接需要实际 WalletConnect 配置；现有钱包扩展/手机钱包内置浏览器可检测连接，无配置时不能宣称已支持通用扫码。
