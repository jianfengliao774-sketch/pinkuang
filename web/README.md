# 拼矿 BEMine · 设计前端

当前设计版本：2026-09-26 / v7，演示地址：https://tapeout.cc.cd/bemine/。

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

`out/`、`.next/`、`node_modules/` 和本地环境文件不入库。Next.js 使用静态导出，部署由静态服务器提供 `out/`，不使用 `next start`。

## 数据与合约边界

钱包、矿机、资产、交易和投票均为演示数据或浏览器内模拟，不签名、不发送链上交易。刷新恢复初始状态。Task 和算力 H 缺少来源时显示“—”。矿机质押与最优质保暂为说明入口。

最新确认规则：100 个整数份额、每地址最多49份；参考产能价加默认10%预留筹资，每份金额为募集额÷100，余款按购机时份额退回。矿机产出99%归持有人、1%平台费；份额和整机转让各收取1%。收益先归集入池，权益钱包再各自领取，无冷却、无到期、无销毁。低于实际购机价的出售至少60%份额同意且人数过半，其余严格双过半；投票期间冻结份额交易，仍可撤单，挂单7天到期。

本轮合约已同步这些规则，新增 `PoolLens`、checked 建池接口及 `lib/chain-client.mjs` 适配器。**页面仍是演示，并未接入真实钱包/池地址。** 演示中的浮点数据不能用于签名；适配器金额使用精确整数，只返回只读状态和未签名的个人直调交易。`pnpm build` 和 CI 强制独立重编核对 ABI；修改合约后先更新部署产物，再执行 `pnpm contracts:sync`。历史记录、全局聚合和二级市场成本需事件索引，不用演示数据补空。

首页币价独立于演示统计，是 PancakeSwap V3 BEM/WBNB 与 WBNB/USDT 同区块换算的 USDT 参考价。后台每15秒刷新；来源不符、失败或过期显示不可用。运行与部署见 [报价服务说明](ops/bem-price.md)。本地静态预览没有报价文件时显示不可用，不伪造价格。

## 主要文件

- `components/Platform.jsx`：工作台、详情、弹窗和演示操作。
- `components/SiteOverview.jsx`、`HeroScene.jsx`：首页、愿景、轻量前景动效。
- `components/PoolCatalog.jsx`、`lib/catalog.js`：分类列表、搜索、筛选与排序。
- `lib/demo-data.js`、`economics.js`：演示数据与统一计算口径。
- `lib/i18n.jsx`、`*-en.js`：中英文文案。
- `components/BemPriceStat.jsx`、`scripts/update-bem-price.mjs`：币价展示及只读缓存服务。
- `public/`：标志、原始/压缩图像、本地字体与许可。
- `app/design/`：品牌候选历史对比页；`app/review/`：v5审查工具源码，非最新设计验收基线。

中文字体为已提交的 WOFF2 子集，新增字符可运行 `scripts/subset-preview-font.py /path/to/NotoSansSC.ttf`；需 Python fonttools 和 brotli。图片压缩脚本为 `scripts/optimize-hero.mjs`，默认运行已提交的 WebP 无需重生成。

## 当前发布与版本保留

v7 静态目录为 `/var/www/bemine-preview/releases/20260926-brand-v7`，`current` 指向当前发布。更新采用新目录完整上传后切换软链接，保留旧版回滚。

每次发布保留 `data` 软链接指向独立报价缓存，以及 `review-20260926` 指向历史v5审查册。历史审查地址：https://tapeout.cc.cd/bemine/review-20260926/review.html。

本次提交以远端 `codex/deploy-console` 的 `8ce9535` 为基础，只新增前端目录内容。原合约、部署控制台及已绑定源码的部署产物保持不变。详细桌面修改与定名记录见 [v6审查记录](design-notes/desktop-review-v6.md) 和 [v7定名记录](design-notes/brand-v7.md)。
