# T1b：原子购机与购机余款

本卡依据开发文档 v0.4、开工计划 T1b 和已确认的 [M0 链上事实](M0-report.md)，在生产 PoolVault 中实现市场购入、指定卖家直卖、交割前结清及购机余款。测试部署使用真实 Factory、PoolTimelock、PoolBeacon 和 Vault 实现；所有部署与资产操作均限本地测试或 BSC fork，没有主网广播。

**验证状态：本地及远端验证全部通过：80 项单元/不变量、31 项固定块 fork，以及格式、体积、升级布局和 Slither。** 实现提交为 `6d090612c4b5ce0409b08b90a0573912aaee95f9`，[push CI #35982654911](https://github.com/jianfengliao774-sketch/pinkuang/actions/runs/35982654911) 和 [PR CI #35982671054](https://github.com/jianfengliao774-sketch/pinkuang/actions/runs/35982671054) 均成功。本地证据见 [contracts 汇总](logs/T1b/contracts/summary.json) 与 [fork 汇总](logs/T1b/fork/summary.json)。已保存同一提交成功运行的 [push contracts 原始日志](logs/T1b/github-job-107577977613.log) 和 [PR fork 原始日志](logs/T1b/github-job-107578363318.log)。

## 行为与资金归属

- `buyFromMarket(listingId)` 只在 Funded 且购机截止前执行。核对有效挂单、卖家、指定矿机及价格上限；市场挂牌价就是买方总支出，不另加 1%。
- 两条购机路径均核对 minerKey、挖矿记录中的 circuits/id 和 Active 状态，先真实调用 Mining.claim 为旧持有人领取，再验证领取结果与旧持有人，最后转移 NFT；购入后再次核对 owner、相同 minerKey 及 Active 状态，才记录 purchaseCost 并进入 Active。
- `pending()` 可能滞后，包含查询为零而实际有收益的情形，因此不能据此跳过 claim。比较卖家 BEM 前后余额，要求实收不少于此前已显示的 pending；领取后 pending 必须为零。领取失败、余额不符、产权变化或转移失败均整笔回滚。
- `onERC721Received` 只接受本次购机上下文：NFT 合约、tokenId、卖家、operator 都必须匹配，且只能回调一次。市场路径 operator 为 CircuitMarket，直卖路径为 Vault。
- `sellToPool()` 只允许创建时的 directSeller；直售价记入其 BNB pull 余额。卖家可同时持有项目份额，此时卖款与自己的余款相加；此前撤回认购尚未领取的 BNB 也不会被覆盖。
- 余款为 `totalRaised - purchaseCost`，每份向下取整，余数单独保存在 `surplusRemainder`。BNB 强制转入及旧退款余额不增加购机预算或余款。`bnbOwed`、`assetOwed` 和 `totalBnbOwed` 包含已归属但尚未逐户落账的余款。

懒结算先保存每份应得 BNB；该地址首次领取或首次余额变化前，将其购入时份额对应的余款转入固定的 `bnbOwed`，并标记仅处理一次。`surplusOutstandingWei` 同额减少，所以固化权益本身不改变总负债，实际提现才减少总负债和 BNB 余额。该做法不要求等待下一秒，购机当秒即可领取。当前普通份额转让仍全部拒绝；T1d 开放前必须保留双方余额变化前的固化，并补齐收益与锁定份额规则。

## 改动文件

| 文件 | 本卡内容 |
|---|---|
| `contracts/src/PoolVault.sol` | 市场/直卖购机、强制结清、单次 NFT 回调、Active 转换和懒余款负债 |
| `contracts/src/interfaces/IPoolVault.sol` | 购机入口、交割/购入/余款事件及相应错误 |
| `contracts/src/interfaces/ITapeoutMining.sol` | M0 已验证的完整 Miner 返回结构及矿机读取/领取接口 |
| `contracts/src/interfaces/ICircuitMarket.sol` | 已验证的 listingView 和 payable buy 窄接口 |
| `contracts/test/unit/PoolPurchase.t.sol` | 37 项购机、异常回滚、同秒余款、兼任卖家与股东、历史负债、尾差及 Mining.claim 回调重入测试 |
| `contracts/test/utils/PurchaseMocks.sol` | 仅供异常注入的协议替身；不作为真实链上行为证明 |
| `contracts/test/fork/PoolPurchaseFork.t.sol` | 3 项生产 Vault 在固定 BSC 状态上的真实市场/直卖及持续挖矿验证 |
| `scripts/validate-upgrades.mjs` | 将本次 Factory/Vault 布局与已交付 T1a 基线实际比较，保留正反例检查 |
| `scripts/check-local.mjs`、`scripts/run-fork.mjs` | contracts/fork 分开保存证据、记录运行状态与输入哈希、校验 ASCII 副本 |
| `.github/workflows/contracts.yml` | 在当前运行独有且位于 checkout 外的目录保存并上传 CI 证据，避免把已提交本地日志当作远端输出 |
| `docs/M1b.md`、`docs/logs/T1b/` | 本交付说明和本卡原始验证记录 |

## 命令与原始输出

```powershell
node scripts/check-local.mjs T1b
$env:VALIDATION_TASK='T1b'
$env:BSC_RPC_URL='https://bsc-mainnet.public.blastapi.io'
$env:FORK_BLOCK='123728000'
npm run test:fork
```

contracts 实际执行格式检查、`forge build --sizes --force`、`forge test --no-match-path test/fork/** -vv`、升级布局检查，以及 `slither . --filter-paths '../node_modules/|test/|script/' --fail-medium`。fork 执行格式和体积检查，再运行 `forge test --match-path test/fork/** --fork-url bsc --fork-block-number 123728000 -vv`。

| 验证 | 当前结果与完整原始输出 |
|---|---|
| 单元测试与状态不变量 | [80 passed，0 failed，0 skipped](logs/T1b/contracts/forge-test.log)；含 37 项本卡购机测试及 43 项 T1a 回归 |
| 募集/退款状态不变量 | 同上日志，两项各 128 runs、8192 calls、0 revert；这仍是募集退款不变量，不冒充全阶段收益守恒 |
| 全树固定块 fork | [31 passed，0 failed，0 skipped](logs/T1b/fork/forge-test.log)，包括 28 项 M0 回归和 3 项生产购机测试 |
| 格式 | [contracts](logs/T1b/contracts/forge-fmt.log)、[fork](logs/T1b/fork/forge-fmt.log) 均 exit 0，空日志表示没有格式差异 |
| 体积与编译 | [完整 build --sizes 输出](logs/T1b/contracts/forge-build-sizes.log)，exit 0 |
| 升级与布局 | [原始输出](logs/T1b/contracts/upgrade-validation.log)、[七项结构化结果](logs/T1b/contracts/upgrade-checks.json)；正例通过，故意破坏布局的负例被拒绝 |
| Slither | [最终原始输出](logs/T1b/contracts/slither.log)，`--fail-medium` exit 0；三项初始发现经局部说明处理，最终全树复跑通过 |

Slither 初次失败的 [完整发现](logs/T1b/contracts/slither-initial-findings.log) 和 [汇总退出码](logs/T1b/contracts/summary-initial.json) 保留，未将其覆盖成通过。三项新增提示均仅在对应语句旁对指定 detector 作窄抑制，并保留原因：

- `weak-prng`：`surplus % 100` 是已知募集额减实际购机成本后的确定性整数尾差，没有随机数、抽奖或依靠区块时间选取结果的用途。余款与尾差守恒由单元及真实 fork 测试验证。
- `reentrancy-balance`：卖家 BEM 前后余额差是收款校验，不是用过期余额授权付款；调用该内部函数的两个购机入口均持有 `nonReentrant` 锁，领取失败或余额条件不符会整笔回滚。抑制限定在余额差校验语句，保留真实余额核验。
- `unused-return`：listingView 的 feeBps 有意不参与买方总价计算；M0 与本卡真实 fork 均证明买方只支付 price，手续费由卖家承担。仍校验同一次读取的 seller、circuits、tokenId、price、valid，没有为消除提示而重复加费。

T1a 已解释的两处 Checkpoints 份额零边界抑制继续保留。时间戳期限、存储汇编、已检查返回值的 BNB call 和 CLOCK_MODE 命名提示仍在日志中；不声称 Slither 输出为空或已经完成外部安全审计。

源码与验证输入见 [合约源文件 SHA-256](logs/T1b/contracts/source-sha256.json)、[验证脚本/依赖锁/基线 SHA-256](logs/T1b/contracts/verification-input-sha256.json) 和 [fork 源文件 SHA-256](logs/T1b/fork/source-sha256.json)。本地运行记录的 `sourceCommit` 是运行时 HEAD，未提交工作区的实际被测内容以这些哈希为准；远端 CI 应以对应 run/sha 及独立上传的日志核对。

布局验证以 T1a 已交付提交 `339c034e4bf4b504dcd4a7479d272a7f662497fc` 的 [Factory](storage/T1a-PoolFactory.json) 和 [Vault](storage/T1a-PoolVault.json) 为基线。Factory 的 7 个业务字段保持不变，Vault 从 15 个增至 24 个，新增购机字段仅追加。没有跳过存储布局检查。正例包括初始实现检查和两个兼容升级 fixture；负例自身安全检查通过，但因移动/删除既有字段而被布局校验拒绝。

当前运行时体积：PoolVault **17,037 B**、PoolFactory **8,004 B**、PoolTimelock **6,608 B**、PoolBeacon **515 B**。Vault 距 EIP-170 的 24,576 B 限额尚余 7,539 B，当前也未达到开工计划的 22 KB 拆分提醒线；不据此承诺全部 M1 功能的最终体积。

## 真实协议证据

固定 BSC 区块 `123728000`，区块哈希 `0x18c5cda4bb465d1a9aae3d4fe66150cffbe187e2488b856a93f4376080e26306`。目标 TapeOut #16210，真实历史持有人 `0xd48aaaF5DB140ccbd64A8fBD1B63f3f631443744`。募资 0.02 BNB，49/49/2 份，购机价 0.01 BNB；仅在本地用 vm.prank 授权卖家、挂牌或直卖。

- 市场购机时，卖家历史 BEM 实收 **342827 最小单位**，新 Vault 不收到这批历史收益；市场给卖家支付 0.0099 BNB，Vault 总购机支出仍为 0.01 BNB。
- 直卖同样先给卖家结清 **342827 最小单位**，0.01 BNB 卖款先记账再独立领取，不收 CircuitMarket 手续费。
- 两条路径均逐条验证同一调用中的日志顺序：BEM Mint → RewardSettledBeforeTransfer → NFT Transfer → Purchased；事件中的旧持有人、BEM 数量、目标 NFT、价格、路径和 listingId 一致。
- 三名成员在购机同秒分别可领 0.0049、0.0049、0.0002 BNB，重复领取拒绝。将价格增加 7 wei 后，所有可分余款领完仅剩明确记录的 **93 wei** 尾差。
- 市场购入后矿机仍为 Active；一小时后真实协议累计并领取 **39272 BEM 最小单位**到 Vault，卖家余额不再增加。该测试调用的是 permissionless Mining.claim，不代表 T1c 的 harvest/收益分账已经实现。

[独立详细协议 trace](logs/T1b/purchase-fork-trace.log) 来自最终全树集成之前的 3 项购机 fork `-vvvv` 运行，仅用于观察具体调用及事件顺序。**最终是否通过以及被测源码版本，以本卡全树 contracts/fork 日志和哈希为准，不能用早期独立 trace 替代。**

## 与需求的差异及待决定事项

1. 开工计划 3.2 的伪代码用 `try claim catch {}` 吞掉失败，再看 pending；v0.4 第 2.5、2.6、9.2 节要求交割前强制结清，失败必须回滚。按来源优先级采用 v0.4：任何 claim 失败均阻止购机，包括此前 pending 为零的情形。没有擅自放宽结清规则。
2. 开工计划建议按购入检查点计算懒余款。本卡采用“每份余款 + 首次余额变化前固化”的等价权益保存方式，避免购机当秒历史查询尚不可用的边界；未开放转让，未来开放时必须继续满足购入权益不随份额转让。
3. ERC-721 的 `safeTransferFrom` 在未授权购机上下文会被回调拒绝；外部调用不带接收回调的 `transferFrom` 仍可能强制把 NFT 转入 Vault。本卡不声称能阻止这种外部转入，它不会触发付款、记 purchaseCost 或激活项目；超时退款路径不依赖 NFT 不在本池。
4. 仅接收已经 Active 的目标矿机，并在购入后复核仍为 Active，落实 v0.4 的购入后保持挖矿要求。未开放暂停挖矿、救援提币或任意资产提现。

没有修改费率、整数份额、投票规则、权限边界或 BNB 认购范围。上述来源冲突按 v0.4 处理，不需要另作业务选择；没有新增需要项目方决定的业务问题。本地交付检查与远端 CI 全部完成。T1c 收益分账、T1d 转让、投票出售、网站与主网部署不属于本卡完成声明。
