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
| 两套出售通知索引器沿用旧的“折价至少 60 份”门槛，与当前合约双过半不一致 | `deploy/server/chain-index/notifications.mjs`、`portfolio-notifications.mjs` 与各自测试 | 折价与非折价均按持有人过半、份额至少 51/100 判定通过；折价成交仍须单独通过管理员审核，通知不能把投票通过误报为已挂牌或已成交 |
| 预算项目索引器只认首个出售候选，第二个合法候选会使整页通知失败 | `deploy/server/chain-index/portfolio-notifications.mjs` 与多候选回放测试 | 同轮最多 16 个候选共用截止时间和持仓快照；各候选独立投票，非首个候选可执行；执行后整轮关闭，异常历史仍拒绝 |

## 新合约旧审计项分类

- **源码已有修复，链上未复验**：预算子池提案覆盖和外部 `cancelExpired()` 后冻结（`BudgetPortfolioVault.sol`）；1 wei 预充值执行器阻断（`FirstoSaleExecutor.sol`）；单机出售投票与成交的双过半口径（`SaleGovernance.sol`、`SaleSettlement.sol`）；零价份额挂牌（`ShareMarket.sol`）；子池采购尾差（`PoolFunds.sol`）；锁单后的 BEM 抢领（`BudgetPortfolioVault.sol`）；Gas 钱包未经管理员签名的任意支出（`PlatformAuthority.sol`）。不把这些源码修复误称为已上线链上合约。
- **仍存且需协议层决定**：严格 Mining `claim` 持续失败会阻断份额转让与整机出售（`PoolVault.sol:562-565`、`MiningOperations.sol:59-97`）。市场参考价需管理员在 15 分钟内更新，停更会阻断出售（`SaleGovernance.sol:208-215`、`BudgetPortfolioVault.sol:478-485`）。任一管理员可独自审核与领取全部手续费是用户已确认的权限安排，不能误记为待改的双签或均分。
- **跨版本独立性的运营边界**：新旧 Factory 各自只认自己的矿机登记，同一 NFT/编号可能在两个系统分别登记。新图不应在合约中调用旧 Factory；建池前需独立核对 NFT 所有权、原挂单与旧池占用。
- **体积余量**：v4 实际部署的 `FreshPoolFactory` 运行时代码约 23,454 B，距 EIP-170 的 24,576 B 上限尚有 1,122 B。产物中的基类 `PoolFactory` 为 24,516 B，仅余 60 B，但不是这次新图实际部署的 Factory。后续改动仍须逐次核对实际部署合约的运行时代码长度。
- **旧升级专属**：旧 Factory 停建、PoolLens 旧版升级批次、旧 v2 页面只适用于原升级路线；不得拿它们作为 v4 新合约部署的前置依赖。

## 正式开放前的阻断项

1. **第二阶段恢复**：任一已广播权限交易链上失败、取消或异载荷替换后，现有 `aborted` 记录不可继续；已确认的前缀权限变更不会回滚。必须保留不可变尝试历史、核验最终回执与同 nonce 赢家、在稳定区块复核两套 Factory/Authority/Timelock 当前角色，再准许新 nonce 手动重试相同动作。覆盖第 3 与第 7 笔失败、链重组、未知哈希、双页并发、保存失败和 Gas 预算。不能仅清空浏览器或服务器记录。
2. **独立产品交付**：现有 fresh 包只含部署台；产品草案指向的 chain-index 和 purchase-supervisor 不在此包，`/bemine-v4/` 也没有已部署代码。产品 API 在 `journal-api.mjs:278` 仍主动拦截 fresh Authority 图下的交易，开放前需新产品服务、独立索引、受审核代发及真实端到端链上流程，不能简单删掉门禁。
3. **产品钱包格式与最终性**：`journal-api.mjs:1472-1493` 的未来产品交易响应仍为 `gasPrice`/type 0，需按同钱包兼容性处理；`product-graph.mjs:184-245` 验证权限证据时还需独立最终性锚。未完成前不要开启市场交易。
4. **自动化容错**：挖矿 keeper 的 `estimateGas` 失败可能把 RPC 429/超时误判为业务需人工处理，supervisor 一池异常可能停止整个循环（`mining-keeper.mjs:244-258`、`mining-supervisor.mjs:89-124`）；购机 supervisor 对未知结果会停止（`purchase-supervisor.mjs:103,153`）。开放自动挖矿/购机前要做隔离、退避与恢复测试。
5. **显示与操作体验**：本轮已把部署台的 Gas 余额、预算及已花费金额统一为五位小数；底层交易仍使用精确 wei。产品页面尚未部署，无法按“所有页面”验收。极小非零金额若五位显示为零，仍须可查精确原值。
6. **通知索引尚未投入 v4 生产**：上述折价投票门槛及预算项目多候选重放已在源码和专项测试中修正，但当前线上只有部署台；正式产品包须包含修正后的两套索引器及其独立数据库，并从 v4 合约事件重建，不能复用旧版已计算的通知快照。
7. **折价审核状态未接入预算产品**：合约提供 `ChildSaleReviewed`/`childSaleReview`，单机市场提供 `SaleReviewed`/`saleReview`；现有链上索引事件列表遗漏两种审核事件，预算通知不展示批准或驳回状态。预算项目执行按钮只看投票，预览未读取当时市场参考价和审核结果，未审核或已驳回的折价交易会送入钱包后再被合约拒绝（`deploy/server/chain-index/indexer.mjs:38-48`、`portfolio-notifications.mjs`、`web/components/LivePortfolios.jsx:196-201`、`web/lib/live-portfolios.mjs:297-301`）。产品开放前要补链上审核状态、执行前门禁及相应测试；不能因投票通过而显示“已批准挂牌”。

