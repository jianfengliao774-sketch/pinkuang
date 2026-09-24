# T1e 投票阶段：边界验证与 CI 稳定性优化

本轮继续 [M1e](M1e.md) 的投票阶段，补足状态、重入和随机操作顺序验证，并降低公共 BSC RPC 限流造成的 CI 偶发失败。生产合约、费率、权限及存储布局没有修改；完整出售和换币销毁仍未交付。本轮结果不能代替 T1e 整卡验收。

## 本轮修改

### 历史票权与回调边界

`contracts/test/unit/PoolVoting.t.sol` 增加 6 项，现共 27 项：

- 提案后成员由 26 份增持到 49 份，本轮仍只有 26 票。
- 提案同秒有人退出，当前人数降低不能降低历史人数过半门槛。
- 新提案采用新快照，上一轮的赞成、反对和已投标记不能影响新轮。
- Listed 生命周期拒绝发起提案及正反投票，拒绝后历史提案和票账保持一致。这里使用测试状态 fixture，没有模拟真实整机成交。
- Mining.claim 回调分别尝试重入 propose 和 vote，精确检查 ReentrancyGuard 错误。回调地址事先真实持有历史份额，并验证其顶层调用可以成功，因此不会把“没有投票资格”误当成重入保护生效。

`contracts/test/invariant/PoolVotingInvariant.t.sol` 新增 2 项状态不变量，随机交错直接转让、transferFrom、真实 ShareMarket 锁定及成交、时间推进、提案替换、正反投票和重复投票。每项运行 128 轮、8,192 次 handler 操作，handler 意外回滚必须失败。

测试 oracle 使用独立的六人持仓账及“上一个已结束秒”的余额，不以合约检查点或票数生成预期值。固定种子保证已经走到历史持有人退出、新买家拒绝、重复票拒绝、反对票、恰好到期、新轮快照、零时间推进，以及五人中三人共 59 份的通过结果；避免随机测试只有空操作或始终未达多数。每轮同时核对持仓守恒、人数、历史权重、冷却、提案内容、已投标记和双多数。

### CI 与 RPC

`.github/workflows/contracts.yml` 调整触发条件及队列；`scripts/run-fork.mjs` 固定重试参数并补充验证输入证据。

- main push、所有 pull_request 及手动运行继续触发。功能分支由 PR 验证合并引用，避免同一更新在 push 和 PR 中重复执行链上读取。
- 工作流按 event/ref 隔离取消过时运行，手动选择不跑 fork 不会取消 PR 的完整检查。
- fork 任务使用共享 concurrency group，`queue: max` 保留等待任务、`cancel-in-progress: false` 保留正在执行的 fork。其他合约检查可并行。GitHub 官方上限为 100 个等待任务，超过上限的新任务会取消，不能据此承诺无限队列。[官方语法说明](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idconcurrency)
- 保留单线程、50 compute units/s；明确设置最多 10 次 RPC 重试和 2,000 ms 初始退避。只重试底层可重试的 RPC 错误，耗尽或断言失败仍令本次运行失败；没有包裹整套测试的自动重跑或忽略失败。
- fork 元数据新增 rpcPolicy、CI event/ref 及验证输入 SHA-256。源码和脚本均与 ASCII 编译副本逐字节比对。原有失败和成功日志保留，新日志单独放在 `docs/logs/T1e/optimization/`。

## 本地验证

