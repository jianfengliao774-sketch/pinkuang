# T1c：挖矿权限与 BEM 收益分账

本卡按开发文档 v0.4 第 5、9、13.3 节和开工计划 T1c，实现生产 PoolVault 的受限挖矿调用、1/4/95 收益分账、个人领取及自然日到期销毁。协议证据延续 [M0](M0-report.md) 和 [T1b](M1b.md) 的固定 BSC fork；测试部署和资产操作均限本地，没有主网广播。

**验证状态：本地和远端全树检查通过：131 项单元/不变量、37 项固定块 fork，以及格式、体积、九项升级检查、两库链接检查和 Slither。** 对应实现提交 `0d676cd666fd2e5e8160e1d3c961d8a15f2caea3`，[push CI #35984873926](https://github.com/jianfengliao774-sketch/pinkuang/actions/runs/35984873926) 与 [PR CI #35984905789](https://github.com/jianfengliao774-sketch/pinkuang/actions/runs/35984905789) 均成功。远端原始日志：[contracts](logs/T1c/github-job-107585087213.log)、[fork](logs/T1c/github-job-107585487921.log)。本地详情见 [contracts 汇总](logs/T1c/contracts/summary.json) 和 [fork 汇总](logs/T1c/fork/summary.json)。

## 行为与资金归属

- `mine(bytes)` 仅允许 Active 项目的当前 Factory.operator 调用，运营地址变更立即作用于已有项目。目标固定为 Mining，只开放 `arm(address,uint256)`、完整八参数 `start(...)`、`reclaim(bytes32)`；集合、tokenId 或 minerKey 必须属于本项目。固定参数长度、动态 ABI 完整解码及规范编码均检查；外部调用前后核对 NFT owner、矿机 key 和记录身份。协议原始失败数据原样返回，不开放 stop、approve 或任意目标调用。
- 任何人可在 Active/Listed 调 `harvest()`；`claim()` 在这两个状态先调用内部 harvest，再结算成员收益。普通 Mining.claim 失败会发 `MiningClaimFailed`，仍可处理此前已经真实到账的 BEM；交割用的严格内部路径要求成功领取并核验余额差、pending 和产权，失败回滚。
- 新收入严格为 `BEM.balanceOf(vault) - bemAccounted`。每次按实际 gross 向下取整提取 1% 平台费和 4% 基础销毁，其余给 100 个整数份额。BEM 直转及第三方直接调用协议 claim 所带来的到账都只计一次；已计账余额、成员提现、到期销毁均不会重新成为收入。
- `claimable` 展示已记账的未过期收益，不估算尚未领取的 Mining.pending。首次非零领取不受间隔限制，此后不少于 86,400 秒；零领取不会更新时间，失败转账回滚债务与时间。BNB 退款、余款和出售款使用独立余额，不受 BEM 冷却限制。
- `epoch = floor(block.timestamp / 86400)`。第 e 日的收益在 `(e + 8) * 86400` 准点过期；此前可领范围最多为当前日及前七日。按实际收到并记账的日子归集，长期无人调用不补造历史日收益。`burnExpired(e)` 将该批 `epochNet - epochPaid` 连同尾差转入 `0x…dEaD`，同步减去 bemAccounted，不能重复销毁。
- 原 `createPool(params)` 默认开启到期规则；新增 `createPoolWithExpiry(params, false)` 可在创建时关闭。原 PoolParams ABI 保持兼容，配置仅由 Factory 在创建期间设置一次，已有项目不能改；关闭时收益长期保留，禁止到期销毁。

成员使用 8 格批次缓存及 debt。重复结算和领取保留**同一批次内**不足一最小单位的分数；不同批次之间不搬运分数，不能给旧收益重新起算期限。旧格覆盖时，全局 `epochNet - epochPaid - epochBurned` 仍保留其未结清负债。关闭到期时使用独立的全局分数进位。

`epochRemainderScaled` 记录到期模式下各批已显式结算成员的分数总和；`totalGlobalRemainderScaled` 记录关闭到期模式的对应总和，精度均为 1e36。更新时减去旧余数、加入新余数，不是把每次观测值不断累加。尚未触发结算的成员分数不会提前出现在其中；已销毁批次保留历史读数。它们不是全量尾差，也不是要额外加到 bemAccounted 上的第二份负债。完整资金守恒以成员净收入、已领、各批未付和已销毁核对；独立测试 oracle 另算可领、到期和整数尾差分类。`RewardEpochRecorded(epoch, previousAcc, cumulativeAcc, net)` 记录检查点旧/新累计值及本次净收入。

## 改动文件

| 文件 | 本卡内容 |
|---|---|
| `contracts/src/PoolVault.sol` | mine、harvest、claim、burnExpired 受锁入口，创建期到期配置及收益查询 |
| `contracts/src/PoolFactory.sol` | 默认开启及显式关闭到期规则的创建路径，保持原参数结构 |
| `contracts/src/PoolRewardState.sol` | 独立 ERC-7201 收益命名空间、批次、成员 debt 和分数记录 |
| `contracts/src/libraries/MiningOperations.sol` | 固定 Mining 白名单调用、产权/身份核验、普通与严格领取路径 |
| `contracts/src/libraries/RewardAccounting.sol` | 实际到账分账、批次检查点、同批进位、领取、过期销毁 |
| `contracts/src/interfaces/IPoolVault.sol`、`ITapeoutMining.sol` | 生产入口、事件/错误和真实 Mining ABI |
| `contracts/test/unit/PoolMining.t.sol` | 17 项调用权限、动态编码、目标矿机、资产归属及重入测试 |
| `contracts/test/unit/PoolRewards.t.sol` | 30 项精确分账、重复结算、批次边界、领取时间、到期关闭和失败回滚测试 |
| `contracts/test/invariant/PoolRewardsInvariant.t.sol` | 开启/关闭到期的独立历史账本 oracle，核对真实代币余额及所有收益类别 |
| `contracts/test/utils/MiningPermissionMocks.sol`、`RewardsTestBase.sol` | 权限/转账故障注入和内部结算、终态测试 harness，不能代替真实协议证据 |
| `contracts/test/fork/PoolRewardsFork.t.sol` | 6 项生产 Vault 真实购入后的分账、领取、到期与挖矿调用验证 |
| `contracts/test/unit/PoolGovernance.t.sol` | 兼容升级 fixture 对齐明确的库链接例外 |
| `scripts/audit-linked-libraries.mjs` | 编译模板、两库链接引用、源码哈希与限定 AST 检查 |
| `scripts/validate-upgrades.mjs` | 同时比较已交付 T1a/T1b 布局，执行库链接检查并保留布局负例 |
| `scripts/check-local.mjs`、`run-fork.mjs`、`.github/workflows/contracts.yml` | T1c 全树检查、独立证据目录及验证输入哈希 |
| `README.md`、`docs/M1c.md`、`docs/logs/T1c/` | 交付状态、说明与原始输出 |

## 命令与原始输出

```powershell
node scripts/check-local.mjs T1c
$env:VALIDATION_TASK='T1c'
$env:BSC_RPC_URL='https://bsc-mainnet.public.blastapi.io'
$env:FORK_BLOCK='123728000'
npm run test:fork
```

contracts 执行 `forge fmt --check`、`forge build --sizes --force`、`forge test --no-match-path test/fork/** -vv`、升级布局/库链接检查，以及 `slither . --filter-paths '../node_modules/|test/|script/' --fail-medium`。fork 执行格式和体积检查，再运行 `forge test --match-path test/fork/** --fork-url bsc --fork-block-number 123728000 -vv`。

| 检查 | 原始证据与当前状态 |
|---|---|
| 单元及不变量 | [131 passed，0 failed，0 skipped](logs/T1c/contracts/forge-test.log)：80 项既有回归 + 17 项 mine + 30 项收益单测 + 4 项收益不变量 |
| 固定块全树 fork | [37 passed，0 failed，0 skipped](logs/T1c/fork/forge-test.log)，31 项既有回归和 6 项本卡测试 |
| 格式 | [contracts](logs/T1c/contracts/forge-fmt.log)、[fork](logs/T1c/fork/forge-fmt.log) 均 exit 0；空日志表示无格式差异 |
| 编译及体积 | [build --sizes 完整输出](logs/T1c/contracts/forge-build-sizes.log)，exit 0 |
| 升级布局 | [原始输出](logs/T1c/contracts/upgrade-validation.log)、[九项结构化检查](logs/T1c/contracts/upgrade-checks.json)，全部预期成立，包括布局负例被拒绝 |
| 库链接 | [限定范围的机器检查](logs/T1c/contracts/library-link-audit.json)，`ok: true` |
| Slither | [最终输出](logs/T1c/contracts/slither.log)，`--fail-medium` exit 0；仍保留 29 条低级别/信息提示 |

收益不变量同时运行开启和关闭到期两套场景，各自检查代币余额与独立 oracle、全局累计值与历史批次；四项各 128 runs、8192 calls、0 revert。oracle 存原始收入和支付记录，不复用生产 accumulator 或 8 格缓存。该场景的成员固定为 49/49/2 份，操作包含直接转入、协议领取、harvest、结算、时间推进、claim 和到期销毁，尚不覆盖 T1d 份额转让。既有两项募集退款不变量继续保留，同样各 128 runs、8192 calls、0 revert。

v0.4 第 5.4 节的 1 BEM 样例精确通过：100,000,000 最小单位分为平台 1,000,000、基础销毁 4,000,000、成员 95,000,000；49/49/2 份分别取得 46,550,000/46,550,000/1,900,000，无尾差。不能整除和长期累计尾差另有独立测试。

本卡保留 [首次 Slither 发现](logs/T1c/contracts/slither-initial-findings.log)、[首次失败汇总](logs/T1c/contracts/summary-initial.json) 与 [首次升级链接检查提示](logs/T1c/contracts/upgrade-initial-linking-findings.log)，不把历史失败改写成通过。新增静态分析处置如下，抑制仅限定到对应语句及 detector：

- `weak-prng`：自然日 `% 8` 是确定性环形下标，`scaled % PRECISION` 是固定精度余数，不作随机数用途。
- `incorrect-equality`：检查的是精确零收入/零份额/零增量、整数批次身份和 epoch 0 的前驱边界；不要求可被外部转账改变的余额等于固定目标。
- `reentrancy-balance`：严格领取的余额差证明收款；收益付款后重新读取余额核对偿付能力。Vault 入口持 nonReentrant 锁，负债先更新，未用过期余额授权外部付款；Mining 与 BEM 回调重入测试均通过。
- `unused-return` 和 `uninitialized-local` 直接修正：harvest 传回分账结果，checkpoint.push 的旧/新累计值写入批次事件，局部余数显式置零。没有为消除提示改变业务分配。

事件顺序、时间戳、受限低级调用、存储汇编及复杂度等提示仍在最终日志中；不声称输出为空或已完成第三方安全审计。

源码证据见 [contracts SHA-256](logs/T1c/contracts/source-sha256.json)、[fork SHA-256](logs/T1c/fork/source-sha256.json) 和 [脚本/依赖锁/基线 SHA-256](logs/T1c/contracts/verification-input-sha256.json)。本地 sourceCommit 是运行时 HEAD；存在未提交改动时，被测内容由实际输入哈希确定。远端 CI 须对应提交 SHA、run 和新上传日志，不能拿仓库内的本地日志充作远端执行结果。

## 布局、链接与体积

布局同时比较 [T1a](storage/T1a-PoolVault.json) 和 [T1b](storage/T1b-PoolVault.json) 已交付基线。原 Factory 的 7 个字段和 PoolVault 的 24 个字段保持原序，新收益状态放在 `erc7201:tapeout.storage.PoolRewards`；检查要求实际抽取的收益 namespace 非空，同时保留 OpenZeppelin 继承状态。兼容升级 fixture 必须通过，故意移动/删除既有字段的负例必须被拒绝。

为控制 Vault 体积，将收益计算及 Mining 适配拆为两个 Solidity external library：`RewardAccounting` 和 `MiningOperations`。库地址由实现字节码链接，调用通过 DELEGATECALL 在 Vault 上下文执行；权限和 nonReentrant 锁仍由 Vault 入口负责。OZ 例外只用精确的 `@custom:oz-upgrades-unsafe-allow external-library-linking`，没有跳过存储布局检查或全局放行任意风险。

链接检查要求编译产物只引用这两个库，核对 placeholder 地址位置、源码与 metadata 哈希；对两个库自己的编译 AST 检查无普通可变存储、无显式任意 delegatecall/selfdestruct、唯一 raw CALL 固定到 Mining，并保留人工检查边界。这不是通用安全审计；产物中的 bytecode template 哈希也不是部署后 runtime codehash。后续实际部署仍须单独核对每个链接地址与链上代码。

最终运行时体积为 **PoolVault 20,724 B**、PoolFactory 8,297 B、MiningOperations 5,911 B、RewardAccounting 5,565 B；PoolTimelock 6,608 B、PoolBeacon 515 B。Vault 距 EIP-170 的 24,576 B 限额尚余 3,852 B，低于计划 22 KB 提醒线；后续任务仍须逐次检查体积。

## 真实协议证据及边界

固定区块为 BSC `123728000`，哈希 `0x18c5cda4bb465d1a9aae3d4fe66150cffbe187e2488b856a93f4376080e26306`。每项测试部署真实 Factory、Timelock、Beacon 和生产 Vault，用 49/49/2 份募集 0.02 BNB、直卖价 0.01 BNB，实际购入 TapeOut #16210。旧持有人先收到历史 BEM；Vault 购入时没有该历史收益。没有替换协议代码、存储、NFT 所有权映射或 BEM 余额。

| 真实 fork 情形 | 已观察并断言的结果 |
|---|---|
| 一小时后由陌生地址 harvest | 新铸造 39,272 BEM 最小单位；平台 392、基础销毁 1,570、成员净额 37,310；原卖家余额不增加，矿机仍 Active |
| 成员领取间隔 | 首次立即领取；第一次领取后 86,399 秒拒绝，86,400 秒成功；失败不更新时间或余额 |
| 直接转入 10,000 BEM 最小单位 | 平台 100、销毁 400、成员 9,500；49/49/2 分别领取 4,655/4,655/190，再次 harvest 不重复收费 |
| 第三方先调用协议 claim | BEM 实际先到账 Vault，随后 harvest 仍计账一次，不依赖 pending 非零 |
| 已部分领取的批次到期 | e+8 日准点后，只烧该批 net-paid，包含未分完尾差；重复销毁拒绝，bemAccounted 与实际余额同步归零 |
| 真实 arm/start | 32 个真实任务样本与 Merkle 证明被接受，registrant 为 Vault，status 为 Active，verified weight 为 2 |
| 当前 Active 矿机 reclaim | 协议真实返回 `0x79710317`，Vault 完整传回同一失败数据；不宣称已证明符合条件的 reclaim 成功 |

arm/start 的成功测试先在本地 `vm.prank(vault)` 调协议 stop 并推进冷却区块，仅为建立可重新开挖的测试前置状态；还设置了本地未来 anchor blockhash 使真实任务证明可复现。生产 Vault 没有 stop 入口，这项测试不表示运营方能通过产品停挖，也不替代对其他矿机任务的验证。

[独立详细协议 trace](logs/T1c/rewards-fork-trace.log) 来自早期独立 6 项 fork 的 `-vvvv` 运行，便于复核具体调用和资产流。它生成于最终库拆分、尾差查询和全树集成之前，**不是最终源码哈希或最终全树通过的替代证据**；最终结论以本卡 contracts/fork summaries、原始日志和输入哈希为准。

## 需求偏差与待决定事项

1. 开工计划 3.3 的简化伪码每次 settle 直接向下取整并更新 debt，频繁结算会永久丢失同日不足一单位的权益。本卡按 v0.4 累计收益及明确尾差要求保留同批分数进位，跨日不搬移；到期关闭时保留全局分数。没有更改 100 份、1/4/95 费率或批次期限。
2. 到期参数通过新创建入口固定，保留旧 PoolParams 和旧 createPool 默认开启的行为；这实现 v0.4「创建时可关」，不增加创建后的管理权限。
3. 采用两库拆分并明确记录 OZ 链接例外。检查覆盖源码、编译模板、受限调用面与布局兼容；实际部署地址/codehash 尚未验证，本卡不声明可直接主网部署。
4. Closed/Refunding 的历史收益保留、24 小时冷却、原到期日，以及严格交割内部函数均通过测试 harness 注入状态或暴露内部入口验证。该测试证明这些分支的局部行为，**不代表 T1e 投票、出售、NFT 过户闭环已经实现**。
5. 当前 real reclaim 样本不满足协议状态，证据仅为真实失败透传；不为获得正例开放 stop、绕过协议条件或更改矿机状态存储。

没有新增需要项目方决定的业务规则。本地最终全树验证与远端 CI 全部完成；T1d 份额转让、T1e 出售、前端、keeper 和主网试运行不在本卡完成声明内。
