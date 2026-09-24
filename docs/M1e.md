# T1e 进行中：出售提案与快照投票

**本文件是阶段进度，不是 T1e 整卡验收。** 目前实现不依赖出售渠道选择的提案、历史快照投票与双过半查询。`executeSale`、`completeSale`、`settleSale`、撤销整机挂单、出售款分配和换币销毁尚未实现；不能据此声称完整出售闭环已通过。T1d 的份额转让与市场已交付，见 [M1d](M1d.md) 和 [PR #6](https://github.com/jianfengliao774-sketch/pinkuang/pull/6)。

## 已实现行为

- `propose(price, refPrice, refAt)`：仅 Active 的当前成员，买入满 7 天、同一钱包两次提案至少间隔 7 天、同时最多一个有效提案。提案冷却记录不随份额清仓或重新加入而消失。上一提案到期后，其他符合条件的成员可以发起新提案。
- 使用 `snapshotTs = block.timestamp - 1` 的已结束时间戳及既有 Checkpoints 记录。快照成员数来自实际权益人，固定总份额为 100。`SaleSnapshotRecorded` 明确记录所用时间、人数和总份额，避免把当前秒的可变检查点当作冻结快照。
- `vote(id, support)`：24 小时内，每个有快照份额的地址一次。反对票也消耗投票资格，不能改票。权重只取快照；原持有人清仓后仍可投其原票，新买家不能继承这张票。同秒新加入的当前成员可以发起提案，但本次投票资格仍取前一秒。
- 赞成须同时满足 `yesCount * 2 > snapshotMemberCount` 与 `yesShares * 2 > 100`，恰好 50% 不通过。`proposalPassed(id)` 只报告这两项票数结果，过期后仍可保留历史结果；未来执行入口还必须独立检查生命周期和截止时间，不能直接把该查询等同于“现在可出售”。
- 零价、`refPrice=0` 以及任意 uint64 `refAt` 均如实记录。按 v0.4 第 6.4 节，参考价由展示和索引层核对，合约不新增偏离限制、新鲜度限制或最低出售价格。

提案和投票入口均持 Vault 的 nonReentrant 锁；投票库不调用外部协议，不改变份额或转移资产。尚未提供任何出售授权或 NFT 转出入口。

## 存储和体积

新增 `erc7201:tapeout.storage.PoolSales` 命名空间，记录顺序编号、当前提案、钱包提案时间、提案详情与投票标记。旧 Vault、PoolRewards 和 ERC-20 命名空间保持原序；零初始化的升级代理从提案编号 1 开始。原固定参数及创建入口 ABI 保持不变。

加入投票后初步编译的 Vault 为 23,879 B，超过开工计划的 22KB 拆分阈值。因此把已交付的购机前校验和卖家最后收益领取等价移到 `PurchaseValidation` 固定外部库。检查顺序、错误、固定协议地址、tradeId、事件及严格领取条件均保持；实际 buy、NFT 接收窗口、购后身份核验和 state=Active 仍在持锁 Vault 内。

市场价格原为 uint96，新库返回 uint256 后在实际 buy 前使用 `SafeCast.toUint96`。这不改变来源范围或 buyer 支出，也不额外计算市场费。新库不购买、转移或授权 NFT，也不支付购机 BNB。

最终本地全树编译：PoolVault 21,483 B、PurchaseValidation 3,532 B、SaleGovernance 2,919 B。[完整体积输出](logs/T1e/contracts/forge-build-sizes.log) 已通过，Vault 距 24,576 B 上限仍有 3,093 B。当前链接应为 MiningOperations、PurchaseValidation、RewardAccounting、SaleGovernance、ShareCheckpoints 五库；同样需要未来部署时核验链接地址和实际代码，编译模板不是已部署 codehash。

## 验证进度

| 项目 | 当前状态 |
|---|---|
| 独立投票测试 | 21 passed / 0 failed；含 256 次价格与参考值 fuzz |
| 本地全树单元及不变量 | [196 passed / 0 failed / 0 skipped](logs/T1e/contracts/forge-test.log)：175 项原有回归和 21 项新投票测试 |
| 固定块 fork | [39 passed / 0 failed / 0 skipped](logs/T1e/fork/forge-test.log)：既有协议、购机、收益、转让路径回归，不是完整出售 fork |
| 布局、库链接及静态检查 | [16 项升级检查](logs/T1e/contracts/upgrade-checks.json) 达到预期；[五库链接检查](logs/T1e/contracts/library-link-audit.json) ok=true；[Slither --fail-medium](logs/T1e/contracts/slither.log) exit 0，保留 36 条 Low/Info |
| 远端 CI | 提交 `aa7645c368c59ad22991fcea4a42467ff53ddc8c` 的 [PR CI #35988959287](https://github.com/jianfengliao774-sketch/pinkuang/actions/runs/35988959287) 全部通过；[push CI #35988953098](https://github.com/jianfengliao774-sketch/pinkuang/actions/runs/35988953098) 在失败任务重跑后也已全部通过 |

投票测试位于 `contracts/test/unit/PoolVoting.t.sol`，覆盖 49/26/25 的双多数、两类恰好 50%、反对及重复票、取得矿机 7 天和每钱包提案 7 天边界、24 小时投票截止、过期提案替换、三种同秒份额移动、旧持有人清仓后的快照资格、锁定权益和创建/终态限制。Closed 负例使用既有测试专用生命周期 fixture，不代表真实出售已经完成。

复现命令：

```powershell
node scripts/check-local.mjs T1e
$env:VALIDATION_TASK='T1e'
$env:BSC_RPC_URL='https://bsc-mainnet.public.blastapi.io'
$env:FORK_BLOCK='123728000'
npm run test:fork
```

## 尚待明确的出售渠道

开工计划第 1.3 节第 1 条将“首期出售只走项目合约自己的 completeSale、不在 CircuitMarket 挂单”列为 **“项目方需确认：是”**。该路径已在 [M0](M0-report.md) 验证可强制同笔交易先结清后过户；裸市场路径无法保证这一点。

已向项目方发出一次确认请求，目前尚未收到答复：平台 2% 和销毁预算 2% 均保持原文档费率，因为不经 CircuitMarket 不产生其 1%，成员按实收减去两项费用取得约 96%，整数尾差另列；代价是 tapeout.market 不显示挂单。v0.4 第 6.3 节的实际到账公式支持这一计算。这里等待的是明确列出的渠道取舍，不是再次请求批准已经确认的 M0 协议事实。

此决定未到达前继续完成独立投票工作，不把尚未确认的渠道写成已经交付的成交功能，也不把阶段进度当作 T1e 的完整验收。

本地执行元数据：[contracts](logs/T1e/contracts/summary.json)、[fork](logs/T1e/fork/summary.json)；对应 [合约源码哈希](logs/T1e/contracts/source-sha256.json) 与 [验证输入哈希](logs/T1e/contracts/verification-input-sha256.json)。工作区未提交时 summary 的 sourceCommit 只是运行时 HEAD，实际被测内容以哈希为准。购机库搬移已独立对照 `5551c77` 的原检查/事件顺序复核，现有购机测试与真实协议 fork 不改断言通过。没有为通过检查新增 Slither 抑制，原已有精准注释随对应语句移动。

远端 [contracts 原始日志](logs/T1e/github-job-107598172642.log) 与 [PR fork 日志](logs/T1e/github-job-107598843114.log) 已保存。push 的首次 fork 为 38 通过、1 项 TokenSwapProbe 读取池账户时收到 HTTP 429；[失败日志](logs/T1e/github-job-107598810187-initial-failure.log) 保留。同一提交的 PR fork 39 项全部通过，未改源码/断言/区块；[失败任务的第二次执行](logs/T1e/github-job-107599427384.log) 39 项全部通过；push 与 PR 现均 success，原始失败未删除。