| 项目 | 结果与证据 |
|---|---|
| 单元及不变量 | [204 passed / 0 failed / 0 skipped](logs/T1e/optimization/contracts/forge-test.log)，含 27 项投票单测和 2 项投票状态不变量 |
| 固定块 fork | [39 passed / 0 failed / 0 skipped](logs/T1e/optimization/fork-clean-cache/forge-test.log)，隔离旧缓存后从真实 RPC 重建；BSC 区块 123728000，既有协议、购机、收益及份额转让回归，没有宣称完成整机出售闭环 |
| RPC 故障注入 | [模拟节点验证](logs/T1e/optimization/rpc-retry/README.md)：短暂 429 恢复 exit 0；持续 429 每个请求最多初次加 10 次重试后 exit 1；不可重试错误每请求一次并 exit 1 |
| 编译、体积 | [通过](logs/T1e/optimization/contracts/forge-build-sizes.log)，PoolVault 仍为 21,483 B |
| 升级存储布局 | [16 项检查](logs/T1e/optimization/contracts/upgrade-checks.json) 达到预期，包括故意不兼容的负例 |
| 库链接与静态检查 | [五库审查](logs/T1e/optimization/contracts/library-link-audit.json)通过；[Slither --fail-medium](logs/T1e/optimization/contracts/slither.log) exit 0，保留原 36 条 Low/Info |
| 远端 CI | 代码提交 `7e988a344150c91c58b3eac39b26dd8e90529a1c` 的 [PR CI #36013421116](https://github.com/jianfengliao774-sketch/pinkuang/actions/runs/36013421116) 两项任务全部通过；[contracts 原始日志](logs/T1e/optimization/github-job-107679670708.log) 和 [fork 原始日志](logs/T1e/optimization/github-job-107680703271.log) 已保存 |

全树本地执行元数据：[summary](logs/T1e/optimization/contracts/summary.json)、[源码哈希](logs/T1e/optimization/contracts/source-sha256.json)、[验证输入哈希](logs/T1e/optimization/contracts/verification-input-sha256.json)。运行时尚未提交，summary 中 sourceCommit 是当时的 HEAD，实际内容以哈希为准。

fork 的最终验收依据是 [干净缓存 summary 与实际 RPC 参数](logs/T1e/optimization/fork-clean-cache/summary.json)、[源码哈希](logs/T1e/optimization/fork-clean-cache/source-sha256.json)、[验证输入哈希](logs/T1e/optimization/fork-clean-cache/verification-input-sha256.json)。它在 2026-09-24 14:31:13 UTC 完成，39 项全部通过，运行时长约 166 秒。

首轮真实 fork 虽报告通过，但与初版模拟节点共用了 BSC 同区块缓存，因此 [首轮日志](logs/T1e/optimization/fork/README.md) 仅保留诊断，不用于验收。旧缓存于 14:27:25 UTC 隔离，保留原文件哈希及副本，见 [隔离记录](logs/T1e/optimization/rpc-retry/cache-quarantine.json)。最终模拟节点采用独立 chainId 13371337，并显式禁用缓存；模拟测试不是链上事实证据。正式重跑日志中的“缓存文件不存在”是隔离后首次读取的预期状态。

远端 workflow 实际接受了队列配置，功能分支此次只产生 PR 运行，完整 204/39 项检查均通过。远端 Foundry action 恢复了其既有 RPC 缓存，因此不把远端运行描述成“完全无缓存”；本地隔离后的真实 RPC 重跑单独提供冷缓存验证证据。

复现本轮完整检查：

```powershell
$env:VALIDATION_EVIDENCE_ROOT = Join-Path (Get-Location) 'docs/logs/T1e/optimization/contracts'
node scripts/check-local.mjs T1e
$env:VALIDATION_TASK = 'T1e'
$env:VALIDATION_EVIDENCE_ROOT = Join-Path (Get-Location) 'docs/logs/T1e/optimization/fork-clean-cache'
$env:BSC_RPC_URL = 'https://bsc-mainnet.public.blastapi.io'
$env:FORK_BLOCK = '123728000'
node scripts/run-fork.mjs
```

独立代码审查覆盖购买余款、卖家债权、市场锁定及部分成交、到期收益、零持仓旧收益、Mining 调用权限和历史票权，没有找到可复现的当前资产欠付、重复领取或越权问题。此结论不等同于第三方审计，也不覆盖尚未实现的出售和销毁流程。

## 业务偏差与待决定项

本轮业务规则偏差：无。CI 执行安排的调整如上，没有降低断言、跳过失败或更改固定区块。

[开工计划第 1.3 节第 1 条](sources/kickoff-plan-v0.4.md) 的渠道选择已于 2026-09-24 收到项目方明确答复：“接受，继续实现（推荐）”。下一步按首期仅本项目 completeSale 成交、不在 tapeout.market 挂单实现；平台 2% 与销毁预算 2% 不变，不产生市场 1%，成员取得剩余约 96%（尾差另列）。本报告仅交付此前的优化，批准不等于出售功能已经实现。
