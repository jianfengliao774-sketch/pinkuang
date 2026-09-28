# 真实部署台报价只读验收

2026-09-28 12:34（Asia/Shanghai）访问 `https://tapeout.cc.cd/pinkuang-deploy-v2/`，未注入或连接钱包，未保存计划，未发送任何 POST、签名或链上交易。

`quotes-browser.json` 为随仓通过证据。市场参考价原值 `8037551440329218106` wei 显示 `8.038`。挂单价排序与日产能价排序分别核对 30 台真实矿机，逐行匹配同一次来源响应的 NFT 身份、纯验证状态、未验证权重 0、挂单价、买方价、预计日产与本机日产能价；排序使用原始整数和交叉乘验证。源区块 124461520。

例如 TapeOut #15852：挂单 `0.039`，日产 `0.004`，本机日产能价 `9.025`。日产能排序首台 TapeOut #2465：挂单 `40.000`，日产 `5.629`，本机日产能价 `7.106`。因此按日产能价排序并不要求整机挂单价递增。

桌面与 390px 检查通过，document/viewport 均为 390；无 HTTP 错误、console error、pageerror 或写入请求。来源完整 JSON 与截图保留在执行工作区 `outputs/pinkuang-mainnet-readiness-20260928/live-browser/deploy-pricing/`，本目录保存逐行金额与断言结果。

首次测试的 CDP `response.json()` 因页面在完整读完响应后 abort 清理，失去浏览器响应句柄。`failure.png` 仅记录此测试采集问题时已正常显示的页面。脚本改为对同一真实 GET Response 作 clone 旁路读取，原 Response 原样返回页面，未替换或伪造数据；最终所有精确数据断言保持。

此结果只证明部署台报价页。新版产品主页当时仍等待索引补齐，尚未访问或验收。
