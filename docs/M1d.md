# T1d：整数份额转让与 ShareMarket

本卡按开发文档 v0.4 第 9、13.1 节和开工计划 T1d，实现 PoolVault 份额转让、卖家名下锁定、站内部分成交及 BNB 提款。收益沿用 [T1c](M1c.md) 的记账与到期规则；购机余款沿用 [T1b](M1b.md) 的原持有人归属。没有部署主网合约或广播主网交易。

**验证状态：本地全树 175 项单元/不变量和 39 项固定块 fork 全部通过；格式、编译体积、13 项升级检查、三库链接审计和 Slither 均通过。限速脚本修正后，push 和 PR 两套远端 CI 均已完整通过。** 完整日志与实际输入哈希见下表。

| 验证项目 | 结果 |
|---|---|
| 实现提交 SHA | `5551c7710afb0c978e80cc9ab9a8dda8e768ea2a` |
| 本地全树单元及不变量 | [175 passed / 0 failed / 0 skipped](logs/T1d/contracts/forge-test.log) |
| 本地固定块全树 fork | [39 passed / 0 failed / 0 skipped](logs/T1d/fork/forge-test.log) |
| 格式、编译及体积 | [格式](logs/T1d/contracts/forge-fmt.log)、[编译和体积](logs/T1d/contracts/forge-build-sizes.log) 均 exit 0 |
| 升级布局及三库链接检查 | [13 项升级检查](logs/T1d/contracts/upgrade-checks.json) 预期均成立；[三库审计](logs/T1d/contracts/library-link-audit.json) ok=true |
| Slither | [--fail-medium exit 0](logs/T1d/contracts/slither.log)，保留 32 条 Low/Info 提示，处置说明见文末 |
| push CI | [#35987549177](https://github.com/jianfengliao774-sketch/pinkuang/actions/runs/35987549177)：全部 success；[contracts 日志](logs/T1d/github-job-107593658602.log)、[39 项 fork 日志](logs/T1d/github-job-107594389131.log) |
| PR CI | [#35987554953](https://github.com/jianfengliao774-sketch/pinkuang/actions/runs/35987554953)：全部 success |

## 份额与历史权益

- 份额仍为 `decimals = 0` 的 ERC-20，募满后供应固定 100。普通 `transfer`、`transferFrom` 仅在 Active 且 Factory 已登记市场后开放，数量必须为 1–49 个整数份额；双方最终有效持仓只能为 0 或 1–49。零数量被拒绝，正常 ERC-20 allowance 规则保留。
- 每次实际转让先严格收取截至该时点的矿机收益，再按旧份额结算双方 BEM，固化双方购机时应得的 BNB 余款，最后变更份额及检查点。任何步骤失败，Mining 领取、平台/销毁付款、份额、allowance、锁定及市场信用一起回滚。
- 曾经持有份额、现在余额为零的地址仍可领取其已归属收益。历史 BEM、同批分数和购机余款不会随份额转走；不同批次不拼接分数，不重启七日到期。到期关闭时继续累计该地址的全局分数。
- 时间戳检查点记录实际持有人的余额及有效成员数。余额从零变正才增加成员、归零才删除成员；同一秒重复变化记录该秒最终结果，当前/未来时间查询仍拒绝。没有 delegate 投票接口，市场地址不能成为持有人或人数成员。
- Listed、Closed 等非 Active 状态冻结普通份额转让和市场成交。测试通过仅限测试编译的生命周期 fixture 验证这些分支，不表示 T1e 的提案、整机挂牌和出售流程已经完成。

开工计划 3.4 的转让伪码写作 `_harvest(false)`，与 v0.4 第 13.1 节“份额变化前先收取并记账截至该时点的矿机收益”存在冲突：若普通 claim 失败后继续转让，尚未收取的旧收益可能落到新份额持有人。本卡遵循开工计划自身规定的文档优先级，在转让路径使用 `_harvest(true)`，要求 Mining.claim 成功、对应矿机 pending 清零、到账差额符合已知 pending 下限，且 NFT 产权和矿机身份未改变。普通独立 harvest 仍按 T1c 允许报告失败后处理已经真实到账的 BEM；没有改变其既有容错规则。

## 锁定及站内成交

挂牌采用开工计划明确的锁定方案：`lockedShares[seller]` 始终包含在卖家真实 `balanceOf` 中，`availableShares = balanceOf - lockedShares`。不会把代币转到 ShareMarket，也不需要卖家向市场 approve。锁定部分继续给卖家产生收益、计入人数及 49 份持仓上限。

PoolVault 的 `lock`、`unlock`、`transferLocked` 仅允许 Factory 登记的市场调用。成交先释放恰好本次数量的锁，再经过与普通转让相同的余额变更流程；没有可被其他调用继承的全局绕过开关。普通转账及 transferFrom 不能搬走锁定份额。撤单只解锁该单未成交部分，不移动份额、不改变历史收益或成员检查点；项目进入 Listed/Closed 后仍可撤单。

| ShareMarket 入口 | 行为 |
|---|---|
| `list(pool, amount, pricePerUnit)` | 仅 Factory 登记的真实 Active 项目；锁定卖家整数份额，记录每个完整份额的 BNB wei 单价 |
| `fill(orderId, amount)` | 支持部分成交，要求数量不超过剩余量且 `msg.value == amount * pricePerUnit`；成交后买卖双方仍符合持仓限制 |
| `cancel(orderId)` | 仅卖家，作废剩余订单并解锁，不能重复取消或成交已关闭订单 |
| `withdrawBnb()` | 卖家或平台提取自身市场信用；先清账再发送 BNB，拒收或重入失败不造成重复付款 |

每次 fill 的 `gross = amount * pricePerUnit`，平台费为 `floor(gross / 100)`，卖家信用为 `gross - fee`。费率固定 1%，从卖家收入扣，费率除法尾数留给卖家；每次部分成交分别向下取整，不重算整张订单的累计费率。平台收款地址取自该 PoolVault 的 treasury 快照，Factory 后续更改 treasury 不改旧池订单收款人。

例如 20 份、每份 0.1 BNB，先成交 7 份再成交 13 份：两笔 gross 为 0.7/1.3 BNB，平台分别取得 0.007/0.013 BNB 的信用，卖家累计取得 1.98 BNB，未提款负债合计 2 BNB。若每份 99 wei，先成交 1 份再成交 2 份，平台费分别为 0/1 wei，卖家累计 296 wei。

成交不会立即向卖家或平台发 BNB，二者均记入 ShareMarket 自身的 `bnbOwed`，与 PoolVault 的退款、购机余款账本分开。卖家与 treasury 是同一地址时，两部分信用相加，不能互相覆盖。

文档未设置最低单价，实现允许零价订单，成交付款和手续费均为零。实现也不额外禁止自成交：正数自转不增加实际持仓，自成交仍按本次 gross 计费并释放相应锁定数量。没有添加最低成交额、最低手续费或买卖双方必须不同的新规则。

## 权限、布局与库链接

Factory 新增 `registerShareMarket(address)`，只允许既有 Timelock 调用，且只登记一次。登记检查目标有代码，并核验市场的 factory、timelock 身份；owner 和 operator 不能直接登记或即时替换。登记通过真实 48 小时排队执行。后续修改市场实现通过同一 UUPS 代理的时间锁升级完成，不提供更换已登记地址的日常入口，避免把已有锁留给失效市场。

ShareMarket 的初始化锁定 implementation，只接受对应 Factory 的至少 48 小时 Timelock；UUPS 升级权限固定给该 Timelock。其没有 owner/operator 日常提款或改费入口。金额、数量或外部协议结算失败时交易原子回滚；可能外部调用的状态入口使用 nonReentrant，BNB 使用检查返回值的 call 提款。

Factory 在原 `erc7201:tapeout.storage.PoolFactory` 命名空间末尾追加 `shareMarket`；Vault 在原 `erc7201:tapeout.storage.PoolVault` 末尾追加 `lockedShares`。原字段顺序保持，T1c 的独立 PoolRewards 命名空间沿用。已冻结本卡 [Factory](storage/T1d-PoolFactory.json)、[Vault](storage/T1d-PoolVault.json)、[ShareMarket](storage/T1d-ShareMarket.json) 的真实 OpenZeppelin 抽取布局：8/25/6 个业务字段；compiler-input 源码字节逐一与上述实现提交的 Git blob 核对相同。新 ShareMarket 使用 `erc7201:tapeout.storage.ShareMarket`，业务字段为 factory、timelock、nextOrderId、orders、bnbOwed、totalBnbOwed，并保留 OpenZeppelin 继承命名空间。

为控制体积，成员集合及历史检查点逻辑抽入第三个 Solidity external library `ShareCheckpoints`，通过显式 storage 引用操作 Vault 已有集合和检查点，不引入另一份成员账本。当前 Vault 编译模板应仅链接 `MiningOperations`、`RewardAccounting`、`ShareCheckpoints` 三库，仍由 Vault 入口承担权限及重入锁。链接与升级检查脚本已按三库及已交付 T1a/T1b/T1c 布局基线更新；13 项检查包括三份初始实现、T1a/T1b/T1c 各两份真实基线、三份兼容升级 fixture 及一份必须拒绝的布局负例，均达到预期；ShareMarket 六个业务字段及继承命名空间均实际抽取，未用空布局代替验证。

库链接沿用限定的 `external-library-linking` 例外，没有跳过存储布局检查。编译模板、源码哈希及受限 AST 检查不等于已部署地址/codehash 验证；正式部署仍须核对实际链接地址和链上代码。

| 最终运行时代码 | 体积 |
|---|---|
| PoolVault | 21,934 B；距 24,576 B 限额余 2,642 B |
| PoolFactory / ShareMarket | 9,020 B / 6,259 B |
| MiningOperations / RewardAccounting / ShareCheckpoints | 5,911 B / 5,565 B / 1,466 B |

## 文件与验证范围

| 文件 | 本卡内容 |
|---|---|
| `contracts/src/PoolVault.sol`、`interfaces/IPoolVault.sol` | 转让严格收矿及历史权益结算、受限锁定入口、持仓和市场地址限制 |
| `contracts/src/PoolFactory.sol` | 时间锁一次性市场登记，追加登记状态 |
| `contracts/src/ShareMarket.sol`、`interfaces/IShareMarket.sol` | UUPS 市场、整数部分成交、1% 费用、取消及 BNB pull 信用 |
| `contracts/src/libraries/ShareCheckpoints.sol` | 已有成员集合及历史检查点的库实现 |
| `contracts/test/unit/PoolTransfers.t.sol` | 16 项转让、历史收益、余款、allowance、锁定、持仓和重入测试 |
| `contracts/test/unit/ShareMarket.t.sol` | 22 项订单、部分成交、费用、付款、权限、治理及失败回滚测试，全部通过 |
| `contracts/test/invariant/PoolTransfersInvariant.t.sol` | 到期开/关各两项，六地址动态持仓及原始收入 ghost 账本 |
| `contracts/test/invariant/ShareMarketInvariant.t.sol` | 双池、七地址、最多 32 单的真实市场订单/锁定与 BNB 独立账本，失败成交整体回滚 |
| `contracts/test/utils/ShareTransferTestBase.sol` | 真实 Timelock 注册、Factory 创建及购机 fixture；测试专用 Listed 生命周期入口 |
| `contracts/test/fork/PoolShareTransferFork.t.sol` | 2 项固定 BSC fork 转让/份额成交验证，全部通过 |
| `scripts/audit-linked-libraries.mjs`、`validate-upgrades.mjs` | 三库链接及命名空间兼容检查 |
| `scripts/check-local.mjs`、`run-fork.mjs`、`.github/workflows/contracts.yml` | 本卡检查入口、证据目录及 CI |

本地全树包含 131 项已有回归、16 项份额单测、22 项市场单测和 6 项新增不变量，共 175 项。份额单测含两组各 256 次 fuzz；四项动态持仓不变量和两项市场不变量均各 128 runs、8192 calls、0 revert。ghost 保存全部历史批次，以“本次成员净收入 × 当时旧持仓”的原始百分之一最小单位累计各地址归属；不借用生产 acc、debt 或 8 格缓存计算预期值。随机序列包含 BEM 直转、待领取收入、harvest、时间推进、普通/授权转账、锁定/解锁/锁定转移、claim 和到期销毁。核对实际 BEM 余额、各批已付/已烧、未过期/过期应付及尾差，以及供应、锁定、成员集合、49 份上限和原始 BNB 余款。

动态收益不变量中的锁定原语以测试环境 impersonate 已登记市场调用，检验的是 Vault 权限边界内的任意合法锁序列。另两项 ShareMarket 不变量全部调用真实市场的 list/fill/cancel/withdraw：在两个真实 Factory 创建并购机的测试池、七个地址和最多 32 单上，独立跟踪每单原始数量、成交/取消/剩余数量、各地址份额、成交款、信用和已提现金额。每个卖家各池的剩余订单之和必须等于 lockedShares，全部信用之和等于 totalBnbOwed，市场 BNB 覆盖负债；错误付款及在信用更新之后的 Mining 失败必须把两池和市场状态一起回滚。初始化已包含多卖家订单、部分成交、提现及两种失败路径，避免空模型通过。市场升级另有单测验证。单位测试会替换已知协议地址的代码以注入故障，不能作为真实 Mining 协议兼容证据。

本卡 fork 固定 BSC 区块 `123728000`、哈希 `0x18c5cda4bb465d1a9aae3d4fe66150cffbe187e2488b856a93f4376080e26306`：部署生产 Factory/Vault/Market，经真实时间锁登记后，以 49/49/2 份购入 TapeOut #16210，再验证严格领取先于份额移动及实际份额成交。普通转让先实际领取 39,272 个 BEM 最小单位、分账后成员净额 37,310，再变更 10 份；新地址不继承此笔收益，后续一小时只取得其 10 份对应的 3,731 单位。市场成交 7 份 × 0.003 BNB = 0.021 BNB，平台信用 0.00021 BNB，卖家信用 0.02079 BNB。事件次序断言为 Mining 到账、Harvested、份额 Transfer；旧购机余款仍归原成员、市场份额余额为零。允许的测试辅助为本地 BNB 资金、角色 impersonation 与时间推进；不替换协议/NFT/BEM 代码或存储。全树 [39 项 fork 原始输出](logs/T1d/fork/forge-test.log) 已通过，包含这两项新测试及 37 项既有回归。

建议复现入口：

```powershell
node scripts/check-local.mjs T1d
$env:VALIDATION_TASK='T1d'
$env:BSC_RPC_URL='https://bsc-mainnet.public.blastapi.io'
$env:FORK_BLOCK='123728000'
npm run test:fork
```

最终证据目录为 `docs/logs/T1d/contracts/`、`docs/logs/T1d/fork/`，应保留原始失败与最终运行输出。sourceCommit 是运行时 HEAD；若工作区未提交，被测内容由 source/input SHA-256 确定，不能单凭 HEAD 声称最终源码已通过。远端结果须对应实际提交、run 链接及下载日志。

首轮 Slither 对 `ShareCheckpoints.sync` 直接返回 `checkpoint.push(...)` 报出 medium `unused-return`。实现已改为显式接收并返回具名的旧/新计数，没有新增此项抑制。原始发现与失败汇总保留在 `logs/T1d/contracts/slither-initial-findings.log`、`summary-initial.json`；修改后完整复验已通过，保留的 32 条提示涉及低级调用、时间戳、事件顺序、存储汇编、复杂度及接口继承建议等 Low/Info；没有新增抑制，也不声称已完成第三方安全审计。

本卡未改变 100 份、49 份上限、1/4/95 收益比例、24 小时领取间隔或七日批次规则。T1e 整机投票与出售、前端订单页面、keeper 和主网部署仍不在本卡完成声明内。

本卡无需新增业务决策。后续 T1e 的受控出售渠道及不在 tapeout.market 展示挂单的取舍，按开工计划第 1.3 节另请项目方确认，不影响本卡交付。

远端 push 首次 fork 在 V3 池存储读取时遇到公共 RPC `HTTP 429 / Rate limit reached`，36 项通过、3 项 TokenSwapProbe 未能取齐状态；[原始失败日志](logs/T1d/github-job-107592013497-initial-failure.log) 已保留。同一实现提交的 PR fork 39 项全部通过。[重跑日志](logs/T1d/github-job-107592667418-retry-failure.log) 再次在另一处 Router 存储读取遇到 429，同样为 36 通过、3 项数据读取失败。现已在 run-fork.mjs 使用 Foundry 1.7.1 支持的 `--threads 1 --compute-units-per-second 50`，串行运行并保留保守的提供方请求限制；没有关闭限流、更换固定区块、更改合约源码/断言或跳过测试。[本地限速脚本复验](logs/T1d/fork-throttled/forge-test.log) 39 项通过，完整参数见 [summary](logs/T1d/fork-throttled/summary.json)，随后在 `d96f1e2576fd79aee60653cb8a904598781c7ea8` 上运行的新 push/PR CI 均全绿。该提交只增加验证脚本限流、报告、基线和原始日志，业务合约与 `5551c77` 相同。远端 contracts 的 [原始日志](logs/T1d/github-job-107591285015.log) 对应该实现提交的成功执行。
