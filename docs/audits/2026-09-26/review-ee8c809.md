# `ee8c809` 追加审计：治理快照、交易恢复、报价分页

审查对象是本地 `codex/frontend-contracts` 分支的 `ee8c809`。本报告记录已确认的缺陷、条件性风险和已验证的边界；复现均使用本地 Forge、隔离 Anvil 或模拟接口，没有主网签名、转账或部署。本轮只添加审计测试和证据，**未修改生产合约或页面逻辑**。因此下列缺陷在该版本仍然存在，不能将此前测试通过理解为主网上线许可。

## 上线阻断：旧持有人可用交易前票权批准极低价卖矿机（高）

[SaleGovernance.sol](../../../contracts/src/libraries/SaleGovernance.sol) 的 `propose` 在第 74 行把快照时间设为 `block.timestamp - 1`，而份额交易冻结只在提案创建之后生效。提案当秒先完成的交易已经转移份额，新买家却没有该提案的票；旧持有人则保留交易前的票权。第 162–163 行的 60 份折价门槛和地址过半门槛都会按这个过期快照计算。

[本地复现](../../../contracts/test/audit/AuditGovernance.t.sol)使用真实 Vault 实现、ShareMarket 挂单与成交、提案、投票、出售和 NFT 过户：激活 7 日后，Alice/ Bob 在同一秒卖出共 74 份，买家支付 7.4 BNB；旧持有人当前仅余 1 份，却凭旧快照获得 75 票和 2/3 地址数，以 1 wei 通过整机出售，Alice 随即买走 NFT。两个新买家不能投票，只分到合计 1 wei 的售款。触发需要旧持有人在交易前拥有足够票权、仍有一人留份提案，并让成交先于同秒提案；不要求管理员权限。[复现日志](../../../deploy/evidence/review-ee8c809-governance.log)为 1/1 通过，证明了上述状态转换。

**修复要求：** 在提案调用内使用当时的份额和人数快照，并从该调用起冻结所有份额变更。当前时间戳的 checkpoint 与本合约的冻结路径可以实现原子边界，但 [PoolLens.sol](../../../contracts/src/PoolLens.sol) 第 388 行通过 `getPastShares` 读票，后者拒绝当前时间戳；修复必须同步处理 Lens 当秒查询。升级已有活动/Listed 提案时，还须单独判断旧快照提案，不能只修未来 `propose`。修复后要把本复现改为保护性回归测试，验证新买家具有对应表决权或旧持有人无法凭旧票执行出售，并跑全套合约、升级布局、产物和固定块分叉检查。在修复和重新审计前，不应让该版本承接主网募资。

## 确认缺陷：交易恢复与报价（中）

