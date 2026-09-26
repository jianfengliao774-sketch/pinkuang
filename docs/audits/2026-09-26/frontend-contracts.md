# PR #9 页面与合约一致性优化

用户确认整机出售平台费统一 1%，筹资继续使用参考产能价加默认 10% 预留，并再次明确取消销毁。本轮在本地 `codex/frontend-contracts` 上合入 PR #9 的 `813500db30544e871496aa38412f9f5ebf2b32e1`，基于此前本人领取版本 `915dad3` 实施；合入点 `5fb7f1dd4819e2dcd56e456f5cb9c527dac64c9d`。尚未合并 GitHub PR 或部署主网。

这是开发自查和代理交叉复核记录，不代替用户计划的外部审计。

## 实施结果

1. **费用与销毁。** `saleFeeBps` 改为 100，实际结算和事件均用 `gross / 100`，成员取得全部余额和除法尾差。此前 2% 是旧版合约规则，与 PR #9 页面 1% 不一致，本轮按用户选择修改实际收款逻辑。旧版已记账的 2% 历史售款不被改写。挖矿收益费、份额交易费保持 1%。`burnBps/saleBurnBps` 为零，`executeBurn/burnExpired` 固定拒绝，未领收益不作废，未花掉的历史销毁预算按旧权益释放；没有新增换币、回购或销毁路径。退款中的份额凭证 `_burn` 仅核销已退还认购款的份额，不销毁 BEM 或 BNB。
2. **查询与资产隔离。** 新增固定 Factory 的无权限只读 `PoolLens`，每批最多 20 池；对注册、正反向 Factory 绑定、返回长度、bool/窄整数、子调用 Gas 限制及派生依赖检查。错误字段带 mask，前端显示未知，不当成零。旧持有人即使份额清零，也能查自己的历史收益和 BNB 债权。查询不触发归集、领取或资金转移。
3. **报价变动时原子回滚。** `createFlexiblePoolChecked` 在原有 operator、暂停和采购质量规则下增加 taskId/参考权重精确比对。报价后权重或型号变化，整次创建、注册和事件回滚，不能悄悄用另一模型建池。10% 只增加可退款预留，不提高原矿机或替代矿机的采购 cap。
4. **部署兼容。** Factory 只在命名空间末尾追加 Lens 地址；新初始化自动创建，旧初始化可幂等补建。保留 13 次部署签名，Atomic/客户端最终验收核对 Lens 归属及实际运行代码。Vault 未增加业务字段，运行体积为 24,151 B，距 24,576 B 上限 425 B；Factory 21,180 B，Lens 8,929 B。
5. **页面与接口。** 修正当前中英文演示的旧到期/冷却/销毁说法、募资价格、折价表决、可售份额、提案冻结和退款展示。加入精确整数 adapter，按同一区块读取并检查重组/换链，地址去重，BEM 自领仍为本人逐池直调，拒绝已关闭池的 `harvest` 准备。源码独立重编、部署 JSON、网页 ABI 三者在 CI 与正式构建时强制一致。

具体字段、有效位、页面动作和上线接入边界见[对接说明](../../frontend-contracts.md)。

## 验证结果

以下为最终冻结源码的本地结果，未冒称远端 CI。单位/invariant 使用 CI profile（fuzz 256，invariant 128×64）。

| 检查 | 最终结果与原始证据 |
| --- | --- |
| 全量合约 | [364/364，31 suites](../../../deploy/evidence/frontend-final2-contracts/forge-test.log)，零失败、零跳过 |
| 格式、编译、体积 | [完整检查状态 passed](../../../deploy/evidence/frontend-final2-contracts/summary.json)，Solidity 0.8.24、optimizer 200、Shanghai、非 viaIR |
| 升级兼容 | [22 项达到预期](../../../deploy/evidence/frontend-final2-contracts/upgrade-checks.json)，包括不兼容布局负例拒绝；Factory 仅末尾追加 Lens |
| 静态扫描 | [Slither --fail-medium exit 0](../../../deploy/evidence/frontend-final2-contracts/slither.log)；42 条 Low、24 条 Informational 保留；不是零提示报告 |
| BSC 固定区块 | 区块 123728000，[52/52，11 suites](../../../deploy/evidence/frontend-final2-fork/forge-test.log)，零失败、零跳过；只读真实状态上的本地交易模拟 |
| 产物与实际部署流程 | [产物 7/7](../../../deploy/evidence/factory-lens-final2-artifacts-test.log)、[本地 Anvil 部署 7/7](../../../deploy/evidence/factory-lens-final2-deployment-test.log)；13 次交易、恢复不重发、Lens 代码篡改拒绝；[源码产物核对](../../../deploy/evidence/factory-lens-final2-artifacts-check.log)、[部署页构建](../../../deploy/evidence/factory-lens-final2-build.log)通过 |
| 控制台其余回归 | [市场/报价 25 项及 keeper/nonce 恢复/工具链/代理 64 项](../../../deploy/evidence/frontend-final2-console-tests.log)通过；与上一行合计覆盖 `deploy` 的 103 项测试 |
| 产品页面 | [catalog/价格及 8 项精确 adapter 测试](../../../deploy/evidence/frontend-final2-web-check.log)通过；[带强制 ABI 来源核对的 7 页静态构建](../../../deploy/evidence/frontend-final2-web-build.log)通过 |

