# 拼矿 BEMine · 产品前端

当前代码以最新合约、部署台与索引服务为基础完成产品页面接线。主网合约尚未部署；线上交互预览：https://tapeout.cc.cd/bemine/preview.html#home，分享预览：https://tapeout.cc.cd/bemine/preview.html#share/16928，海报与标语画廊：https://tapeout.cc.cd/bemine/posters.html。正式入口无清单时显示即将开放。完整接线与环境要求见[产品对接说明](../docs/product-integration-and-sharing.md)，最新的 9 张海报、18 条标语及随机搭配见[v11 合集记录](../docs/share-collection-v11-20260927.md)，之前的详情修改见[v10 改版记录](../docs/share-update-v10-20260927.md)。

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

真实合约部署使用仓库的独立 `deploy/` 服务。主产品页由 `LivePlatform` 读取清单和同源 API；无清单时关闭交易。原设计演示移至 `/preview.html`（开发环境 `/preview`），在构建时设置 `NEXT_PUBLIC_DEPLOY_CONSOLE_URL`，主产品页才显示“管理员 · 合约部署”入口；公网地址必须是 HTTPS，本地开发可用 `http://localhost:4173/`。该地址必须指向有持久服务器操作日志的部署服务，不能指向静态 Vite 文件或演示页。例如本地联调：

```sh
NEXT_PUBLIC_DEPLOY_CONSOLE_URL=http://localhost:4173/ pnpm build
```

部署台的运行条件见 [deploy/README.md](../deploy/README.md) 和 [服务器日志配置](../deploy/server/JOURNAL.md)。

`out/`、`.next/`、`node_modules/` 和本地环境文件不入库。Next.js 使用静态导出，部署由静态服务器提供 `out/`，不使用 `next start`。

## 数据与合约边界

正式入口使用真实钱包适配、同源数据代理与服务器持久交易日志；缺少部署或可信数据时停止交易并显示不可用。只有 `/preview.html` 保留浏览器内模拟操作，刷新恢复初始状态。Task、算力及日产缺少可靠来源时显示“—”。矿机质押与最优质保暂为说明入口。

最新确认规则：100 个整数份额、单地址可认购全部100份；参考产能价加默认10%预留筹资，每份金额为募集额÷100，余款按购机时份额退回。矿机产出99%归持有人、1%平台费；份额和整机转让各收取1%。收益先归集入池，权益钱包再各自领取，无冷却、无到期、无销毁。低于实际购机价的出售至少60%份额同意且人数过半，其余严格双过半；投票期间冻结份额交易，仍可撤单，挂单7天到期。

本轮合约已同步这些规则，新增 `PoolLens`、checked 建池接口及 `lib/chain-client.mjs` 适配器。**主产品页面已接线，但尚无已部署的主网地址，不能视为真实交易联调完成。** 演示中的浮点数据不能用于签名；适配器金额使用精确整数，只返回只读状态和未签名的个人直调交易。`pnpm build` 和 CI 强制独立重编核对 ABI；修改合约后先更新部署产物，再执行 `pnpm contracts:sync`。历史记录、全局聚合和二级市场成本需事件索引，不用演示数据补空。

首页币价独立于演示统计，是 PancakeSwap V3 BEM/WBNB 与 WBNB/USDT 同区块换算的 USDT 参考价。后台每15秒刷新；来源不符、失败或过期显示不可用。运行与部署见 [报价服务说明](ops/bem-price.md)。本地静态预览没有报价文件时显示不可用，不伪造价格。

## 主要文件

- `components/LivePlatform.jsx`、`lib/live-*.mjs`：真实产品页面、数据、精确交易与恢复。
- `components/ProjectShare.jsx`、`lib/project-share.mjs`：认购确认后的分享卡及受信项目链接。
- `components/Platform.jsx`：原工作台、详情、弹窗和演示操作，仅用于 preview/review。
- `components/SiteOverview.jsx`、`HeroScene.jsx`：首页、愿景、轻量前景动效。
- `components/PoolCatalog.jsx`、`lib/catalog.js`：分类列表、搜索、筛选与排序。
- `lib/demo-data.js`、`economics.js`：演示数据与统一计算口径。
- `lib/i18n.jsx`、`*-en.js`：中英文文案。
- `components/BemPriceStat.jsx`、`scripts/update-bem-price.mjs`：币价展示及只读缓存服务。
- `public/`：标志、原始/压缩图像、本地字体与许可。
- `app/design/`：品牌候选历史对比页；`app/review/`：v5审查工具源码，非最新设计验收基线。

中文字体为已提交的 WOFF2 子集，新增字符可运行 `scripts/subset-preview-font.py /path/to/NotoSansSC.ttf`；需 Python fonttools 和 brotli。图片压缩脚本为 `scripts/optimize-hero.mjs`，默认运行已提交的 WebP 无需重生成。

## 历史发布记录与版本保留

历史 v7 静态目录为 `/var/www/bemine-preview/releases/20260926-brand-v7`，`current` 为发布时切换的入口。更新采用新目录完整上传后切换软链接，保留旧版回滚。

每次发布保留 `data` 软链接指向独立报价缓存，以及 `review-20260926` 指向历史v5审查册。历史审查地址：https://tapeout.cc.cd/bemine/review-20260926/review.html。

原 v7 设计提交基于 `codex/deploy-console` 的 `8ce9535`。本轮产品接线基于 `codex/deployment-page` 的 `44a5db7`，扩展服务器日志与只读代理；未修改 Solidity 或已绑定产物。详细桌面修改与定名记录见 [v6审查记录](design-notes/desktop-review-v6.md) 和 [v7定名记录](design-notes/brand-v7.md)。
