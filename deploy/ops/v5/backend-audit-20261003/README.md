# 2026-10-03 后端审核修复上线

- 业务补丁：788cd0d705ba053615b5f5a8c319a6eeb752a1a7；基础运行包 dea3a78b51352df45771ce6d54043b874e70383e。
- 范围：未 arm 的 Firsto 准备记录、合并展示就绪查询、一小时历史展示缓存（闲置两分钟停刷新）、nginx 展示/SSE 限流、API 只读 RPC 路由。
- 上线时间：installation.json；最终 API operationalReady=true。
- 仅重启 pinkuang-product-v5，合约、前端、signer、自动购机/挖矿 worker 与私有日志不变。

## 故障与处置

初次上线仍因付费 RPC 429（HTTP 599 包装）读取失败，健康检查触发回滚。对照使用官方公共 RPC 完成 110 次读取的完整核验约 2.25 秒。最终新增 root-only 的 `/etc/pinkuang-v5/public-api-read.env`，仅覆盖 API 进程的 DEPLOYMENT_JOURNAL_RPC_URL 为 https://bsc-dataseed.bnbchain.org。索引日志的付费 RPC、私有 signer、购机/挖矿节点没有修改。官方公共节点不是付费节点的可用性保证，原有链 ID、runtime、角色及区块哈希校验保留。

## 验证

`backend-tests.tap`：78 通过；`display-tests.tap`：9 通过，均为服务器 Node 24.20.0。87 项定向回归不是完整安全认证。旧 integrated upgrade fixture 的 6 项既有失败见报告。

`http-verification.json`：正式首页、产品图、统计、项目、币价 200；旧站关闭状态 503。浏览器首页加载统计与币价，无读服务错误。未发起钱包连接或交易。

完整结论及未修项：[后端复核](../../../../docs/security/backend-review-2026-10-03.md)。R1、R2 仍需合约修复；原生卖单能力识别与累计 1000 池等事项未在此补丁解决。

## 安装及回滚边界

`install.py` 先验证基础包、全部 runtime module 哈希与测试结果，保留原运行包，然后创建新 API 目录。仅保留经过逐文件验证的失败候选可重用，不覆盖未知候选。首次冷图验证失败时自动恢复旧 nginx、移除新 drop-in 和只读 RPC override，重启旧 API。

已激活后不应直接重跑安装器。若需人工回滚，使用服务器 `/root/bemine-v5-upload/backend-audit-20261003/nginx-before.conf` 恢复 `/etc/nginx/snippets/bemine-v5-product.conf`，移除本补丁的 `40-backend-audit.conf`、`bemine-v5-read-limits.conf` 和 `public-api-read.env`，先 nginx -t，再 daemon-reload、重启 product API、reload nginx。注意：回退付费 RPC 会重新暴露其 429 故障；回滚不解决上游限流。
