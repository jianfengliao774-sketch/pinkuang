# 购机与交易恢复安全复核

> 本文记录早期版本复核。2026-09-26 后续整改已增加单位权重限价并取消销毁；当前规则和最终验证以 [最新整改报告](audits/2026-09-26/remediation.md) 为准，下文行号、哈希及数量保留为历史证据。

检查时间：2026-09-26。范围为当前工作区的 `FlexiblePurchase`、`PurchaseValidation`、`PoolFunds`、Vault 购机入口和官网采购 keeper。只读检查、本地隔离测试；未使用真实私钥、未广播主网交易、未接触生产计算。本文不是完整审计或资产安全保证。

## 本次发现及最终修复状态

1. **替代购机原先可以跳过仍可购买的原目标。** `PoolVault.buyAlternativeFromMarket` 对任意地址开放，最初的 `FlexiblePurchase.buy` 只核候选 collection、质量和价格上限。外部卖家可主动触发购买自己的合格替代机，即使原目标仍有更便宜有效订单；keeper 把原目标放第一位无法约束其他调用者。已修复并独立验收：`FlexiblePurchase.sol:96` 调用 `:167` 的 `_originalAvailable`，链上拒绝跳过仍有效、满足固定质量、价格不超过 cap 的原目标。双挂单读回、seller/collection/token/price 一致性及所有权均检查；零价/零 seller 排除。第三方抢先替代测试通过。
2. **替代型号原先没有锁定 taskId。** 最初 `_requireQuality` 只要求同官方 collection、活跃、非最优、纯 verified、最低权重。已修复并独立验收：`FlexiblePurchase.sol:55` 配置时读取官方链上参考矿机并固定 `purchaseModel()` taskId，`:97` 与 `:112` 购机前后都比对。`taskId` 是链上题目编号，不是 NFT 编号，也不自动代表相同门数、面积、成本、回报率。两入口错误 taskId 拒绝、claim/市场回调改 taskId 回滚测试通过。旧的 flexible namespace 未初始化 model 会禁止购买，但不会禁用到期退款，也没有管理员事后回填改变承诺的入口。
3. **旧 keeper 恢复方案只看单个 hash、两次确认和 journal/pool 锁。** 初始版本 `reconcilePending` 未核 receipt 所属区块的 canonical hash；持久化 intent 后若未拿到返回 hash，只能人工恢复；同一钱包运行不同池尚无钱包锁。已按最终源码复核并独立执行 42/42 keeper 测试：确定 hash 与签名原始交易先 fsync 后广播；同钱包持久指针及进程锁；所有同 nonce 尝试共同核对；显式有限提价/取消；receipt hash/from/to、canonical block hash 和 finalized 全部通过后才记终态。额外发现的旧版两确认终态兼容缺口也已关闭：缺少持久化 finalized 高度/哈希的旧终态不能读取为已完成或释放跨池钱包。

历史已披露的最高价边界继续成立：`priceCap` 是可接受最高成交支出，不是市场最低价保证。卖方在上限内提高价格属于已授权范围；不要因为多募 10% 就不加考虑地扩大可接受买价。此前已有 `docs/audits/2026-09-24/source/findings.md` 第 12 项和 `remediation.md` 第 12 项，本次不将其重新计作新发现。

## 已复核的资金和 NFT 边界

| 场景 | 当前代码结果 | 证据 |
| --- | --- | --- |
| 目标先被其他人买走、撤单或失效 | 官网 listing/owner 核对或实际市场 buy 回滚；池本金与 NFT 选择一起回滚；下一次才能尝试仍合格替代单 | `PurchaseValidation.sol:22`；`FlexiblePurchase.sol:84`；`FlexiblePurchase.t.sol:test_originalSoldThenQualifiedAlternativeActivatesAndSettlesSellerOldRewards` |
| 买错 collection / tokenId / 卖方 / NFT callback | 挂单静态比对、receiver 五元条件和最终 owner/minerKey 核对共同拒绝；不是仅依赖 API 名称 | `PoolVault.sol:170`；`PurchaseValidation.sol:30`；`FlexiblePurchase.sol:197` |
| 旧矿工收益没有成功结清 | claim 失败、卖方 BEM 增量不足、pending 非零或所有权改变都回滚整次购买 | `PurchaseValidation.sol:78` |
| 回调中改变矿工质量或重入购买 | 购前/购后质量检查与外层 `nonReentrant`；成功后 State.Active，第二次购买被状态检查拒绝 | `FlexiblePurchase.sol:97`、`:112`；`PoolVault.sol:138` |
| 筹款完成前/截止后购买 | 必须 State.Funded 且 `block.timestamp < purchaseDeadline`，未完成不能花，超时交易不能晚到成交 | `FlexiblePurchase.sol:134` |
| 没买成，需要退本金 | 截止后任何人可 finalizeFailure，按真实 contributedWei 记入各自 bnbOwed，不经第三方付款回调 | `PoolFunds.sol:25` |
| 购机有余款 | flexible 模式按购机时持仓比例记账，整数尾差归 activeMembers 最后成员；总计必须等于全部余款 | `FlexiblePurchase.sol:212` |
| 一个持有人拒收 BNB | 仅其自己的 withdraw 回滚并恢复 credit；其他人的 credit 和领取流程不受阻 | `PoolFunds.sol:84` |
| 领取时重入 | credit 先归零，外层 nonReentrant；拒付则 EVM 回滚恢复全部记账 | `PoolFunds.sol:85`；`PoolVault.sol:131` |

