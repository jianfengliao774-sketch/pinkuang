# 拼矿集成版测试入口（2026-09-27）

测试地址：<https://tapeout.cc.cd/bemine-test/preview.html>。这是样例数据的交互预览，不会提交真实资金交易。正式页面 <https://tapeout.cc.cd/bemine/> 保留原发布版本；本轮没有切换它的 `current` 链接，也没有发送链上交易。

集成分支 `codex/firsto-frontend-integration` 的 `fdd05b5` 用 Node.js 24 构建为 `/bemine-test` 静态资源，独立发布到 `/var/www/bemine-preview/releases/bemine-firsto-test-20260927T122227Z`，由 `current-test` 链接提供。Nginx 只新增 `/bemine-test/` 静态路径和同源 `/bemine-test/api/` 代理；原 `/bemine/`、部署台和索引服务保持运行。发布文件 202 个的 SHA-256 与本地构建逐一吻合，公网 `index.html` 摘要为 `7bb8d27bbc00649f73dc4abcd29f4b146e2e496372863230ebb22709f346df00`。正式页摘要仍为 `f8ccba03a30cbd8b5fd23f09732be3839c4f438cd27a9034c50607bfd41806f8`。

`/bemine-test/` 的真实链上入口会显示“部署清单与当前页面合约版本不一致”。这是预期的拒绝签名：测试页使用新合约源码生成的 ABI/摘要，主网已部署 Factory 和服务器清单仍是旧版；不应伪造清单摘要或绕过校验让新版页面对旧合约发送交易。当前 Factory 的 `poolCount()` 为 0，也尚无真实份额市场订单。主网 Firsto 建池和采购必须等升级合约、核验实施记录及更新服务器清单之后再测；具体变更另见 [延后升级报告](audits/2026-09-27/baseline-readonly-and-deferred-upgrade.md)。

本次验证：`pnpm check` 193/193；`NEXT_PUBLIC_BASE_PATH=/bemine-test pnpm build` 通过；离线浏览器用模拟 RPC 和禁止写入的钱包完成 6 项 Firsto 流程检查，包括旧 Factory 下仍可只读核对报价、但不能填入建池或预览发送 Firsto 采购。公网测试页、报价缓存、部署清单和索引探针正常返回；未登录日志接口返回预期 401。实机浏览器已打开演示页，并进入募集项目列表，确认样例数据与“演示环境”标识可见。Firsto 实时报价上游在发布时返回过 400/429，不能据此宣称实时行情可用或采购实测通过。

如需撤下测试入口，先核对当前 Nginx 配置未被后续发布修改，再恢复 `/etc/nginx/sites-available/bem2075.backup-firsto-test-20260927T122227Z`，通过 `nginx -t` 后重载。正式站点不依赖 `current-test`。
