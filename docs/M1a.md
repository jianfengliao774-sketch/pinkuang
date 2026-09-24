# T1a：工厂、份额认购与退款

本卡依据 v0.4、开工计划 T1a，以及项目方已确认的 [M0 协议勘误](M0-report.md) 实现。范围为募集退款与升级骨架，购机、挖矿收益分账、份额二级市场和出售在后续卡实现；当前没有上线或部署。

## 行为

- 每池 100 个零小数份额，每地址最多 49 份。`deposit(uint8)` 的 BNB 必须精确等于份数乘单价；目标金额不能被 100 整除时拒绝创建。49+49+2 可以募满，不留下不可认购碎片。
- `withdrawDeposit()` 销毁当前认购份额，将实际出资记入 `bnbOwed`；`withdrawBnb()` 单独领取。募集或购机超时后，任何人可一次性记账失败退款；逐人 pull，不循环付款。
- 状态覆盖 Funding、Funded、Refunding。暂停仅阻止认购或新建，不冻结撤回、失败退款及领取。
- 份额和有效成员数使用时间戳 `Trace208` 检查点。同秒以最终值覆盖，可查询之前的时间戳。成员清零移出当前列表，重新认购可再次加入；不使用委托票数。
- Factory 是 UUPS，Vault 是 BeaconProxy；自定义状态采用 ERC-7201。实现构造锁定初始化；升级必须经多签提议、至少 48 小时等待，再由任何人执行。Beacon 禁止转移/放弃所有权；时间锁即便排队 `updateDelay(0)`，有效最低延迟仍为 48 小时。
- Factory owner 可替换 operator、设置以后新池的 treasury、暂停创建。operator 替换即时影响现有池；现有池 treasury 和购机参数保持创建快照。

## 文件

| 文件 | 内容 |
|---|---|
| `contracts/src/PoolFactory.sol` | 参数校验、BeaconProxy 创建、PoolCreated/注册表、日常权限与 UUPS 升级授权分离 |
| `contracts/src/PoolVault.sol` | BNB 认购/撤回/退款、整数 ERC20、当前成员、检查点及本期 BNB 资产查询 |
| `contracts/src/PoolTimelock.sol` | 多签 proposer/canceller、开放 executor、无部署人 admin、最低 48 小时 |
| `contracts/src/PoolBeacon.sol` | 固定原始时间锁的 Beacon 升级权限 |
| `contracts/src/interfaces/IPoolVault.sol` | 项目参数、状态、事件、错误、BNB 资产识别及核心方法 |
| `contracts/test/unit/PoolFunding.t.sol` | 29 项认购/退款/回调/检查点单测，包括 256 次金额 fuzz |
| `contracts/test/unit/PoolGovernance.t.sol` | 12 项治理测试，真实 schedule/execute 的 Factory 和两池 Beacon 升级与资产保留 |
| `contracts/test/invariant/PoolFundingInvariant.t.sol` | 份额、成员列表、实际资金、负债、历史付款的两个状态不变量 |
| `contracts/test/utils/FundingTestBase.sol` | 使用真实 Factory/Vault/Timelock/Beacon 的测试部署 |
| `contracts/test/utils/InvalidVaultLayout.sol` | 故意重排 ERC-7201 字段的负例，不得用于部署 |
| `scripts/validate-upgrades.mjs` | 明确指定初始实现、两个带 reference 的兼容升级、一个必须因布局被拒绝的负例 |
| `scripts/prepare-upgrade-build-info.mjs` | 修复 Windows 编译输入别名缺失，逐项验证 metadata Keccak，不改原始输入/输出 |
| `scripts/check-local.mjs`、CI | 保存任务原始日志，中文路径使用逐文件核对的 ASCII 副本；CI 在 Slither 重编译前验证完整布局 |

## 验证与原始输出

```powershell
node scripts/check-local.mjs T1a
```

对应执行 `forge fmt --check`、`forge build --sizes`、`forge test --no-match-path test/fork/** -vv`、OZ upgrades-core 1.46.0 的结构化升级校验、`slither . --filter-paths '../node_modules/|test/|script/' --fail-medium`。

本地单元与不变量结果 **43 passed / 0 failed / 0 skipped**。两个状态不变量各执行 **128 runs × 64 depth = 8192 次调用，0 revert**；包括独立累计出资、实际付款和强制转入 BNB 的计数，不能用合约同一个公式自我证明。

