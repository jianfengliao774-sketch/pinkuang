> 当前前端版本：v8（2026-09-26）。领取和分配以已部署合约为准；本目录是页面演示，不修改或替代后端合约规则。最新规则、审查入口及发布命令见 [rewards-policy-v8.md](design-notes/rewards-policy-v8.md)。

# 拼矿 BEMine · 设计前端

当前设计版本：2026-09-26 / v8，演示地址：https://tapeout.cc.cd/bemine/。

中文品牌「拼矿」，英文「BEMine」。墨绿香槟金主色，支持中文/英文、日常/深色外观，以及手机响应式布局。首页、资产总览、参与拼矿、矿机详情、矿机转让、收益中心、共同决策和公开记录均可交互预览。首页芯片及金币为独立前景动效，背景静止，提供暂停与减少动态效果支持。

## 开发和构建

使用 Node.js 24 与 pnpm。前端依赖独立于仓库根目录的合约工具链。

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

`out/`、`.next/`、`node_modules/` 和本地环境文件不入库。Next.js 使用静态导出，部署由静态服务器提供 `out/`，不使用 `next start`。

## 数据与合约边界

钱包、矿机、资产、交易和投票均为演示数据或浏览器内模拟，不签名、不发送链上交易。刷新恢复初始状态。Task 和算力 H 缺少来源时显示“—”。矿机质押与最优质保暂为说明入口。

最新页面规则由项目方在桌面审查中确认：100 个整数份额、每地址最多49份；合资购机募集金额为外部商城标价×1.01，每份金额为募集额÷100；矿机产出99%归持有人、1%平台费；本站份额和整机转让各收取1%平台费。投票与执行窗口为24小时。

**这些是当前设计预览规则，不代表本仓库已有合约实现了相同比例。** 本次只增加 `web/`，不修改合约、`deploy/` 控制台或部署产物。接入真实资金前必须核对链上实际费率、权限、流程与页面规则，使用整数金额、真实钱包交易状态及索引数据替代浮点演示数据。

首页币价独立于演示统计，是 PancakeSwap V3 BEM/WBNB 与 WBNB/USDT 同区块换算的 USDT 参考价。后台每15秒刷新；来源不符、失败或过期显示不可用。运行与部署见 [报价服务说明](ops/bem-price.md)。本地静态预览没有报价文件时显示不可用，不伪造价格。

## 主要文件

- `components/Platform.jsx`：工作台、详情、弹窗和演示操作。
- `components/SiteOverview.jsx`、`HeroScene.jsx`：首页、愿景、轻量前景动效。
- `components/PoolCatalog.jsx`、`lib/catalog.js`：分类列表、搜索、筛选与排序。
- `lib/demo-data.js`、`economics.js`：演示数据与统一计算口径。
- `lib/i18n.jsx`、`*-en.js`：中英文文案。
- `components/BemPriceStat.jsx`、`scripts/update-bem-price.mjs`：币价展示及只读缓存服务。
- `public/`：标志、原始/压缩图像、本地字体与许可。
- `app/design/`：品牌候选历史对比页；`app/mobile-review/`：当前90项手机审查；`app/review/`：兼容入口，共用最新组件。

中文字体为已提交的 WOFF2 子集，新增字符可运行 `scripts/subset-preview-font.py /path/to/NotoSansSC.ttf`；需 Python fonttools 和 brotli。图片压缩脚本为 `scripts/optimize-hero.mjs`，默认运行已提交的 WebP 无需重生成。

## 当前发布与版本保留

v8 静态目录为 `/var/www/bemine-preview/releases/20260926-rewards-v8`，`current` 指向当前发布。更新采用新目录完整上传后切换软链接，保留旧版留档。

每次发布保留 `data` 软链接指向独立报价缓存。运行 `node scripts/prepare-preview-release.mjs` 生成旧审查入口的新版跳转；旧发布目录只留档，不再链接回公开入口。当前审查地址：https://tapeout.cc.cd/bemine/mobile-review.html。

本次提交以远端 `codex/deploy-console` 的 `8ce9535` 为基础，只新增前端目录内容。原合约、部署控制台及已绑定源码的部署产物保持不变。详细桌面修改与定名记录见 [v6审查记录](design-notes/desktop-review-v6.md) 和 [v7定名记录](design-notes/brand-v7.md)。
