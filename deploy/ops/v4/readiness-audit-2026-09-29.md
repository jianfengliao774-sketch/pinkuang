# v4 独立部署遗漏复核（2026-09-29）

范围：全新合约图、`/pinkuang-deploy-v4/` 预部署控制台及预期的独立产品开放。服务器旧审计 `/root/audit-reports/bemine-audit-2026-09-29.md` 和 `bemine-full-2026-09-29/` 针对较旧提交与旧站，以下结论均重新按当前源码和本机只读服务状态分类。此复核没有替用户签名、广播或部署合约。

## 当前运行状态

- `pinkuang-deploy-v4.service` 运行；v4 SQLite 中 `deployment`、`fresh_activation`、`deployment_archives`、`market`、`quotes` 均为 0 行。因此还没有可据此声称完成的 v4 第一阶段或第二阶段链上部署。
- `/bemine-v4/`、v4 产品索引和自动购机服务未上线；旧 `/bemine-v2/` 仍独立运行。部署台可访问只证明“可发起新部署”，并非“正式产品已上线”。
- 预部署单元保持 `AUTHORITY_RELAY_ENABLED=0`、通知关闭、独立 4177 端口和独立数据库。`BEMINE_FRESH_CONSOLE_PRE_GENESIS=1` 拦截产品写入，`BEMINE_FRESH_STAGE2_HOLD=1` 在失败交易恢复机制完成前拦截第二阶段写入。前端也不显示旧份额市场入口，并禁用第二阶段签名按钮。

## 本轮已修，仍需按新产物核验

| 问题 | 修复位置 | 核验重点 |
| --- | --- | --- |
| 单机和预算项目提案价可超过 Firsto `uint128` 订单上限，占住一轮却无法成交 | `contracts/src/libraries/SaleGovernance.sol`、`contracts/src/BudgetPortfolioVault.sol` | 边界价拒绝、正常价成功、合约运行时代码均小于 24,576 B |
| 部署台把旧版份额市场、报价页及浏览器旧交易记录带入新版本 | `deploy/src/App.tsx`、`deploy/scripts/assert-fresh-build.mjs` | fresh 包不含旧站 URL/升级页/旧市场迁移符号；非 fresh 旧站构建保持原路径 |
| 预部署服务允许旧市场和报价写入新 v4 SQLite | `deploy/server/journal-api.mjs`、`deploy/ops/v4/activate-console.remote.py` | 已认证请求的产品写入返回 409；部署和只读请求仍可用 |
| MetaMask 把请求包装成 EIP-7702 type 4 时，`gasPrice` 旧式封装被拒 | `deploy/src/deployment.ts`、`deploy/src/fresh-activation.ts` | 第一阶段 16 笔及第二阶段计划均改用动态费字段；保留独立 nonce、预算、回执和不明结果禁止重发核验 |
| 第二阶段失败/替换后缺少安全恢复，可能卡死已完成的权限变更 | 暂在 `FreshActivationPanel.tsx` 和服务端 `BEMINE_FRESH_STAGE2_HOLD=1` 按钮/写入双重暂停 | 这是临时停用而非恢复修复；开放前仍须做不可变尝试历史与当前链上权限证明 |

## 新合约旧审计项分类

- **源码已有修复，链上未复验**：预算子池提案覆盖和外部 `cancelExpired()` 后冻结（`BudgetPortfolioVault.sol`）；1 wei 预充值执行器阻断（`FirstoSaleExecutor.sol`）；单机出售投票与成交的双过半口径（`SaleGovernance.sol`、`SaleSettlement.sol`）；零价份额挂牌（`ShareMarket.sol`）；子池采购尾差（`PoolFunds.sol`）；锁单后的 BEM 抢领（`BudgetPortfolioVault.sol`）；Gas 钱包未经管理员签名的任意支出（`PlatformAuthority.sol`）。不把这些源码修复误称为已上线链上合约。
- **仍存且需协议层决定**：严格 Mining `claim` 持续失败会阻断份额转让与整机出售（`PoolVault.sol:562-565`、`MiningOperations.sol:59-97`）。市场参考价需管理员在 15 分钟内更新，停更会阻断出售（`SaleGovernance.sol:208-215`、`BudgetPortfolioVault.sol:478-485`）。任一管理员可独自审核与领取全部手续费是用户已确认的权限安排，不能误记为待改的双签或均分。
- **跨版本独立性的运营边界**：新旧 Factory 各自只认自己的矿机登记，同一 NFT/编号可能在两个系统分别登记。新图不应在合约中调用旧 Factory；建池前需独立核对 NFT 所有权、原挂单与旧池占用。
- **旧升级专属**：旧 Factory 停建、PoolLens 旧版升级批次、旧 v2 页面只适用于原升级路线；不得拿它们作为 v4 新合约部署的前置依赖。

## 正式开放前的阻断项

1. **第二阶段恢复**：任一已广播权限交易链上失败、取消或异载荷替换后，现有 `aborted` 记录不可继续；已确认的前缀权限变更不会回滚。必须保留不可变尝试历史、核验最终回执与同 nonce 赢家、在稳定区块复核两套 Factory/Authority/Timelock 当前角色，再准许新 nonce 手动重试相同动作。覆盖第 3 与第 7 笔失败、链重组、未知哈希、双页并发、保存失败和 Gas 预算。不能仅清空浏览器或服务器记录。
2. **独立产品交付**：现有 fresh 包只含部署台；产品草案指向的 chain-index 和 purchase-supervisor 不在此包，`/bemine-v4/` 也没有已部署代码。产品 API 在 `journal-api.mjs:278` 仍主动拦截 fresh Authority 图下的交易，开放前需新产品服务、独立索引、受审核代发及真实端到端链上流程，不能简单删掉门禁。
3. **产品钱包格式与最终性**：`journal-api.mjs:1472-1493` 的未来产品交易响应仍为 `gasPrice`/type 0，需按同钱包兼容性处理；`product-graph.mjs:184-245` 验证权限证据时还需独立最终性锚。未完成前不要开启市场交易。
4. **自动化容错**：挖矿 keeper 的 `estimateGas` 失败可能把 RPC 429/超时误判为业务需人工处理，supervisor 一池异常可能停止整个循环（`mining-keeper.mjs:244-258`、`mining-supervisor.mjs:89-124`）；购机 supervisor 对未知结果会停止（`purchase-supervisor.mjs:103,153`）。开放自动挖矿/购机前要做隔离、退避与恢复测试。
5. **显示与操作体验**：`deploy/src/display.ts` 仍是三位小数，用户要求所有金额五位尚未覆盖部署台。金额显示精度不得替代交易 wei 原值，极小非零金额应能查原值。产品页面尚未部署，无法按“所有页面”验收。

## 验收顺序

先以当前源码重新生成部署 JSON 和 fresh 页面，并核对 bundle 所嵌摘要、清单哈希、合约体积与测试；随后只更新空日志的 v4 预部署服务，复核 v4 URL、旧 v2 URL、产品 404 和两个写入暂停标志。第一阶段可由所选 MetaMask 钱包逐笔签名；第二阶段须等上述恢复机制通过测试后另发包解除暂停。最后单独构建并验收 v4 产品与后端，不能复用旧合约、旧索引、旧市场记录或仅凭部署台正常就开放资金操作。
