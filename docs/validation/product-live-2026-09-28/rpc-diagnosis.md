# 服务器 RPC 只读对照

UTC 2026-09-28 04:28:26–04:29:11，使用服务器 `/usr/bin/node` v24.20.0 和已发布 v2 runtime 的 ethers 6.17.0。与索引配置相同：12 秒 HTTP 超时、batchMaxCount=8、cacheTimeout=-1、staticNetwork=true、HTTP retry=false。未读密钥、未变更服务/配置/数据库、未签名。

在区块 124454251–124454298 各读取 6 批 × 8 个区块。两节点同时开始每一轮，均返回 chainId=56，48/48 成功，全部区块哈希一致。debug 事件确认每次批量请求确为 8 条。

|节点|每批8头最小/中位/最大|失败头|两次100块日志|
|---|---|---|---|
|bsc-dataseed.bnbchain.org|193 / 344.5 / 502 ms|0/48|2/2 失败，JSON-RPC -32005|
|bsc-rpc.publicnode.com|654 / 7768 / 11769 ms|0/48|2/2 成功，3212 / 1874 ms|

日志只查询新 core Factory 和 portfolio Factory：124453751–124453850 返回 9 条部署事件；124454251–124454350 返回 0 条。PublicNode 在本次日志样本可用，但 header 抖动已接近 12 秒限额。本小样本不代表长期可用性承诺。

建议保留 **dataseed 读头/调用 + PublicNode 读日志** 的分路，不把 header 也切 PublicNode。按样本平均每批耗时估算，63 批约500头分别需21.3秒和409秒；这是纯header外推，**不是500块完整索引实测**，未包括多类日志、同块核验、数据库提交和失败退避。此次日志测试固定100块范围；上线计划的 CHAIN_INDEX_SCAN_RANGE=500，实际单次日志范围为500，不能把此次100块日志耗时直接当作线上整轮耗时。上线等待应依据实际索引进度给有限总时限，期间继续 fail closed，不为缩短等待把完整性校验删除。

原始逐请求结果、hash、事件和批次记录：`rpc-headers-readonly.json`。原脚本 `rpc-headers-readonly.mjs` 和执行器 `run-rpc-headers-readonly.py` 可复核。
