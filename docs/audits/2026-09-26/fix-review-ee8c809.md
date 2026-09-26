# `ee8c809` 追加审计的修复复核

本记录复核 [原审计](review-ee8c809.md) 的五个问题。修复均在 `codex/frontend-contracts` 分支完成；测试交易只在隔离 Anvil 或固定区块 BSC 分叉中执行，没有主网签名、转账或部署。本记录是开发自查与交叉复核，不能代替独立第三方审计。

| 原问题 | 修复与复核结论 |
| --- | --- |
| 同一时间戳卖份额后仍用旧票低价卖整机（高） | `SaleGovernance.propose` 在提案调用时记录当前时间戳的份额和成员数，此后所有份额变更冻结。旧 `timestamp-1` 提案不可再投票、执行或成交；已经 Listed 的旧提案要等到期撤销，再发起新提案。真实 Vault + ShareMarket 回归证明，新买家拥有 74 票，卖出者只剩 1 份，不能用旧 75 票把矿机按 1 wei 卖走。`PoolLens` 在提案当秒读取当前持仓，此后读取历史快照。 |
| 部署交易已挖出而哈希响应丢失（中） | 部署页提供显式交易哈希只读恢复，核对 BSC 链、账户、nonce、原计划字节码/目标、回执、规范链、代码及实际 Gas；不能把未知结果当成失败自动重发。钱包对已知哈希做同 nonce 加速、取消或不同交易替换时，另按最终性核对；相同部署内容才接续，取消、不同内容或链上执行失败会终止旧计划并保存旧记录，不能跳过步骤继续签名。即使实际 Gas 超过原预算，也先入账，再禁止后续签名直至提高预算。 |
| 份额市场取消后锁住及一块收据即清记录（中） | 恢复时比对原交易、加速、取消或替换交易的账户和 nonce。只有交易达到至少两次确认、`finalized` 覆盖该区块、最终 nonce 已消耗且规范链复读一致，才在跨页面锁内清除记录。未知、节点不支持最终性或重组时均继续暂停；页面分别标明原市场成功、回滚、钱包取消和其它替换。 |
| Firsto 报价第二页 `viewId` 被代理拒绝（中） | 代理对白名单内唯一、1–120 字符的快照标识放行，不改变固定上游来源和路径；客户端仍校验跨页快照身份，异常参数继续拒绝。 |
| 停止 keeper 后仍可能发新签名（条件风险） | SIGINT/SIGTERM 令周期停止，并在候选处理、签名前及 RPC 广播边界再检查；已签名交易原文和哈希先持久化，不把停止误当成链上取消，恢复仍需显式操作。 |

## 验证

- [合约完整检查](../../../deploy/evidence/fix-ee8c809/contracts-summary.json)：CI fuzz/invariant 配置下 372/372 测试通过，34 个测试套件；格式、编译、升级布局和 Slither `--fail-medium` 均通过。[体积记录](../../../deploy/evidence/fix-ee8c809/contracts-sizes.log)显示 PoolVault 运行代码 24,250 B，距 EIP-170 上限尚余 326 B。[源码 SHA-256 清单](../../../deploy/evidence/fix-ee8c809/contracts-source-sha256.json)的 81 项已与当前合约树逐一对照。
- [固定区块 BSC 分叉](../../../deploy/evidence/fix-ee8c809/fork-summary.json)：区块 123728000 的 52/52 项本地模拟通过；[分叉源码清单](../../../deploy/evidence/fix-ee8c809/fork-source-sha256.json)的 81 项与当前合约树一致。只读访问公开 RPC，没有主网交易。
- [部署控制台完整回归](../../../deploy/evidence/fix-ee8c809/deploy-tests.log) 130/130（49 项客户端、81 项 keeper/代理），[构建](../../../deploy/evidence/fix-ee8c809/deploy-build.log)通过。隔离 Anvil 测试覆盖已挖出但哈希丢失、同 nonce 普通/动态费加速、取消、不同内容替换、链上执行失败及超预算真实 Gas 入账；市场回归覆盖最终性与重组时保留记录。
- [部署产物来源核对](../../../deploy/evidence/fix-ee8c809/deployment-artifacts-check.log)、[网页 ABI 来源核对](../../../deploy/evidence/fix-ee8c809/web-contracts-check.log)、[产品页检查](../../../deploy/evidence/fix-ee8c809/web-check.log)及[构建](../../../deploy/evidence/fix-ee8c809/web-build.log)通过。当前规范化 ABI/产物摘要为 `0x06e8d37cdccef0f7993c9f29649bb713f126b1572eb4fe16a528848ff77603bc`。

Slither 通过的是 `--fail-medium` 门槛，不是零提示；[原始扫描结果](../../../deploy/evidence/fix-ee8c809/contracts-slither.log)仍列出 66 项低级别/信息级别提示。合约和分叉日志的 `sourceCommit` 早于最后的部署页面及本报告提交，源码 SHA-256 清单与当前合约文件一致，因此上述合约结果绑定的是同一份 Solidity 内容。

## 保留边界

- 当钱包/节点都没有可查的哈希，或同 nonce 替换尚未最终确认时，部署和市场仍暂停，不会自动猜测 nonce、撤销或重复广播。市场恢复需要钱包提供原交易或替换交易哈希，并需要支持 BSC `finalized` 读取的节点。
- 用户确认的单钱包升级权限、无业务销毁、整机出售 1% 费、严格结清后出售、参考产能价加默认 10% 可退预算均保持。单钱包权限集中及外部挖矿协议持续结清失败导致暂时不能交割，仍是已明确接受的设计边界。
- 当前直接在 Firsto 采购矿机和采购服务费分流尚未接入实际交易；参考产能报价不是链上可信预言机。产品 `web/` 仍无主网已验收地址，不应把演示页面当成已上线交易入口。PoolVault 体积余量较小，后续升级要继续检查 EIP-170 上限。

修复后的本地通过只说明上述测试范围内的行为；主网小额测试部署应在代码复核、地址与产物绑定、远端 CI 通过后另外执行。
