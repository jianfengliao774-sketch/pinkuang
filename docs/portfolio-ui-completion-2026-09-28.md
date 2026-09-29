# 预算项目剩余前端功能补齐

本轮基于 `697f2e3` 继续整合，Solidity、ABI、费用规则未由本项修改。开发和浏览器检查不使用真实钱包、不广播交易，也不把模拟通过写成主网验收完成。

## 综合日产能参考

`web/lib/portfolio-capacity.mjs` 在同一核验区块读取预算父项目和完整子机列表，每页最多 100 台，报价每批 4 台并发。无 100 台或 1000 台的任意总数截断；最终核对子机总数、父项目 activeChildCount、唯一子池/矿机身份和区块哈希。当前 NFT 必须仍由相应子池持有，引用真实 `readShareDailyCapacityPrice` 的精确 NFT 详情、BEM 8 位整数、来源区块和五分钟有效期检查。

已售且归集完成的子机，以及已成交 Closed 但父项目尚未 settle 的子机，均不再计入产能。任一未知、缺页、重复 NFT、错误所有权、过期报价、重组或被导航中断时，不发布部分合计或假零；完整且确实没有仍持有矿机的项目可以显示零产能，但没有日产能价格。

`PortfolioCapacity` 是独立、显式读取的参考面板，不作为认购、挂牌、提款的前置条件。展示税前预计日产 BEM、按 100 份分摊的参考日产、原募集预算 / 参考日产 1 BEM 的价格、排除数量和核验区块。价格不是当前份额挂牌价，不加份额交易手续费，不更改任何 exact Wei。失效后隐藏参考值，可重新核对。报价代理沿用统一 `QUOTE_BASE`，新 `/bemine-v2` 构建不走旧站点的代理路径。

## 分享和认购成功

`PortfolioProjectShare` 保持朋友墨绿和香槟金风格，提供预算项目专用静态海报、Telegram/X 用户确认发布入口、复制和下载。SVG 原稿及 PNG 一同入库，`node scripts/build-portfolio-poster.mjs` 可从源稿复现 PNG。图片上不写入旧部署地址或个人信息。

普通分享接 `LivePortfolios.onShare(rawVerifiedPortfolio)`。认购成功由父层 journal 恢复最终回执后重读预算项目，再传给分享组件。`isConfirmedPortfolioDeposit` 要求最终确认、deposit、targetType=portfolio、factory=OFFICIAL_FACTORY、target/poolAddress/receipt.to 同一父项目、有效份额和金额；仅最终金额/事件核验来自后台，组件只做展示保护，不能替代后台验证。

分享正文及公开链接不包含钱包、个人投入或交易哈希。预算父项目直接入口为 `#portfolio/<address>`，独立社交入口为 `budget-share.html?project=<address>&source=tg|x|native`。只接受可信域名、品牌版本基址及白名单参数；专属静态页带预算海报 OpenGraph/Twitter 信息，客户端只跳回本站父项目。原单机九款海报也保留新发布基址 `/bemine-v2/`，不会把新项目地址引回旧站点。

## 双语与队列挂载

`LivePortfolios` 的目录、权益、全部表单、确认、逐台治理、份额市场、历史记录和错误展示均接入 `portfolio-copy.mjs`。容量和分享组件本身有中英文；外部未知中文错误在英文页面提供清楚的英文重试提示。钱包/项目/路由变化的旧预览清理、exact Wei 和可提旧 BNB 债权规则保持。

Funded 预算项目的运营区挂载 `BudgetPurchaseQueue`，替换手填子池地址入口。普通用户的资产、参与、收益、治理和市场面板仍可进入父项目；采购队列只对对应预算 operator 可见。队列单步使用专门 `onSendQueue`，父层负责核心 Factory 建子池与预算父合约采购的不同 targetType；不能误用只处理父目标的 `onSend`。队列源码、状态恢复和后端候选覆盖检查由采购队列任务维护。本项浏览器只核验其真实挂载与入口，完整逐笔资金路径由该任务的专项验证覆盖。

## 已执行验证

```powershell
cd web
node --test scripts/portfolio-capacity.test.mjs scripts/portfolio-share.test.mjs scripts/portfolio-copy.test.mjs scripts/project-share.test.mjs scripts/share-landing.test.mjs
pnpm build
$env:BEMINE_TEST_URL='http://127.0.0.1:3198/'
$env:BEMINE_TEST_BROWSER='chrome'
$env:BEMINE_PLAYWRIGHT_MODULE='file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'
node scripts/portfolio-browser-check.mjs
```

27 定向单测通过；23 静态页面构建通过；14 个预算浏览器检查通过。Chrome 使用本地静态产物，所有 RPC、报价、索引和 journal 被 fixture 拦截；一次模拟钱包请求、零真实交易。桌面及 375/390/430 宽度检查包括确认框和分享框，未发现页面横向溢出。容量适配器浏览器验证包含正值、已售/待归集排除及外部 API 失败后清旧值；单测额外覆盖 101 台完整分页、缺页/身份异常、重组和导航过程中取消。

浏览器小证据保存在 `docs/validation/readiness-2026-09-28/portfolio-browser.json`。本地完整截图目录为 `outputs/pinkuang-ready-chain-20260928/browser-portfolio/`。最终合并后的全量测试和构建由主发布记录补充；模拟浏览器不能证明外部钱包真机、Telegram 配置或新主网合约已经验收。
