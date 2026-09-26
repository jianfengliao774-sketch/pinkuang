# 官网与 Firsto 采购差异

核查时间：2026-09-26 15:18 CST。链：BSC 56，固定读取区块 124099541。报价 API 源区块 124099106。以下是当时核查结果，不应把费率或挂单有效性写死为永久规则。

## 已确认的费用层次

令 P 为卖家挂单价。Gas 单独由交易发送方支付，不属于下表服务费，也不自动从拼矿资金池报销。

| 路径 | 买方采购付款，不含 Gas | 手续费归属 |
| --- | --- | --- |
| 直接调用官网 CircuitMarket.buy | P | 官网协议费从卖家款项内扣，当前 100 bps，即 1%；不能改付拼矿金库 |
| 经 Firsto 官方市场采购路由买官网挂单 | Firsto 当前前端报价为 P + 1% × P | 官网卖方协议费仍存在；买方增加的服务费走 Firsto 路由 |
| 买 Firsto 自有签名挂单 | P + 订单服务费 | Firsto 当前 V2 默认 100 bps，feeEpoch=1；旧版 V1 仍为 50 bps，必须核对订单版本/费率 |

Firsto 的 circuits 页面聚合了官网和 Firsto 自有订单。在 Firsto 页面看到一台矿机，不等于只能通过 Firsto 成交。官网订单包含 `official:<market>:<listingId>`；Firsto 签名订单则有 exchange、EIP-712 签名、nonce、expiry、schemaVersion，以及 V2 的 feeEpoch。它们不能当作同一种订单执行。

官网扣费方向由项目已有固定块 fork 用例证明：挂牌 1 BNB，买方付 1 BNB，卖方收到 0.99 BNB，协议记账 0.01 BNB；多付 1% 被拒绝。此次最新链上读取另行确认官网 feeBps=100。Firsto 的买方加价公式从当前公开前端及报价 API 交叉核对，V1/V2 费率直接读链确认；未将其误写成对 Firsto 合约的完整安全审计。

## 当时的报价实例

- TapeOut #16522，官方 collection `0xb1024b89886b9a34aa4ff5f31c411d708b20a14c`，官网 listingId 17768：链上挂牌 0.041 BNB，valid=true。Firsto 页面路径报价 0.04141 BNB，差额 0.00041 BNB。
- TapeOut #16480，Firsto V2 签名挂单：挂牌 2.355 BNB，买方总额 2.37855 BNB，订单 feeBps=100，差额 0.02355 BNB。

这些实例仅用于解释费用，不代表现在仍然可成交，也不构成采购推荐。

## 对拼矿流程的含义

用户要求的“官网有货则官网采购、服务费留给拼矿；Firsto 采购则服务费付 Firsto”可以用明确的两条采购路径表达：

1. 官网路径：支付官网成交价 P，另按建池时公布并锁定的费率计算拼矿采购服务费。只有这笔独立服务费进入拼矿金库；官网原有卖方协议费仍归官网。当前尚未选择或实现拼矿采购费率，不把示例 1% 当成用户已确认参数。
2. Firsto 路径：按受支持订单的 price、feeBps、feeEpoch、schemaVersion 计算并支付 Firsto 要求的总额，按用户本次意图不再重复收取拼矿采购服务费。
3. 选择时比较最终总支出，并限制在用户锁定的总预算内。同一台资产必须按 collection + tokenId 匹配；只匹配 TapeOut/Behemoth 名称、型号或日产能不足以证明是同一 NFT。
4. 替代机是另一台资产，须满足建池时锁定的条件。参考日产能随总矿池权重变化，不是固定收益承诺。当前 FlexiblePurchase 在建池时从参考 NFT 的官方链上数据锁定 taskId，购机前后强制同 collection、同 taskId、活跃纯验证、非最优、最低 verifiedWeight 及价格上限。taskId 相同不等于门数、成本或预计收益完全相同。原目标仍有符合上述条件且不超 cap 的官网有效挂单时，链上禁止替代；无需信任 keeper 的排序。
5. 10% 额外筹款属于采购预算，不属于平台收入。退款基数为募集金额减去实际成交支出及事先明确的采购服务费。费用未使用、未约定或采购失败时，不得把预留款划走。Gas 是否报销必须另外设计，当前没有自动报销。当前余款按购机时持份计入各持有人的可领取余额（pull withdrawal），并非自动转到钱包；到期采购失败也是先 finalizeFailure 记账，再由持有人领取。

## 实现与验证边界

按用户追加的采购速度要求，官网 keeper 已改为筹款期间后台预热候选、默认每 2 秒探测状态、每 30 秒刷新候选。原目标由池内 referenceCircuitId 直接定位官网，不等待 Firsto API；满额后逐个尝试，第一台满足条件且 estimateGas 完整交易模拟通过即发送，不等全部候选核完。模拟与真实合约都检查矿机条件、价格上限、池状态和截止时间；API 只提供发现线索。原目标优先与同 taskId 已由合约强制执行。待确认交易先保存确定哈希、独占钱包 nonce，提供显式同 nonce 加价/取消，等 canonical 与 finalized 后结案。验证与恢复说明以 [采购执行文档](purchase-execution.md) 及最新 evidence 日志为准。这不是对实际成交秒数的保证，RPC、网络和链上确认仍影响耗时。

报价页现已分别显示卖家挂牌价、Firsto 买方总额、参考产能价；保留来源时间和区块，以默认额外 10% 生成只读筹款计划。现有 PoolVault 和 keeper 仅支持官网采购，尚未接入 Firsto 签名/批量/托管订单，也没有新增拼矿采购费。不要将当前页面当作上述双路线收费方案已上线。

Firsto 路由接入前还需验证其确切 ABI、信任地址/升级实现、费用去向、NFT 接收方式、旧矿工收益归属，以及签名撤销、过期、价格变化与交易回滚。不能开放任意地址/任意 calldata 花费资金池的钱。

本轮只做公开数据读取和本机代码验证，没有使用真实钱包或广播主网交易。公开 RPC 的带状态覆盖 eth_call 未成功；两次本地 fork 尝试分别遇到缺失历史 trie 和需付费 archive token，因此本轮没有成功的 Firsto 全流程成交模拟。该限制已记录，不能用失败的模拟证明手续费行为。

## 来源与复核文件

- [TapeOut 官网](https://tapeout.net/)；[当前官网市场前端](https://tapeout.net/assets/CircuitMarket-BTz8BcLl.js)；[官网合约 ABI](https://tapeout.net/assets/artifacts-BZhnQij0.js)。
- [Firsto 矿机市场](https://tapeout.firsto.ai/circuits)；[当前 Firsto 前端](https://tapeout.firsto.ai/assets/index-DEbR7oA_.js)。重点函数 `FD`、`OD` 和 `buyOfficialCircuit` 校验分支。
- 官网固定块结算探针：`contracts/test/fork/MarketProbe.t.sol`。
- 本轮链上只读结果：`deploy/evidence/procurement-fees-2026-09-26.json`。
- 脱除可执行签名后的报价及前端哈希：`deploy/evidence/procurement-quotes-2026-09-26.json`。
- 模拟受限记录：`deploy/evidence/procurement-fees-local-simulation-2026-09-26.json`。
- 可重跑只读脚本：`cd deploy && node scripts/inspect-procurement.mjs`。通过 `LISTING_ID` 指定其他官网订单；可选 `--simulate` 仅发 eth_call，不签名、不广播；RPC 不支持时只记录不可用。
