# 2c2fe82 真实站点只读复验：尚未通过

- 页面：`https://tapeout.cc.cd/bemine-v2/`
- 时间：2026-09-28 05:33:47–05:34:37 UTC。
- Chrome 无注入钱包；未连接钱包、签名或发送交易，写请求拦截记录为零。
- 真实公共清单为 integrated-v2，Factory `0x2995b10d19056c8c24c57b281c22562a603c571f`、预算 Factory `0x07fc0b1118529ba3c7c406058699b9b57dd9e360` 均正确。
- `pools?cursor=0&limit=20` 与 `stats` 于 05:33:51–05:34:32 UTC 连续七轮返回 HTTP 503，覆盖约 40 秒。新的有界自动重试逻辑已在真实站点执行，但整个窗口均没有成功响应。
- 最终首页显示明确的“数据服务暂不可用（HTTP 503）”“重新读取项目”“数据暂不可用”。这证明失败状态与手动恢复入口已生效，不代表数据读取成功。
- 独立币价正常显示 `49.268 USDT`；本次无资源 404、无 JavaScript pageerror。仅记录一次已中止的只读 RPC 请求。
- 因首页数据未成功，验收在首页终止。其余六个页面与手机视口尚未完成本轮真实验收，不能宣称七页通过。
- 未以人工刷新或反复重跑掩盖失败。原始网络记录和错误见 [final-product-browser.json](final-product-browser.json)；截图保留在执行工作站 `outputs/pinkuang-mainnet-readiness-20260928/live-browser/read-recovery-final/failure.png`，前两次失败目录也保留。

后续需后端结合以上时间窗定位索引可用性，修复或取得明确新证据后再在新目录复验。现有检查仍要求完整图谱、真实数据和最终无错误，不放宽验证。
