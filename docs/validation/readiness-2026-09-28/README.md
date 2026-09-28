# 2026-09-28 浏览器与构建验证

本目录保存最终源码的本地验证结果。所有浏览器链数据、钱包、交易日志均为测试替身；不代表真实手机 WalletConnect 配对、主网签名或生产服务验收。

## 最终浏览器结果

- `wallet-browser.json`：6 项，扩展钱包选择、拒绝、重复请求、关闭后迟到结果、读取期间连接及手机无扩展提示。
- `wallet-hydration-browser.json`：2 项，桌面与手机在 RPC 故意挂起时第一下即可打开选择弹窗；SSR 阶段保持禁用，防止未初始化误点击。
- `portfolio-browser.json`：14 项，真实适配器配合离线链数据，涵盖预算订阅、持久签名许可、确认分享、容量完整读取、异常撤掉旧值、中英及三种手机宽度。
- `procurement-browser.json`：7 项，Firsto 候选费用、重复矿机、官方优先替代与旧版本/迁移/钱包切换保护。

合计 **29 项通过**。四套测试并发执行；页面错误及静态文件连接拒绝均为 0。未修改业务源码或放宽断言来通过此次回归。

## 初始失败的定位

最初钱包与预算测试停在 SSR 的禁用按钮。附加请求追踪后发现：静态 JS 请求出现 `net::ERR_CONNECTION_REFUSED`；预算页面 10 个所需 JS 响应全部缺失，没有 React 页面错误。仅关闭请求日志仍能复现，所以不能归因于日志输出积压。

当前 Python 3.12 的 `ThreadingHTTPServer.request_queue_size` 实测为 **5**。只把本地测试服务器的待连接队列改为 **128** 后，相同构建、相同浏览器测试及相同断言并发通过。最小证据见 `browser-server-diagnostic.json`；完整请求记录保留在本机 outputs/pinkuang-rewrite-handoff-20260928/trace-four-* 与 verified-*。这是本机静态测试服务器容量问题，不是已发现的产品连接取消逻辑回归。

## 重跑命令

在 `web` 目录，以根路径构建的 `out` 启动仅本机静态服务器；命令不启动生产服务：

```powershell
python -c "import http.server, functools; Handler = type('QuietHandler', (http.server.SimpleHTTPRequestHandler,), {'log_message': lambda self, *args: None}); Server = type('BrowserTestServer', (http.server.ThreadingHTTPServer,), {'request_queue_size': 128}); Server(('127.0.0.1', 3200), functools.partial(Handler, directory='out')).serve_forever()"
```

另一个终端在 `web` 目录执行。若 Playwright 使用外部 runtime，将 `BEMINE_PLAYWRIGHT_MODULE` 设为该 runtime 的 index.mjs 文件 URL；未设置则使用已安装的 `playwright` 模块。本次使用 Chrome。

```powershell
$env:BEMINE_TEST_URL='http://127.0.0.1:3200/'
$env:BEMINE_TEST_BROWSER='chrome'
node scripts/wallet-connect-browser-check.mjs
node scripts/wallet-hydration-browser-check.mjs
node scripts/portfolio-browser-check.mjs
node scripts/operator-firsto-browser-check.mjs
```

可分别用 `BEMINE_BROWSER_OUTPUT` 指定截图目录。若构建设置 `NEXT_PUBLIC_BASE_PATH=/bemine-v2`，测试服务也必须将产物挂载到该前缀并相应修改 URL，不能把带前缀的构建错误地当作根路径部署。

## WalletConnect 验证边界

连接器与实际产品连接函数的取消、迟到结果、numeric chain ID 和未知发送状态由 `deploy/scripts/walletconnect.test.mjs` 与 `web/scripts/walletconnect-integration.test.mjs` 的 **16 项**测试覆盖。本目录浏览器用例尚不代表真实 QR 配对；当前未提供 Project ID，扫码入口按设计不显示，扩展钱包/钱包内浏览器仍可用。相关条件见 ../../walletconnect-setup.md。静态检查未发现 QR 样式被隐藏；实际 QR 与手机 relay 验收须在配置后完成。
