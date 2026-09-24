# 审计修复验证日志

各目录的 summary 和源码/验证输入 SHA-256 明确绑定被测快照，不混用不同轮次结果。

- `contracts`：加入实际部署脚本测试前的 287 项开发阶段检查，20 项升级与 Slither 通过。
- `fork`：首次完整 54 项 fork，之后又补充了空代理拒绝认购的回归断言。
- `contracts-initial-regression-failure`：提交 2732e57 的本地失败保留。288 项通过、1 项失败；空克隆 deposit 已被原有 fundingDeadline=0 检查以 DeadlinePassed 拒绝，新增测试错误地预期 Unauthorized。只保留这次实际执行的 toolchain/fmt/build/test、summary 及两份哈希清单；本次未执行的静态/升级检查残留副本已移除，不能拿前一次通过结果补齐失败运行。
- `github-job-107734316393-initial-failure.log`：同提交的远端失败原始日志，对应 CI 36029485185；fork 任务因 contracts 失败而 skipped，不计为通过。失败进程退出时控制台尾部未完整刷出，另从上传的 artifact 10820718845 下载了 `github-initial-failure-artifact/`，其中完整 forge-test.log 与 summary 明确记录相同的 288/1 断言错误。
- `fork-final`：提交 2732e57 的 54 项 fork，通过；不替代后续最终提交的证据。
- `contracts-final`、`fork-release`：提交 312a605 的最终验收目录。修正断言，并移除位于 DeadlinePassed 校验之后、对此情形不可达的冗余 factory 非零检查；正式的 immutable Factory 初始化/升级绑定与份额误转禁令均保持。
- `github-job-107735613730.log`、`github-job-107736845425.log`：提交 312a605 的远端 CI 36029854878，两任务 success，289 项单元/不变量及 54 项 fork 全部通过。

Fork 总计 54 项：原有 46 项，加 7 项明确人工覆盖真实 Mining 状态字节的测试及 1 项本地冒充合法持有人调用真实 stop 后退出的测试。没有生产 stop 入口；状态覆盖不代表自然发生的撤销交易。原协议代码与 BEM 余额没有被 mock 替换。Foundry 可能使用真实链状态读取缓存，不能把新 VM 当作无缓存联网验证。