本金和余款“退款”在当前实现中是**计入可领取余额**，不是自动发送到钱包。到期还需某人发送 finalizeFailure，然后各出资人分别 withdrawBnb。当前 keeper 只提示到期可结算并停止，不替用户发送退款交易。没有 withdrawTo 接口；永久拒收原生币的智能合约出资人仍可能无法取走自己的余额，但不会拖住其他人。

## 原目标优先的条件性阻塞

采用链上原目标优先后，原目标的静态挂单仍有效、价格在 cap 内且矿工质量合格时，禁止买其他 NFT。这不等于证明实际成交一定成功：官网市场会向卖方支付款项，卖方合约拒收、Mining 无法结清旧收益、授权变化或协议读取异常都可能令原交易回滚。

对这些情况不能把一次 RPC/模拟失败自动解释为“原目标已无货”。保持拒绝替代是已选的保守规则；必须等待原单撤销/失效/质量真实变化，或者到 purchaseDeadline 后走全额本金领取路径。因此承诺应是“原目标不可用时尝试合格替代，最终超时可退”，不能承诺任何故障都自动换机、立即退款或保证抢到。

## 经济质量和外部信任边界

- `referencePriceWei`、`targetDailyYieldAtomic`、来源时间、区块和摘要是运营方披露的参考快照，不是合约验真的 oracle。合约按参考价与预算公式约束筹资，不验证真实 API 签名或保证每日固定 BEM 收入。
- `verifWeight` 是链上准入质量底线；全网总权重及挖矿规则改变会改变真实日产能。同 taskId 加最低 weight 不能改写为“保证同收益”。非最优纯验证池的“99%”是奖励池称呼，不是允许 1% 未验证权重。
- “官网采购”只执行写死的 CircuitMarket；Firsto 的 buyerCostWei 不是官网成交价。Firsto signed/batch 订单不属于当前合约可执行路径。
- factory 地址是部署记录/用户提供的信任根，双向 getter 和 isPool 只证明内部自洽，不能认证任意伪造的一组地址。keeper 使用独立、少量 Gas 余额的钱包可限制恶意 factory 输入对该发送钱包的损失；池资产仍由实际池合约约束。
- permissionless 入口可被外部调用者触发，但其可买范围必须全部由链上不可变条件定义。离链排序、API 过滤和 estimateGas 都不能代替执行时校验。

## 卡链和 nonce 恢复验收清单

1. 同钱包跨池进程在签名前获得独占锁，重新读取 journal 和 pending/latest nonce；其他主机或外部钱包软件不受本机锁控制，因此专用发送钱包仍是运行条件。
2. 签出确定交易后，原始交易/确定 hash/nonce/to/data/value/fee 信息先可靠落盘，再广播。签名本身不等于链上成功；RPC 超时不表示没有广播。
3. 已持久化同 nonce 的所有尝试都需查收据。原交易可能在提价/取消之后先上链；不能只检查最新 hash，更不能在结果不明时改用新 nonce 再买。
4. 恢复 hash 必须绑定 chainId 56、原 sender、nonce、允许的 to/data/value。取消仅允许同 nonce、自发自收、零值、空 calldata。nonce 已被其他交易消费且本地无匹配收据时，停止并要求核对。
5. 替换必须显式、次数有界、保留累计 Gas 预算和 Gas 单价上限，且费用提高；取消也要计 Gas。所谓取消是另一笔竞争交易，并不能撤销已确认购买。
6. 已实现 status 0/1、receipt hash/from/to 匹配、`getBlock(receipt.blockNumber).hash === receipt.blockHash`、至少两确认、`finalized` 高度覆盖 receipt，并在取 finalized 后再核一次 canonical hash。RPC 不支持 finalized 时保持 pending，不释放 nonce。终态记录持久化 finalizedBlockNumber/Hash；旧记录无证明时失败关闭并要求人工对账。
7. revert 会花发送者 Gas，但不花池本金。failed receipt 的真实 Gas 必须计入总预算。单池正常成功只能一次；购买仍待确认时不得转而尝试下一 NFT。

