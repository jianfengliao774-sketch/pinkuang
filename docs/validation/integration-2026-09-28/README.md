# 2026-09-28 整合版验证记录

这些是本机工作区及隔离 Linux 副本的实际验证记录，不是主网部署或远端 CI 结果。原始日志未改写；其中 `sourceCommit=5f160c5…` 是测试时尚未提交改动的基线 HEAD，**不是将新代码标成该旧提交**。被测试代码由各目录 `source-sha256.json` 绑定；`final-source-consistency.json` 重新核对三个验证批次和最终 34 个生产源码文件无差异。最终编译产物中的 `sourceCommit` 指向提交后的真实源码。

| 验证 | 结果 | 证据 |
|---|---|---|
| 完整合约单元、模糊测试、不变量 | 482 通过；CI 不变量 128 × 64 | `final-contracts-v2/forge-test.log` |
| Slither | `--fail-medium` 退出 0，仍有低级与信息项 | `final-contracts-v2/slither.log` |
| 历史存储与链接库 | OZ 26 项通过；预算 5f 基线、Firsto 临时授权、构造器执行器检查 | `upgrade-final/`、`budget-layout-comparison.json` |
| 原协议 fork，BSC 123728000 | 42 通过；5 个后期 suite 明确跳过 | `protocol-fork-final/summary.json` |
| Firsto fork，BSC 124308679 | 12 通过、0 跳过；包含上述后期 suite | `firsto-final-current/firsto-fork.log` |
| 部署、nonce 替换/取消、市场并发与恢复 | 81 通过、0 跳过；本地一次性 Anvil 账户 | `deployment-final-tests.log` |
| 独立编译、产物摘要与链接 | 8 通过 | `artifacts-final-tests.log` |
| Linux 完整后台 | 172 通过 | `linux-backend-tests.log` |
| Linux 最终后台增量 | 134 通过；与上一行有重复，不相加 | `linux-backend-final-delta.log` |
| Linux 最终 71 源产物/图/恢复 | 18 通过 | `linux-final-artifact-check.log` |
| 旧前端服务 API | Linux 13 通过 | `linux-web-server-tests.log` |
| 产品前端单测 | 219 通过 | `frontend-unit-tests.log` |
| 桌面/手机浏览器 | 预算、通知、官网/Firsto采购各7项，共21项，使用隔离模拟钱包 | `frontend-portfolio-browser.json`、`frontend-notification-browser.json`、`frontend-procurement-browser.json` |
| 发布包边界 | 4 通过；不打包私钥/数据库，不覆盖已有目录 | `deploy/scripts/package-release.test.mjs` |

生产 Solidity 编译参数不变：0.8.24、optimizer 200、Shanghai、viaIR=false。生成 19 份合约 ABI/产物，覆盖 71 个源文件。产物内容摘要：

`0x7617c81d718e2127be6b1878abad81d7a3c8bf9c4f8cb35bf85755e42df049d7`

前端逐项验收和浏览器结果见 [前端完整性清单](../../frontend-completeness-2026-09-28.md)；运行环境及实际启用范围见 [统一交接](../../INTEGRATION_HANDOFF.md)。没有使用真实钱包签名、广播主网交易、部署主网合约或发送真实通知。

复跑入口：根目录 `node scripts/check-local.mjs`、`npm run test:fork`、`npm run test:fork:firsto`；`deploy/` 下 `npm run artifacts:check && npm test && npm run build`；`web/` 下 `pnpm contracts:check && pnpm check && pnpm build`。后台私有目录权限测试在 Linux 执行；Windows 不放宽其 POSIX 权限要求。历史 fork 必须使用各脚本明确固定的区块。
