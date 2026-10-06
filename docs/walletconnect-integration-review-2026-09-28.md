# WalletConnect 接入独立复核（2026-09-28）

本轮检查产品页面和部署台的 WalletConnect 2.25.0 接入，未连接真实手机钱包、未签名、未发送链上交易，也未更改线上服务。配置与实际域名验收见 [walletconnect-setup.md](walletconnect-setup.md)。

## 已修正并复核的问题

1. 手机批准会话后，产品页面还需读取账户与网络。取消或关闭弹窗必须使这一层等待也失效，不能只取消 SDK 配对。当前 `LivePlatform` 以独立 ticket、弹窗对象和钱包上下文版本核对结果；迟到结果只清理原 provider，不影响重试后的钱包。
2. 已安装 SDK 的 EIP-155 provider 对 `eth_chainId` 返回数值 `56`，而业务资金处理只接受精确整数文本或 BigInt。当前 facade 仅将安全整数链 ID 规范化为 `0x38`；资金数量和其余 RPC 结果原样保留，不放宽金额解析。

`abortPairingAttempt()` 在固定 SDK 2.25.0 中为空操作。当前连接器使用本次配对 topic 的 disconnect、实例专属存储前缀及外层 ticket，使取消后的旧批准不能接管下一次连接。`disconnect()` 先捕获原实例并清掉缓存；其迟到结果不会清掉新连接缓存。

## 回归与边界

从仓库根目录运行：

```sh
node --test web/scripts/walletconnect-integration.test.mjs
```

本次结果：**6 passed、0 failed、0 skipped**。该文件已纳入 `web` 的 `scripts/*.test.mjs` 常规检查：

- SDK 数值链 ID 通过实际产品 `connectWallet` 的严格校验。
- 已批准但还在等待账户核对时取消，之后重试；旧结果不能替换或断开新钱包。
- 旧实例断开尚未返回时，新实例仍能连接并保留缓存。
- WalletConnect 发送响应丢失后，实际 `sendProductTransaction` 保留待核对记录；再次调用不会第二次发送。
- 大整数数量及原始错误原样透传，facade 不重试发送。
- 账户/钱包上下文在等待期间改变时，旧批准不得被接纳。

回归使用实际 connector、facade、产品交易函数，以及当前 `LivePlatform` 的连接函数源码；SDK、React 状态容器和交易日志服务使用可控测试替身。它验证异步与持久意图边界，不代表完成了真实浏览器、真实 relay 或手机钱包的端到端验收。部署台另有 `deploy/scripts/walletconnect.test.mjs` 连接器回归。

未设置有效 Project ID 时扫码入口隐藏且不会初始化 SDK；不能用示例编号声称扫码已开通。扩展钱包和钱包内置浏览器沿用原入口。

## 上线仍需满足的条件

填写项目方公开 Project ID、确认实际域名允许列表、重新构建并验证 CSP 后，需在真实手机钱包验证扫码、拒绝、取消、超时、重连和 BSC 账户/网络变化。部署台连接后沿用本站日志认证签名，不是链上付款。

新旧站若使用独立日志数据库，其 nonce 锁也相互独立。WalletConnect 不消除这个边界：同一部署钱包不能同时在旧站、新站或外部钱包发交易；切换前先核清旧待处理记录、链上 nonce 与回执。恢复未知交易保持只读核验，不自动重签。