1. **部署交易已挖出，但钱包/RPC 未返回哈希时无法恢复。** [deployment.ts](../../../deploy/src/deployment.ts) 第 517–535 行先记录 `signing`，然后等待 `sendUncheckedTransaction` 返回哈希。若交易已广播且挖出，响应丢失会留下没有哈希的 `uncertain` 步骤；第 429–456 行的 `restore` 不会按账户、nonce、字节码或链上交易寻找该笔交易，`resume` 继续暂停。隔离 Anvil 复现实际支出 `691896000000000` wei Gas，记录仍为 `spentWei=0`，也无法继续部署。应提供只读、严格校验账户/nonce/to/data/value/合约代码与收据的哈希补录和撤销/替换恢复路径；未知结果不得自动重发。[复现测试](../../../deploy/audit/recovery.audit.ts)和[日志](../../../deploy/evidence/review-ee8c809-recovery.log)。
2. **份额市场钱包同 nonce 撤销后页面永久锁住。** [market.ts](../../../deploy/src/market.ts) 第 276–284 行只认原交易数据；同 nonce 的钱包撤销交易即使已 finalized，原哈希查不到，撤销哈希又被“不匹配”拒绝。[MarketPage.tsx](../../../deploy/src/MarketPage.tsx) 保留待确认记录，之后所有新市场操作在 `sendMarketAction` 第 245 行被拦。应以 finalized nonce 和替换交易回执核实原意图不可能再上链，提供明确取消记录入口；在终局未确定前继续暂停。[同一 Anvil 测试与日志](../../../deploy/audit/recovery.audit.ts)。
3. **市场页面一见一块收据就清除待确认记录。** [MarketPage.tsx](../../../deploy/src/MarketPage.tsx) 第 128–130 行不检查确认数/最终性。隔离 Anvil 先取到成功收据，再模拟回滚该区块，收据消失；此时页面原记录已可被清理。实际 BSC 重组是条件性风险，可能使用户按错误终局再次操作。应在足够确认或 finalized 且核对规范链后清记录，重组时继续追踪原 nonce。[复现日志](../../../deploy/evidence/review-ee8c809-recovery.log)。
4. **第 2 页及后续矿机报价无法精确查询。** [pricing.ts](../../../deploy/src/pricing.ts) 第 160 行把首页 `viewId` 带到后续分页，而 [firsto-proxy.mjs](../../../deploy/server/firsto-proxy.mjs) 第 15 行的固定来源参数白名单没有 `viewId`。第二页在代理即返回 HTTP 400，上游没有收到请求；目标矿机如果不在首页，无法确认报价并导出建池计划。应在代理对 `viewId` 做有界格式验证后放行，并保留跨页快照一致性检查。[复现测试](../../../deploy/scripts/audit-purchase-boundaries.test.mjs)和[日志](../../../deploy/evidence/review-ee8c809-purchase-boundaries.log)。

## 条件边界与覆盖结果

- [purchase-keeper.mjs](../../../deploy/scripts/purchase-keeper.mjs) 第 629 行收到 SIGTERM 后仅设置停止标志，当前周期仍可能在估 Gas 后签名并广播一笔。模拟中各发生一次，未触及真实网络。现有文档没有承诺立即停发；这是停机操作边界，若需要紧急停止，须在签名前及广播前再检查标志，并定义发出后等待终局的流程。
- 采购专项 12/12 通过，含两组各 256 次 fuzz；覆盖任务型号、验证权重、原机优先、逐台单位权重限价、退款与回调时回滚。[采购日志](../../../deploy/evidence/review-ee8c809-purchase-contracts.log)。没有在这些路径发现新的已确认越价购机漏洞；参考产能价本身仍由建池方输入，不是链上可信预言机。
- 独立的收益/资金模型三组各 128 次 fuzz 通过，覆盖转份前后归属、旧收益迁移、已领款与历史出售预算释放，未见重复支付或负债超过余额。[测试](../../../contracts/test/audit/AuditFunds.t.sol)与[日志](../../../deploy/evidence/review-ee8c809-funds.log)。有限测试不证明其他路径安全。
- [先前实施报告](frontend-contracts.md)记录的 364 项合约测试、52 项 BSC 固定块模拟及部署/页面产物检查属于此前同一源码版本的结果；本轮新增复现针对这些测试未覆盖的交易排序和异常恢复。没有重新执行完整 CI，也没有远端 CI 通过结论。
- 单钱包升级、无销毁、整机出售 1% 费用、严格结清后出售、参考产能价加默认 10% 可退预算均按用户确定的规则保留。单钱包权限集中和外部协议结清失败时可能卡住出售是已接受的设计边界。Firsto 直接采购及采购服务费分流、正式筹资业务页面仍未接入真实执行；见[实施报告的未交付边界](frontend-contracts.md)。

本报告的“高/中”按当前代码影响评定，未把模拟中的时间顺序或重组频率写成已在 BSC 主网实际发生。后续修复应以本报告的复现为失败用例，再以修复后的保护性断言、全套回归和源码产物重新绑定作为结案证据。