关键守恒：Funding/Funded 时募集額 = 总份数 × 单价 = 当前出资合计；余额至少覆盖募集额与 bnbOwed。Refunding 时出资转为 bnbOwed，历史 totalRaised 不再重复计入负债。每户累计领取加待领不得超过实际累计投入；所有份额合计等于 totalSupply，成员列表无重复且与非零持仓一致。

100 人最坏失败退款记账实测 **2,358,901 gas**，测试上限 8,000,000；循环只写负债，任何成员拒收都不阻碍其他成员退款。提款拒收时整笔回滚恢复待领余额；回调重入不能多领。

升级验证包括初始 Factory/Vault 安全检查、真实 V2 布局兼容与跨时间锁升级后的份额/负债/BNB 保持。负例自身安全检查通过、存储布局检查失败，且断言失败原因必须来自布局；没有开启 unsafeSkipStorageCheck。两个仅增加 version() 的 V2 fixture 对 missing-initializer 作精确注释，使用继承的原 initializer，不需要或允许二次初始化业务状态。

Windows Foundry 的 build-info 输出包含 43 个输入未列出的相同源文件别名。准备器只从已有 input 内容中按输出 metadata 的 Keccak 匹配补齐，原始 build-info 保留，output 整体 SHA-256 不变。Linux 无缺失时逐字节复制，不修改 ABI、AST、字节码或布局。五项结构化结果与审计均保存。

完整证据：[测试输出](logs/T1a/forge-test.log)、[build --sizes](logs/T1a/forge-build-sizes.log)、[Slither](logs/T1a/slither.log)、[升级输出](logs/T1a/upgrade-validation.log)、[结构化布局结果](logs/T1a/upgrade-checks.json)、[输入别名校验审计](logs/T1a/upgrade-build-info-audit.json)、[源码 SHA-256](logs/T1a/source-sha256.json)、[命令与退出码](logs/T1a/summary.json)。

Slither 的两处 incorrect-equality 为 Checkpoints 返回份额值被时间戳参数保守污染后的误报：0 表示无有效份额，严格判断属于成员定义，不是对可操纵 BNB 余额或随机时间做等值判断。已逐行写明原因并仅抑制该检测器；成员增减、同秒覆盖及守恒由真实单测/状态不变量覆盖。其余时间戳期限、ERC-7201 assembly、检查结果的低级 BNB call 和 CLOCK_MODE 命名提示保留在日志，不声称没有提示。

运行时体积：PoolFactory 8004 B、PoolVault 11038 B、PoolTimelock 6608 B、PoolBeacon 515 B，均小于 EIP-170 的 24576 B；最终数值以完整 build 输出为准。这不是未来全部 M1 功能的体积承诺。

## 实现选择与边界

- 将 withdrawDeposit 的撤回记入 pull 余额，是落实 v0.4 第 9.2 节的 BNB pull 要求；没有循环调用出资人。
- v0.4 仅把 withdrawDeposit 限定为 Funding，故截止后、finalizeFailure 前仍可全额撤回；截止后新认购始终拒绝。恰好截止可 finalize。相关边界有专门测试。
- Refunding 保留冻结的历史份额和 totalRaised，清 contributedWei，标记退款已记账；规范没有要求失败时销毁历史份额，不额外引入该规则。
- 原生 BNB 资产标识为 address(0)，18 位，`assetOwed(asset,user)` 仅接受 BNB；未开放 USDT/BEM 认购。误转 ERC20 不增加份额；不增设 rescue/sweep。
- 目标为正、价格上限合理、截止有先后、直卖对手方与价格成对设置，是创建参数有效性检查；72 小时购机窗口只是建议，没有硬编码强制。
- 当前所有普通份额 transfer/transferFrom 均拒绝；后续 T1d 必须先完成 harvest/debt/锁定份额约束才允许 Active 转让。未实现的 Active/Listed/Closed 路径不假装可用。
- 采用 OZ Timelock/Beacon 的小型子类，是为防止降低延迟或迁移 Beacon owner 绕过第 9 节。部署多签实际为 2/3 仍须部署验收，本卡用本地测试地址模拟签名主体，不声称已创建多签。

没有改变业务分账费率、投票规则或权限比例。后续卡按已授权 M1 顺序继续；本卡不代表购机、收益、市场、网站或主网部署完成。
