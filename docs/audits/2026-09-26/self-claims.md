# 收益先入池、权益所有人自行领取

用户最终确认：“然后领取到合约地址。在由个人自己领取”。本变更基于 `69e56af`，移除上一轮的 `claimFor(address)`，保留已确认的取消 24 小时限制。不改变购机、投票、份额市场、费率、单钱包治理或严格交接规则。

## 现行资金路径

1. **归集到池子。** 任何人都可以调用该矿机池的 `harvest()`，把官方 Mining 收益归集到池子合约。新到账收益扣除 1% 平台费，剩余 99% 留在池子里，按份额计入各人的收益权益。归集发起者支付 Gas，不因此获得其他人的收益。
2. **本人领取到钱包。** 权益所有人连接自己的钱包，调用 `claim()`。合约按 `msg.sender` 结算并将该钱包全部已入账可领 BEM 转给同一个 `msg.sender`，没有可指定他人或收款地址的参数。个人承担该次领取 Gas，领取时不重复扣平台费。

没有固定领取时间、没有 24 小时冷却，也不自动向所有成员分发。已经入账即可自行领取，暂不领取的权益永久保留。成员领取只处理已入账收益，不触发 Mining 归集；任何人发起的归集也不会替成员执行个人领取。未部署的旧 `claimFor` 入口从接口和实现中删除，旧选择器调用须拒绝。

## 安全与兼容性

- 个人账本、持份查询和收款人均绑定调用者；陌生人无法选择他人的权益提款。
- 份额转让前仍严格结清并记下双方旧权益。份额已清零的旧持有人仍可凭自己的钱包领取历史 BEM；不得因当前持份为零而剥夺已入账债权。
- `claim()` 不调用 Mining 或查询矿机所有权，外部 Mining 故障与矿机已出售不妨碍已入账收益领取。BEM 自身转账失败时整笔领取回滚。
- 重入锁和先扣账后付款保留。无余额领取失败，不修改最近成功领取时间。`lastClaimAt` 只作记录，`claimInterval()` 为 0。
- 不增加或重排存储字段。除移除入口与重新编译产物外，收益记账库的无冷却实现保持不变。历史方案、测试日志和提交保留，防止把不同版本的测试数量混为一谈。

## 验证和交付

| 检查 | 本轮结果 |
| --- | --- |
| 全量合约 | [332/332，29 suites](../../../deploy/evidence/self-claim-contracts/forge-test.log)，CI fuzz=256、invariant=128×64，零失败、零跳过；含 7 项归集/本人领取专项 |
| 升级兼容 | [22 项检查达到预期](../../../deploy/evidence/self-claim-contracts/upgrade-checks.json)，包含不兼容布局负例被拒绝 |
| Slither | [--fail-medium exit 0](../../../deploy/evidence/self-claim-contracts/slither.log)，55 条低风险/信息提示保留 |
| BSC 固定区块 | 区块 123728000，[52/52，11 suites](../../../deploy/evidence/self-claim-fork/forge-test.log)，零失败、零跳过；只读主网状态用于本地模拟 |
| 产物与部署 | [ABI/产物 7/7](../../../deploy/evidence/self-claim-artifacts-tests.log)、[Anvil 部署与恢复 7/7](../../../deploy/evidence/self-claim-deployment-tests.log)，[artifacts:check](../../../deploy/evidence/self-claim-artifacts-check.log) 和[前端 build](../../../deploy/evidence/self-claim-build.log) 通过 |
| 体积 | Vault runtime 24,171 B，距离 EIP-170 上限 405 B；后续升级仍须重新检查 |

专项验证归集不向成员钱包付款、陌生人不能提取他人权益、旧 `claimFor` 选择器拒绝且账本不变、同秒新增入账后本人继续领取、空领与转账失败不损失权益、交叉重入拒绝，以及清零份额后原持有人仍能自行领旧收益。

本轮合约与分叉目录中的 [76 项源码/config](../../../deploy/evidence/self-claim-contracts/source-sha256.json)和 [25 项验证输入](../../../deploy/evidence/self-claim-contracts/verification-input-sha256.json)已与最终文件逐一比对一致。日志 sourceCommit 是运行前的 HEAD，工作区内容以清单绑定；部署产物更新来源提交时只调整 sourceCommit，规范化摘要保持 `0xa23f666f3cdd9d953c73a89182e24d7fc30545f024a2308f43bc44b238b6ef26`。

没有使用真实私钥、没有主网部署。BEM 归集与本人领取的页面及定时归集服务仍未接入。当前 GitHub 授权缺少 `workflow` scope，推送曾被拒绝；未取得补充授权，不声称本轮已同步远端。
