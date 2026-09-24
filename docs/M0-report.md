# M0 协议验证报告（T0.2）

2026-09-24。依据开发文档 v0.4 和开工计划，仅实现测试探针与验证工具，未实现或部署业务合约。

**本地最终结果：28 项通过，0 失败，0 跳过。Q1–Q9 均有固定区块 fork 证据。** 这代表下表限定场景的协议验证完成，不代表 PoolVault 业务验收或全协议安全审计完成。

远端 [GitHub Actions #35979104919](https://github.com/jianfengliao774-sketch/pinkuang/actions/runs/35979104919) 的 contracts 和 fork 两个 job 均通过，验证代码提交 `cf57560d9f865908f3e2c774646a846c5f17f87d`。原始 [构建检查日志](logs/T0.2/github-job-107566478478.log) 与 [28 项 fork 日志](logs/T0.2/github-job-107566714967.log) 已保存。

## 固定环境

- BSC 主网，chainId `56`，区块 `123728000`，时间 `2026-09-24 08:51:03 UTC`。
- 区块哈希：`0x18c5cda4bb465d1a9aae3d4fe66150cffbe187e2488b856a93f4376080e26306`。
- 归档节点：`https://bsc-mainnet.public.blastapi.io`。默认官方节点在该历史状态返回 missing trie node，保留失败预检供复核。
- Foundry `1.7.1`，Solidity `0.8.24`，Shanghai，OZ `5.0.2`，profile `ci`。
- TapeOut #16210 当时持有人 `0xd48aaaf5db140ccbd64a8fbd1b63f3f631443744`，状态 Active；#400 持有人 `0x4e5dcf356443174f5f03e4ac134238201c1f2bd8`，同为 Active。测试每次核对链和区块、读取真实持有人；转移使用本地 `vm.prank`。
- 原始链上读取见 [归档预检](logs/T0.2/rpc-archive-preflight.json)、[矿机读取](logs/T0.2/miner-preflight.json)、[代币及池读取](logs/T0.2/token-chain-evidence.json)。

## Q1–Q9 结论

测试前缀 M = `MiningStartProbe.t.sol`，P = `ProtocolProbe.t.sol`，C = `MarketProbe.t.sol`，T = `TokenSwapProbe.t.sol`。下列测试名均见 [完整最终运行输出](logs/T0.2/forge-test.log)。

| 问题 | 结论 | 测试证据 | 对设计的影响 |
|---|---|---|---|
| Q1 合约持有人能否开挖和停挖 | 已证实。ProbeHolder 能完成 stop、arm、真实 start；registrant 为合约；陌生地址三项均拒绝 | M `test_Q1_contractHolderArmStartStop_realProofs`；`test_Q1_strangerArmStartStopRevert` | 无须降级为只能购买已开挖矿机；生产 operator 权限仍按 v0.4 限制，不因此开放停挖 |
| Q2 参数和时限 | 已证实 task 1 的真实向量、32 个抽样及 Merkle 证明；arm 后第 1、10、11、64 块成功，同块和第 65 块拒绝。停挖冷却严格超过 1200 **块** | M `test_Q2_startAtTenBlocks_realProofs`、`test_Q2_startAtElevenBlocks_realProofs`、`test_Q2_startAtSixtyFourBlocks_realProofs`、`test_Q2_startAfterSixtyFourBlocksReverts`、`test_Q2_startInArmBlockReverts`、`test_Q2_invalidMerkleProofRejectedThenValidProofAccepted`、`test_Q2_stopCooldownDoesNotExpireByTimestampAlone`、`test_Q2_stopCooldownRequiresMoreThan1200Blocks_notSeconds` | 文档中的约 10 块开挖时限、1200 秒冷却需按实测纠正；前端可保留 10 块保守重试策略 |
| Q3 转入合约后是否继续挖 | 已证实。清掉旧收益后推进 3600 秒，另一矿机的真实 claim 更新全局累计量，本矿 pending 增至 39272 最小单位；全部领到 ProbeHolder | P `test_Q3_ActiveMinerContinuesAndClaimsToContractAfterTransfer` | 没有触发“转移后停挖”的项目终止条件；pending 视图有延迟，不能当实时精确应领额 |
| Q4 标价和 1% 费用 | 已证实。标价 1 BNB，买方支出 1 BNB，卖方到账 0.99 BNB，费用 0.01 BNB；少付或另加 1% 均拒绝 | C `test_Q4_MarketBuyerPaysListedPriceAndSellerBearsOnePercent`；`test_Q4_MarketRejectsUnderpaymentAndFeeAddedOnTop` | priceCap/购机付款按挂牌价，不再另加市场手续费 |
| Q5 卖款到账路径 | 已证实。合约卖方通过 receive 直接收到 99%，卖方 owed 为 0，withdraw 报 nothing owed；1% 费用记入 protocolWallet.owed，可提现。卖方拒收使整笔回滚 | C `test_Q5_ContractSellerReceivesBnbDirectlyAndHasNothingToWithdraw`、`test_Q5_ProtocolFeeUsesOwedAndWithdraw`、`test_Q5_RejectingSellerRevertsTradeInsteadOfCreatingOwed` | 不能把市场 owed 当卖款路径；收款来源及上下文须按 v0.4 限定 |
| Q6 同笔先领后过户 | 已证实原子顺序可行。买前 claim 将 342827 单位给卖家再 buy；错误价格使先前 claim 回滚。受控出售把最后 382099 单位留给旧持有人，再过户；新产出归买方。裸市场出售不会领币，旧收益可被新买方领取 | P `test_Q6_BuyerClaimsSellerThenBuysAtomically`、`test_Q6_FailedBuyRollsBackPriorClaim`、`test_Q6_ControlledSaleSettlesBeforeTransfer`、`test_Q6_ClaimFailurePreventsControlledTransfer`、`test_Q6_BareMarketSaleDoesNotForceFinalClaim` | 保留先领后买；出售必须走受控 completeSale。ProbeHolder 只证明此原语，生产 Vault 禁止旁路/记账/投票权限仍待 M1 验收 |
| Q7 零待领再次 claim | 已证实同一时点连续两次调用均成功，第二次不增加 BEM | P `test_Q7_ConsecutiveZeroPendingClaim` | 当前实现可处理零收益领取；不能掩盖其他领取失败 |
| Q8 BEM mint 权限 | 已证实 mint 调用者只能为 Mining 代理，运行字节码内嵌该地址；非 minter 拒绝，模拟 Mining 调用成功，超过 2100 万 BEM 上限拒绝。Mining owner=0、isSealed=true | T `test_Q8_MintOnlyImmutableMiningMinterAndCap`；[字节码反汇编](logs/T0.2/token-mint-disassembly.txt) | 文档“尚未封存、owner 保留升级权”的 Mining 现状需纠正；这些证据不等于已审计全部权限路径 |
| Q9 BNB/BEM 双向兑换 | 已证实。SmartRouter 买入 0.001 BNB 得 0.01213154 BEM；卖出 0.01 BEM 得 0.000807891677110236 BNB，均带 minOut，原生 BNB 已验证 unwrap。不可满足的 minOut 原子回滚 | T `test_Q9_PoolAndRouterIdentity`、`test_Q9_BnbToBemWithMinOutAndRefund`、`test_Q9_BemToNativeBnbWithMinOutAndUnwrap`、`test_Q9_ExcessiveMinOutRevertsWithoutTakingBnb` | 使用 V3 1% 池和七字段 exactInputSingle；deadline 在 multicall；大额 maxIn/报价保护仍需生产实现 |

## 关键证据与边界

`pending()` 读取已存储的累计量。#16210 初始查询为 342456，实际首次领取 342827；清零后仅 warp 一小时，pending 仍为 0，调用另一矿机的真实 claim 后才显示新增 39272。这说明读取值滞后，不代表停挖。实际结算应同时检查 NFT 当前持有人、正确 minerKey、领取是否成功、领取后 pending 和 BEM 实收余额；不能要求“实收恰好等于领取前 pending”。最初错误假设导致的 [失败输出](logs/T0.2/initial-pending-assumption-failed.log) 一并保留，不冒充通过。

开挖逻辑来自 [官方 PoD 前端](https://tapeout.net/pod/assets/main-C1q9aWV9.js) 和 [官方向量库](https://tapeout.net/pod/pod-vectors-all.json)。旧计划指向的 MineConsole/TapeoutMiner 文件在当前站点用于 BTC 演示，故改取真正的 PoD 模块。采样索引为 `keccak256(abi.encodePacked(anchorHash,circuits,circuitId,uint32(i))) % 256`；叶节点为双重 keccak256 的 ABI(index,input,out)，Merkle pair 排序后连接。task 1 根为 `0x850c8ad5850c125982a71d3ecf96bd485f1f25a600bec4e02559e9413e16cc63`，运行时重建并核对。

前端 SHA-256：`0f1b12c360fec6c49121c01f1faa7ee29705637efd62b107d720fa1f62010a1e`；向量库 SHA-256：`2b087560556859b589abac43ac9aac92a7f7a87a023a51e2e4d967c53efd80eb`。未来锚点采用明确标记的本地 `vm.setBlockhash`，证明验证及 arm/start/stop 使用真实 fork 协议。未覆盖所有 task、电路类型及 Behemoth 开挖，这些范围**未证实**。

Q9 两方向各自从同一原始区块开始。卖币资金由真实持有人在本地 fork 转入，没有修改池存储或伪造 ERC20 余额。扣除名义 1% 费用后，相对即时 spot 的价格冲击加舍入偏差，买约 **0.824297 ppm**，卖约 **1.279112 ppm**；不是交易待打包期间的滑点测量，也不保证大额价格。详细金额、路由器地址和 [官方 PancakeSwap 来源](https://developer.pancakeswap.finance/contracts/v3/addresses) 见 [Q8/Q9 明细](logs/T0.2/token-conclusions.md)。

只有 `test_Q6_ClaimFailurePreventsControlledTransfer` 注入 claim 故障以验证测试适配器回滚；其余协议成功路径未替换协议代码/存储。全部资产操作均在本地 fork，无主网广播、私钥或部署。尚未实现业务合约，所以 Slither 业务审计、升级布局及份额/投票/分账不变量均**不适用且未验收**。

## 文件与复现

- `contracts/test/fork/ProtocolProbe.t.sol`：转移、收益归属、原子交割、零收益领取和白名单测试。
- `MiningStartProbe.t.sol`：合约持有人权限、真实开挖证明、锚点和冷却边界。
- `MarketProbe.t.sol`：真实市场费用、直接支付、owed 提现及拒收回滚。
- `TokenSwapProbe.t.sol`：mint 权限与真实 V3 双向兑换。
- `contracts/test/utils/ProbeHolder.sol`：限定 NFT/调用白名单的测试持有人；不是生产 PoolVault。
- `MiningStartFixtures.sol` 与 `scripts/m0/generate-start-fixture.mjs`：官方 task 1 向量及可重建生成器；重建后运行 forge fmt。
- `scripts/m0/token-evidence.py`：只读固定块 RPC 和字节码证据采集。
- `scripts/run-fork.mjs`：固定块运行、Windows ASCII 副本校验、原始日志和哈希保存。
- `.github/workflows/contracts.yml`：push/PR 自动运行公开 RPC fork 测试并上传原始输出；`.env.example`、`README.md` 更新复现说明。

```powershell
$env:BSC_RPC_URL='https://bsc-mainnet.public.blastapi.io'
$env:FORK_BLOCK='123728000'
npm run test:fork
```

脚本依次执行 `forge fmt --check`、`forge build --sizes`、`forge test --match-path test/fork/** --fork-url bsc --fork-block-number 123728000 -vv`。中文 Windows 路径自动使用 ASCII 临时副本，逐文件 SHA-256 与原始源码一致才运行。

最终结果：`28 tests passed, 0 failed, 0 skipped`。原始 [测试输出](logs/T0.2/forge-test.log)、[完整 build --sizes 输出](logs/T0.2/forge-build-sizes.log)、[格式检查](logs/T0.2/forge-fmt.log)、[源码哈希](logs/T0.2/source-sha256.json)、[执行命令和退出码](logs/T0.2/summary.json) 均已保存。未把空的非 fork 测试称为业务测试通过。

## 文档偏差及后续决定

已证实的差异为：开挖在 arm 后第 1、10、11、64 块成功，同块及第 65 块拒绝（边界抽测支持 1–64 块窗口，未逐块穷举）；停挖冷却超过 1200 块；Mining 已封存且 owner 为零；pending 非实时应领额。池资产余额也已变化，历史近似数值不能作当前报价。没有更改认购费率、1/4/95 分账、投票规则或 operator 权限。

**项目方已于本会话明确确认“按实测纠正，继续 M1（推荐）”。** 后续 M1 采用上述实测协议事实，业务费率、投票和权限规则保持 v0.4 要求。原始两份需求文件保持不变，本报告作为已确认的协议事实勘误。本卡已完成所有独立验证，不存在 Q1/Q3/Q6 所列的降级或项目终止触发。页面参照“芯火夺宝”的要求已记录在 [视觉参考](design-reference.md)，本卡未提前实现 M3。
