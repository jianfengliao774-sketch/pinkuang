# 用户持仓挂单与三位小数显示（2026-09-28）

## 本轮行为

- 正式主页资产持仓、市场“出售我的份额”的每一行直接提供“挂单出售”，自动绑定该矿池，读取用户持有、锁定与可售份额。默认填入全部可售份额，允许修改；无需运营角色或手工填写合约地址。列表可翻页，不限于首批持仓。
- 多机预算项目详情直接展示“出售我的项目份额”，自动绑定父项目与可售份额。切换项目或可售份额变化会重置旧价格和数量，避免沿用其他项目的订单草稿。
- 展示层 BNB、BEM、日产能、产能参考价和美元价格统一四舍五入到三位小数，整数份额、矿机数量和时间不改为小数。历史设计审查样张保留其可追溯内容。
- 新 `amount-display.mjs` 使用整数计算处理链上原值；`share-listing-view.mjs` 只允许余额、锁定和可售数量一致且允许交易的持有人挂单。现有模拟、版本核验、记录确认和签名许可均保留。
- 自动报价、订单和链上金额不被显示函数回写。验证用挂单价格 `0.075500000000000001` 显示为 `0.076`，实际 calldata 仍为 `75500000000000001` wei。人工募集金额已有的三位规范化规则保留，未扩张此次输入业务变更。

## 验证结果

- Web Node 单测：257 通过，0 失败。
- `/bemine-v2` 静态构建：ABI 核验通过，23 页生成成功。
- Chrome 浏览器：持仓挂单及市场成交 2 项、预算项目 15 项、Firsto/官网采购 7 项，共 24 项通过。使用模拟 RPC/API 和钱包，不发送主网交易。
- 挂单用普通持有人验证运营入口不可见、无需地址输入、锁定份额扣除、原值 calldata，以及 `intent-ack → permit-ack → send → hash-ack` 的顺序。预算回归包含异步串池保护、手机 375/390/430px、英文界面及精确付款。采购表单仍保留 `0.005050000000000001` 的原报价。
- 构建输出 `out/data/frontend-manifest.json` 与公共源清单 SHA-256 一致：`5BF6596502E966DE526E899C31D4BC71EF2A9A176E365BF75C0603A12C1B10AE`。该检查不代表网站已发布或链上资金流程已现场验收。

## 重跑

在 `web/` 中执行以下命令；单测使用测试默认根路径，构建和浏览器使用正式子路径。

```powershell
Remove-Item Env:NEXT_PUBLIC_BASE_PATH -ErrorAction SilentlyContinue
Remove-Item Env:NEXT_PUBLIC_DEPLOY_CONSOLE_URL -ErrorAction SilentlyContinue
node --test scripts/*.test.mjs

$env:NEXT_PUBLIC_BASE_PATH='/bemine-v2'
$env:NEXT_PUBLIC_DEPLOY_CONSOLE_URL='https://tapeout.cc.cd/pinkuang-deploy-v2/'
pnpm build

# 用静态服务器将 out/ 挂载到 /bemine-v2/；不要再次构建测试用假清单。
$env:BEMINE_TEST_BROWSER='chrome'
$env:BEMINE_TEST_URL='http://127.0.0.1:3200/bemine-v2/'
# BEMINE_PLAYWRIGHT_MODULE 指向本机可用的 Playwright index.mjs。
node scripts/market-submit-browser-check.mjs
node scripts/portfolio-browser-check.mjs
node scripts/operator-firsto-browser-check.mjs
```

Windows 本次静态测试服务使用无访问日志的 `ThreadingHTTPServer`，请求队列 128，避免并行浏览器资源请求因默认队列不足被拒绝。所有浏览器脚本均拦截清单、RPC/API，不依赖真实主网钱包。

本机证据位于工作区 `outputs/`：`web-listing-three-decimal-unit.log`、`web-listing-three-decimal-build.log`、`listing-three-decimal-market-browser.json`、`listing-three-decimal-verified-portfolio-browser-check/results.json`、`listing-three-decimal-verified-operator-firsto-browser-check/results.json`。截图保存在后两个目录，未加入代码仓库。