合约和 fork 两份目录中的 79 项源码/config、25 项验证输入清单均已逐一核对最终文件一致。网页功能源码/配置 58 项另存 [SHA-256 清单](../../../deploy/evidence/frontend-final2-web-source-sha256.json)。16 个部署产物的规范化摘要与网页 ABI 摘要同为 `0xe27f45c13921ae5c616573e38d46cfbba63d4831824a94dd60859c0013d7479b`。日志 sourceCommit 是运行前合入点，工作区代码由上述源码清单绑定，不能只凭日志中的 Git 提交号判断测试对象。

实现与完整证据已提交本地 `730616cba1fb148ce09c0a604ee4cf95ddca154c`；随后重新生成产物只更新 `sourceCommit` 到该提交，[结构化对照](../../../deploy/evidence/frontend-provenance-check.json)确认 ABI、字节码、源码哈希和规范化摘要全部未变。

专项包含 1/99/100/101/199/200 等微额手续费边界、256 次整机费率/尾差 fuzz、保持旧 2% 账目迁移、关闭所有销毁入口、零份旧持有人、错误 ABI/64 KiB 超大返回/非法 bool、只读防写、单 getter 耗尽 Gas 后后续池继续读取，以及折价 60 份和人数门槛的真实 Vault 对照。20 个独立冷状态 Funding 池的 Lens 本地执行消耗约 224 万 gas，仅作分页估算，不外推为所有 BSC/RPC 的保证。

中间失败原样保留：

- 初次整合运行时 Lens 源码/测试仍在补全，构建信息出现多份同名合约，升级校验拒绝；[原始失败](../../../deploy/evidence/frontend-contracts/upgrade-validation.log)及当时源码清单保留。冻结后重新强制构建，364 项测试及 22 项升级检查通过。
- 该次 Slither 将 Lens 内 11 个离散状态/ABI/有效位的严格相等比较报告为 `incorrect-equality`；[原始报告](../../../deploy/evidence/frontend-final-contracts/slither.log)保留。对照[规则说明](https://github.com/crytic/slither/wiki/Detector-Documentation#dangerous-strict-equalities)及检测器源码，核实为宽泛的 SSA 污点传播；逐条附审计理由和局部标注，没有降低 CI 阈值或全文件屏蔽。[编译前后对照](../../../deploy/evidence/frontend-lens-comment-only.json)证明 Lens 去除编译 metadata 后的 8,876 B 运行代码完全一致；完整产物仍重新生成并重测。
- 独立复核发现 adapter 曾允许为 Closed 池准备 `harvest`，已修正为仅 Active/Listed；对应测试覆盖其他状态与未知状态拒绝，Closed 个人 `claim` 仍允许。去重后同一池不会重复统计或生成两笔领取。

## 保留的边界

- `web/` 仍是明确的设计演示。新 adapter/ABI 可供真实接入，但没有部署地址、真实钱包交易或历史索引；不能宣称页面已经能操作主网资金。既有 `deploy/` 控制台有部署与份额市场的实际调用逻辑，本轮仅本地模拟。
- Lens 资格是区块快照，不能保证之后的交易成功。提案发起冷却仍需补读 `lastProposed`、`activeProposalId/getProposal` 和 `activatedAt`；不能用个人首次持份时间替代池激活时间。新页面签名前必须刷新、模拟及估 Gas。Factory 地址须来自已验收部署配置，不能从任意演示卡片获得。
- 按用户要求保留单钱包管理和严格外部结清，无紧急退出。单钱包升级权限及外部协议故障导致暂时无法交割的边界仍存在；测试通过不构成资产绝对安全保证。本人取回已入账 BEM 不依赖 Mining 成功。
- Firsto 直接采购及采购服务费分流尚未接链；本次不增加采购收费。全局历史排序、记录、二级买入成本和实际历史收益率需要事件索引，不通过示例值伪造。
- 当前 GitHub OAuth 缺少 `workflow` 权限，之前推送被 GitHub 拒绝。没有换凭据或绕过；本轮代码、报告、验证原始记录先保存在本地仓库，不把本地通过写成远端 CI 通过。真实密钥、资金、服务器与生产网站未操作。
