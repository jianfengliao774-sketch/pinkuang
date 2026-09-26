# BEM 无冷却领取与第三方代领

**历史方案，已被后续指示替代。** 用户最终确认收益先归集到矿机池合约，再由个人自行领取。当前已移除 `claimFor`；取消 24 小时领取限制继续保留。现行规则及验证见[收益归集与本人领取](self-claims.md)。下文只记录 `7fbf15a` 的代领方案与当时验证，不代表当前接口。

用户明确选择“取消24小时限制，任何人可代领”。本变更以 `2279ece` 的审计整改代码为基础，不改变购机、投票、收益费率、单钱包治理或严格交接规则。

## 资金路径

1. `harvest()` 原本就允许任何人触发，将官方 Mining 的收益归集到对应矿机池子。成功收到的新收益扣 1% 平台费，其余 99% 按份额记账，无销毁。
2. `claim()` 将调用者的全部已入账 BEM 转入调用者钱包。
3. 新增 `claimFor(address beneficiary)`，允许任何人支付 Gas，为指定收益钱包发起领取。持份、历史权益和收款地址全部绑定 beneficiary；调用者不能把对方的收益改付给自己，也不能指定只支付一部分。

成功代领后，BEM 已直接到达收益钱包，权益所有人无需再次领取、签名或授权。该入口每次处理一个地址，不是全池批量分发，也不自动触发 Mining 收益归集。只有归集而未领取时，成员 BEM 仍在池子内。

## 无冷却与安全边界

- 取消本人领取和代领共用的 24 小时限制，`claimInterval()` 返回 0。有新的已入账收益即可再次领取，包括同一个区块时间内。
- `lastClaimAt` 继续记录上次成功支付的时间，保留旧存储槽与 ABI，但不再作为领取门槛。保留历史 `ClaimTooSoon` 错误定义不代表仍执行该限制。
- 无可支付收益时回滚，不更新领取时间、不重复分配、不支付手续费。平台费只在新收益入账时收取。
- 禁止零地址受益人；旧持有人即使份额已经为零，或矿机已出售，仍可领取此前累计的权益。
- 领取不依赖外部 Mining 调用。严格结清仍应用于份额交接和矿机出售，不增加紧急出售。
- 两个领取入口均受 Vault 重入锁保护，付款失败时权益和支付时间原子回滚。账本先扣减，BEM 只能支付至权益所有人。
- 移除冷却避免第三方用一次小额代领推迟他人领取后来入账的大额收益。第三方可以改变支付时机，但不能改变收益归属。

本变更不新增或重排存储字段。不得把新增入口与旧部署产物混用，须重新生成产物并通过独立编译校验。

## 验证与交付状态

| 检查 | 本轮证据 |
| --- | --- |
| 全量合约 | [336/336，29 suites](../../../deploy/evidence/claim-for-final-contracts/forge-test.log)，CI fuzz=256、invariant=128×64，零失败、零跳过 |
| 升级与静态检查 | [22 项升级检查达到预期](../../../deploy/evidence/claim-for-final-contracts/upgrade-checks.json)，包含不兼容负例拒绝；[Slither --fail-medium exit 0](../../../deploy/evidence/claim-for-final-contracts/slither.log)，55 条低风险/信息提示保留；[汇总](../../../deploy/evidence/claim-for-final-contracts/summary.json) |
| 新代领回归 | 11 项全部通过，含 256 次 fuzz；覆盖陌生调用者无法截流、本人/不同代领人在同秒新入账后继续领取、空领取、零地址、转账失败与重入、零份旧持有人和未入账收益；纳入全量合约日志 |
| 受影响的收益/转让模型 | [17 个单元测试与 8 条不变量通过](../../../deploy/evidence/claim-for-existing-tests/nonfork.log)，CI invariant=128×64 |
| BSC 收益分叉 | 固定区块 123728000，[6/6 通过](../../../deploy/evidence/claim-for-existing-tests/fork-final.log)，真实 BEM 与 Mining 的无冷却领取验证；只有本地模拟，没有主网广播 |
| 部署产物与恢复 | [ABI/产物 7/7](../../../deploy/evidence/claim-for-artifacts-tests.log)、[本地 Anvil 部署/恢复 7/7](../../../deploy/evidence/claim-for-deployment-tests.log)，[artifacts:check](../../../deploy/evidence/claim-for-artifacts-check.log) 与 [前端 build](../../../deploy/evidence/claim-for-build.log) 均通过 |
| 尺寸 | Vault runtime 24,318 B，EIP-170 余量 258 B；后续增加入口须重新检查，不能假定仍有足够余量 |

新增同秒领取分叉测试曾因局部变量过多触发测试代码的 Stack too deep；将检查拆到私有辅助函数后修复，没有切换 viaIR 或删减断言。首轮失败记录保留在 `claim-for-contracts/` 与 `claim-for-existing-tests/fork.log`。本轮全量检查使用新的 `claim-for-final-contracts/` 目录，不覆盖历史失败证据。

本轮源码由[76 项合约/config 清单](../../../deploy/evidence/claim-for-final-contracts/source-sha256.json)和[25 项验证输入清单](../../../deploy/evidence/claim-for-final-contracts/verification-input-sha256.json)绑定。日志中的 sourceCommit 是运行开始时的旧 HEAD，不能单独当作本轮未提交工作区版本；具体内容以清单为准。部署产物规范化摘要为 `0xaf9e0da0091c4e9228e674652991932c13ac637b7a904ce6daa2a62ad19481bb`，sourceCommit 来源信息不参与该摘要。

本轮仅修改本地代码与部署产物，没有进行主网签名或部署；BEM 领取页面和定时归集服务仍未接入。GitHub 推送此前因 OAuth 缺少 `workflow` 权限被拒绝，未获得补充授权前不声称远端代码已经更新。