## 验收顺序

先以当前源码重新生成部署 JSON 和 fresh 页面，并核对 bundle 所嵌摘要、清单哈希、合约体积与测试；随后只更新空日志的 v4 预部署服务，复核 v4 URL、旧 v2 URL、产品 404 和两个写入暂停标志。第一阶段可由所选 MetaMask 钱包逐笔签名；第二阶段须等上述恢复机制通过测试后另发包解除暂停。最后单独构建并验收 v4 产品与后端，不能复用旧合约、旧索引、旧市场记录或仅凭部署台正常就开放资金操作。

旧升级路径的 `deploy/src/upgrade-release.test.ts` 依赖一份冻结的 `/bemine-v2/` 静态导出；当前 `web/out/index.html` 已不含该测试固定的旧 app chunk，单独运行会在夹具加载时失败。这不表示 v4 新图合约测试失败，但也不能据 v4 测试宣称旧升级路径通过。旧产品和旧升级功能应单独复核，不作为新图部署的前置依赖。

## 本次控制台发布实测（2026-09-29 02:49 UTC）

- 源码提交 `5ff529ae42f85fa0c29aca402faafad37349aad5` 生成 21 份部署产物，`npm run artifacts:check` 通过；fresh 构建 68 文件且旧页面入口排除检查通过。单机、预算项目合约的针对性 Foundry 测试此前分别为 38/38、27/27；本轮没有完成全量 Foundry 测试，不据此宣称全量通过。
- 服务器/索引测试 412/412，通过；部署、交易恢复、接线与五位小数的针对性前端测试 32/32，通过。旧升级发布测试因上述冻结导出夹具不匹配而失败，属于旧路径未通过验证。
- 独立 v4 预部署服务更新到 `v4-audit-5ff529a`；发布包 SHA-256 为 `7fddcebb712e20b8056809c365530f6b23267ab73ebd84d391c3f9abbf811e96`，线上部署产物 SHA-256 与发布包同为 `88eb8ecfc04711f96cb367e78eba5044f69f915a7c5c0f38e12b5f0f1d2b9b68`。v4 控制台 HTTP 200、v4 产品 HTTP 404、旧 v2 产品 HTTP 200；预部署和第二阶段暂停标志均启用，v4 五张日志表仍全为 0 行，服务为 active。

## 第三轮审计后更新（2026-09-29 19:40 CST）

- 当前独立 v4 源码位于 `codex/independent-fresh-deploy`，经第三轮问题修正并重新钉扎部署产物；部署 JSON 摘要为 `0xbac20f96a1476eeb7911d5f35abc78320f8339eebf10169a8d034fe797b2f88e`。PR #32 当前提交 `e23e743` 的两组 contracts、deployment-console、fork CI 均通过；Slither 中危门槛及固定区块 fork 检查也通过。
- 线上仅更新独立的 **v4 预创世部署台**：release `v4-audit-99b47b9`，公开部署产物 SHA-256 `c29aa2241fa5ce5d6dd6badecf81bcc6614865b25d3727d3ef27aa0f3a8dd94b`。`/pinkuang-deploy-v4/` 返回 200，`/bemine-v4/` 仍返回 404。v4 的九张业务日志表均为 0 行，不能据此声称已部署链上合约或开放产品。
- 旧 `/pinkuang-deploy-v2/` 和 `/pinkuang-upgrade-v2/` 已分别改为 410；`/bemine-v2/` 仍返回 200。两个旧入口的变更各有独立守卫和备份，没有改动旧产品的合约地址、索引或购机服务。
- 预创世服务仍保持 `BEMINE_FRESH_CONSOLE_PRE_GENESIS=1`、`BEMINE_FRESH_STAGE2_HOLD=1`、`AUTHORITY_RELAY_ENABLED=0`，仅记录用户指定 Gas 钱包 `0xA285d1933e32b5990625ac1f5bea205cf2606619` 的公开地址；v4 签名服务未启用，不持有该钱包私钥。用户指定复用此旧 Gas 钱包的决定已记录，但历史暴露与跨版本 nonce 风险不会因余额小而消失。
- 当前 v2 索引追块期间的 503 和旧站页面读数问题属于**独立 v2 修复**。候选索引补丁在复核中发现错误链及历史不完整时仍可能展示旧快照，并把代理健康状态误报为正常；该补丁已暂停上线，待边界和联合测试修复。不能用 v4 的发布包覆盖旧站来绕过此问题。
- 仍阻断正式开放：硬件钱包须亲自完成 v4 首阶段部署和链上回执核验；第二阶段权限交易恢复与独立签名服务需另行验证；v4 产品站、独立索引、自动购机和矿机实际所有权核对尚未投入生产。这里的“部署台可用”仅表示可以从钱包发起第一阶段。