官方资料：[Solidity 安全注意事项](https://docs.soliditylang.org/en/latest/security-considerations.html#sending-and-receiving-ether) 说明外部收款调用与 withdrawal 模式；[Ethereum 交易字段](https://ethereum.org/developers/docs/transactions) 解释 nonce 等身份字段；[BSC Finality API](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/bsc-api-list/) 支持 safe/finalized 区分；[Geth 同 nonce 替换说明](https://geth.ethereum.org/docs/monitoring/understanding-dashboards) 说明更高 Gas 同 sender/nonce 替换。具体客户端接受提价的阈值不在本报告硬编码。

## 本地验证记录

独立执行：

```sh
FOUNDRY_PROFILE=ci ./deploy/node_modules/.bin/forge test --root contracts --match-path test/unit/PoolFunding.t.sol --match-test 'test_(failedBnbTransferRestoresPullCredit|bnbCallbackCannotWithdrawTwice|oneHundredMemberFailureHasBoundedGasAndConservesBnb)' -vv
cd deploy
node --test scripts/purchase-keeper.test.mjs
```

结果：退款拒收/重入/100 成员失败结算 3/3 通过；旧 keeper 18/18 通过。100 成员 finalizeFailure 在测试内局部计量 **2,359,547 Gas**；整个测试报告 **17,612,527 Gas** 含 100 次存款等准备，不能冒充单次退款 Gas。该局部计量也不是主网精确估价：同一测试事务预热了部分访问，真实交易必须 estimateGas 并留足上限。

100 人上限来自 100 个整数份额和每个活跃成员至少 1 份；activeMembers 在余额归零时移除。购机余款分配循环因此有界。最终 flexible 修改另独立运行 8 个重点测试全部通过（2 个 fuzz 各 256 次）：同 taskId 两入口、原目标优先、原单模拟失败阻替代及到期全退、旧 model 未初始化不可购、claim/市场回调改变 taskId 原子回滚、拒收 holder 不阻他人、100 人购机与退款。100 人购机局部计量 **5,405,432 Gas**；新池失败结算局部仍为 **2,359,547 Gas**。测试访问可能已预热，不能将数字当成主网精确报价。最终冷账户/冷存储版本针对性套件日志 `deploy/evidence/model-targeted.log` 为 35/35，通过 `vm.cool` 将 pool、beacon、implementation，以及购机路径的 market/NFT/Mining/BEM 访问冷却后，购机局部 **5,831,032 Gas**、失败记账 **3,052,347 Gas**。已复核冷却代码和日志；不将其冒充官方主网合约 Gas 保证。完整 CI 日志 `deploy/evidence/model-ci-regression.log` 报告 332/332 通过、25 suites，本审阅者核查该日志而未重复全量 CI。

本次初读文件 SHA-256（修复实现可能随后改变）：

```text
FlexiblePurchase.sol 227ee98433313c91ff1ca4469885630015f9193c6c6d510bf2767ed635dc29fa
PoolFunds.sol         2fab4426dd75a8a8f0f2de8b35bcb51ae7db798205c7289dc2e0ceb102baab8a
purchase-keeper.mjs  53aa9cc6fcd674b02d84840343e9a07288a53ce66f04f3b4e88200a9a025cf80
```


## 最终 keeper 复核补充

上一轮独立 `node --test scripts/purchase-keeper.test.mjs`：**42 passed，0 failed**；本轮新增的 7 项发现接口测试也独立通过，当前 keeper 合计 49 项。覆盖广播超时但确定 hash 可恢复、相同字节重播、有限同 nonce 提价、原交易先于替换成功、取消先成功、取消失败停本 journal、未知 nonce 消费停人工处理、receipt 孤块/身份错误、finalized 延迟/不可用、不同池钱包锁、旧两确认终态拒绝放行。该套件包含离线测试签名和模拟 RPC，不冒充主网执行。

主线程另执行 `deploy/scripts/purchase-recovery.integration.test.mjs` 并报告 3/3 通过。本审阅者核对其范围：真实 loopback Anvil txpool 的提价、取消、取消广播时原采购先赢；它不是官网协议 fork，也不是主网交易。该测试中需 mine 64 达到 Anvil 的 finalized 标签，不得将其等待规则移植为 BSC 固定确认数。

最终取消遵循以下行为：`--send --once --cancel-pending` 只生成同 nonce、0 value、空 calldata、to=发送者的交易；发送账户有 code/delegation 则拒绝并交钱包处理。采购和取消的全部 hash 共同追踪；原采购先赢报告 confirmed，取消先赢报告 cancelled；取消流程任一失败终结为 cancel-reverted 并停止该 journal，不自动开始下一次采购。所有原已签尝试的最大 Gas 风险仍计入预算，较便宜取消不能抹掉原交易尚可执行的支出上限。

运行条件保留：同一钱包只能有一个执行方，本机锁不协调另一台机器或外部钱包软件；RPC 必须可信且支持 finalized；永久失联、未知第三方 nonce、遗失 journal、拒付账户、提价次数或预算耗尽需要人工恢复。交易速度和成交结果不作保证。

此前低优先级 API 可用性边界已修复并独立复核：`purchase-keeper.mjs:94` 起对一次发现的所有页累计限制 **2 MiB**，逐块计数，不依赖 Content-Length；每页最多 50 行，要求 JSON MIME、拒绝重定向；统一 20 秒 deadline 覆盖全部页的 headers 与 body，预先取消不发请求，流中断时不等待可能永久挂起的 reader.cancel。`selectCandidates` 在形成候选前排除不同或缺失 taskId；原目标仍由池的 referenceCircuitId 直接加入队列，不依赖 API 返回。`main` 通过 `FetchRequest.timeout = 15_000` 设置单个 RPC HTTP 请求的超时；这不构成整个多请求流程的 15 秒完成保证。

新增 7 项的独立检查命令及结果：

```sh
cd deploy
node --test --test-name-pattern='candidate discovery rejects|Firsto discovery stops|Firsto discovery rejects|the 2 MiB discovery|Firsto discovery requires|abort covers a stalled|pre-aborted discovery' scripts/purchase-keeper.test.mjs
```

**7 passed，0 failed**：同型号筛选、无 Content-Length 的越界流、声明超大 body/51 行、跨页累计字节、错误 MIME/重定向、body 与取消回调挂起、headers 挂起/预取消。未重复整套回归。

另核对主线程最终日志 `deploy/evidence/purchase-final-scripts-tests.log`：**60/60**，包含 keeper 49、真实 Anvil 恢复 3、artifact 6、代理 2。`deploy/evidence/purchase-ui-and-recovery-tests.log` 首个 suite 为部署/市场/报价 TypeScript 测试 **28/28**，包括完整本地单钱包部署图与断点恢复；这里不将程序测试称为浏览器视觉验收。该文件随后较早的 scripts suite 53 项由上述最终 60 项日志覆盖。

最终核验文件 SHA-256：

```text
FlexiblePurchase.sol             4dc81acad1b454f7e098442537a97bd885ceb909ee45a62430fe2c9cf4ce5115
FlexiblePurchase.t.sol           7b37d95236b3769c2833501ba65fc5e91e867e0bcef5ecfa38dcee1709ad3a11
model-targeted.log               2d383be445e0556ceb3a664e41bd4b859f852fbe3fce3a29cf87fb9bf28cff6d
purchase-keeper.mjs              a45584abd4f33aa7a0214bbdcd71c412a7eba0688400e6f469b58f1913cfa045
purchase-keeper.test.mjs          67b2b7075599474bf3b80ea6780ab7783cdf10c5cc1c532436bedd46a4cd8cc6
purchase-final-scripts-tests.log c5ae0d395e3c55ff34d4de4a5a6bd86a127386e5342c6c88cc36d26ead9602f7
purchase-ui-and-recovery-tests.log db59e7fdeb556ad2199081833dbffb12967a2b56ad79ae9f3ee494176c817a38
```

本轮所提链上原目标优先、型号限制、receipt/finality 和旧终态恢复阻断项均已见修复并通过对应验证。以上条件风险和未支持功能保持披露；没有据此给出“保证资产安全”结论。
