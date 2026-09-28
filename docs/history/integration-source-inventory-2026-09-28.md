> 历史基线盘点：以下记录整合前的源码状态和缺口，不是交付状态。最新业务决定、修复和测试结果以 ../INTEGRATION_HANDOFF.md 及 ../frontend-completeness-2026-09-28.md 为准。

# 两仓完整分支盘点与统一发布依赖

检查时间：2026-09-28T00:33:11.478355+00:00。通过公开 GitHub REST 获取两仓元信息、全部 branches、全部状态 PR，保存原始分页结果；两仓均一页返回且无 next，完整性标记均为 true。随后只读读取本地已存在的对应 Git 对象建立祖先图，没有 checkout 覆盖、合并、代码修改、签名或生产发布。

## 仓库与变化

| 仓库 | 默认分支 | 分支数 | 本仓 PR 数 |
|---|---|---:|---:|
| [jianfengliao774-sketch/pinkuang](https://github.com/jianfengliao774-sketch/pinkuang) | main @ 537100f | 26 | 28 |
| [cbt2r222hd-oss/pinkuang](https://github.com/cbt2r222hd-oss/pinkuang) | main @ 537100f | 13 | 0 |

两仓合计 39 个分支名、31 个不同 head。与上一轮已保存分支及本地远端引用比较，**本轮没有新增或变化的 head，也没有 PR head 更新**。朋友仓 PR 数 0 不意味着朋友代码没有 PR：其通知和分享 PR 开在主仓。

两仓 `main` 都是 `537100fa4d224298de3a206e03b1c4ae21556a16`，提交名 `chore: initialize TapeOut repository`，该提交 tree 为空。不能只克隆默认分支便认为项目没有代码；也不能直接把 main 当最新集成版本。

31 个 head 中有 5 个不能被另一个现存 head 的 Git 历史完全包含：主业务 5f160c5，以及下列 4 条分叉。其余分支已在主业务或其他顶端分支的祖先路径内；这只证明提交被包含，不证明业务规则未被后续修改。

## 必须单独整合的四条非祖先分支

| 来源 | head | 与 5f160c5 不共享的提交 | 从共同祖先产生的净改动 | 归类与保留方式 |
|---|---|---:|---:|---|
| 朋友 codex/telegram-notifications | a26ed25 | 2 | 31 文件 | 完整钱包绑定 Telegram 通知、私有通知索引、队列/加密存储/重试、前端收件箱、配置脚本与测试。主仓未含，生产已择取通知增量；需要逐块合并，保留主仓新增交易保护 |
| 主仓 codex/formal-market-test | c2ab168 | 7 | 11 文件 | 独立真实市场测试入口、Firsto 只读报价板、份额日产能价、数据重试与独立发布说明。保留行情/估价能力，升级其旧 ABI/配置，不整树覆盖新主仓 |
| 朋友 codex/bemine-live-share | 3ca2423 | 4 | 93 文件 | 品牌海报、9 海报×18 文案随机分享、正式/演示分享隔离、认购确认回执后分享、移动适配。其 64 个变更文件已与主仓 blob 完全相同，剩余 29 个多为后续版本发生变化的业务文件/文档；逐功能检查，不把 93 文件都视作未合并新功能 |
| 朋友 codex/bemine-design-v7 | 3c23ec6 | 1 | 37 文件 | v8 无销毁/领取时限文案调整、手机审查册、历史意见导出、审查生成器和旧路由迁移。主要是历史设计/验收工具，应归档保留设计与反馈，不把旧演示资金逻辑覆盖当前交易实现 |

每个分叉的完整提交、逐文件增删改、Git blob 对比、类别及是否已在主仓以相同内容存在均见 `repository-map.json`。不同 blob 只能说明内容不同，不能直接判定一个版本缺功能；例如旧分享分支 journal 已被后续 nonce 恢复和协议保护扩展，回退旧文件会丢失修复。

容易遗漏的点：朋友 `codex/bemine-more-services` @ 19a5fe3 与设计基础已进入后续主仓历史；无需再整个覆盖。正式测试分支独有 `FirstoMarketBoard.jsx`、`firsto-market-board.mjs`、`share-daily-capacity.mjs`，应列入统一产品清单。通知分支修改 `journal-api.mjs`、`indexer.mjs`、`LivePlatform.jsx` 等与新业务都修改的文件，需把通知接口合到新保护逻辑上，不能只选最后修改时间。

## 建议冻结的整合源集合

1. 以主仓 `codex/auto-mining-keeper@5f160c579e9d3d382df199cb29dc1573f5ae992e` 作为当前功能基线，保留完整审计修复、Firsto 买入、永久去重、双边份额费用、治理、运营选机、预算项目、挖矿 keeper 和财政归集源码。
2. 将朋友 `a26ed25` 的通知功能作为独立模块并入，逐处解决路由、index schema、环境配置、ABI、Factory 与用户会话绑定。
3. 从 `c2ab168` 提取真实市场报价和份额日产能价；保留正式、演示、独立测试三个入口边界。旧稿的 `/bemine-test/` 重定向说明属于历史发布资料，发布前仍要以服务器现场配置为准。
4. 对 `3ca2423` 和 `3c23ec6` 保留原始分支/报告，按功能核对分享、移动、审查意见导出和旧链接。已由新源码承接的功能登记为已包含；落后的费率、一个矿机可多次建项目、演示预付比例等文案按当前用户规则重写。
5. 新统一发布以独立版本清单明确来源 commit 和每个模块 hash。用户说三台电脑都已推到这两仓，本轮据此把仓库作为可审查来源；不能从作者或提交时间反推具体电脑，也不声称读取了未上传的本机文件。

## 重写必须保留的部署与后台能力

| 能力 | 保留要求 | 主要现有文件/来源 |
|---|---|---|
| 原子部署与代码身份 | 一次初始化治理、代理、Beacon、Lens/Market绑定；可信编译产物、库链接与 immutable 核验；总 Gas 与价格上限 | `deploy/src/deployment.ts`、`contracts/src/AtomicDeployment.sol`、`deploy/scripts/build-artifacts.mjs` |
| 初始化与续部署恢复 | nonce 发送前双核对；同 nonce 原始/加速/取消历史保留；规范区块+finalized；钱包封装初始化独立证明；复用已验收库，不重复部署 | `deploy/shared/initialization-proof.mjs`、`deploy/src/*journal*`、`deploy/server/journal-api.mjs` |
| 持久交易日志 | 钱包登录挑战、Origin/Cookie边界、服务端 ACK 后单次授权、revision、防并发签名、未知发送结果停止；日志可恢复归档 | `journal-store.mjs`、`journal-api.mjs`、`JOURNAL.md` |
| 版本与角色 | 前端静态 ABI、后台白名单、产物摘要、部署清单、真实 runtime/implementation、一致 chainId、Factory回指、operator/treasury/owner与48h治理 | `product-graph.mjs`、`firsto-upgrade-proof.mjs`、`verify-firsto-upgrade.mjs` |
| 索引 | 从真实部署块扫描、分页/稳定区块、完整性/新鲜度、重组回滚、历史权益不因份额清零而消失、读失败不可冒充零数据 | `deploy/server/chain-index/*`，加通知私有索引 |
| 只读代理与报价 | 公共RPC只允许读；Firsto固定来源/路由/尺寸/超时/并发；官网全量有界发现，来源与区块绑定 | `live-data-proxy.mjs`、`firsto-proxy.mjs`、`official-market-discovery.mjs` |
| 自动采购 | 默认只读，显式 send+私有journal；官网优先后 Firsto fallback；订单/fee/nonce/质量/登记/预算每次复核；先落盘再广播；单钱包执行与恢复 | `purchase-keeper.mjs`、Firsto 校验模块 |
| 自动挖矿 | Factory发现新池、逐池状态日志、证明与协议状态核验、arm/start时序、冷却、单钱包nonce协调、异常停下 | `mining-supervisor.mjs`、`mining-keeper.mjs`、`mining-proofs.mjs` |
| 收费归集 | treasury链上身份、BNB owed真实额度、Gas净额与总预算、同类恢复journal；BEM harvest与BNB提款分开记账 | `treasury-collector.mjs` |
| 可选通知 | 钱包二次确认绑定、密钥文件权限、加密存储、私有持有人索引、快照投票提醒、租约/重试/解绑；不得替用户签交易 | 朋友 `deploy/server/notifications/*`、`chain-index/notifications.mjs`、通知前端 |
| 分享和多端钱包 | 成功回执证明后显示认购成功；演示绝不伪造链上结果；移动端/多钱包弹窗、图标、状态切换与防重复交互 | 主仓已有 UI + 朋友分享/设计报告 |

这些是必须延续的保护和功能，不要求照搬旧函数名或旧模块切分。重写后的接口发生变化时，对应日志、索引、回执匹配、模拟与恢复都必须一起更新。

## 新合约与统一部署页的依赖清单

- **编译与产物**：现有 Node 24、Solidity 0.8.24、optimizer 200、Shanghai、viaIR=false、OpenZeppelin 5.0.2 和锁文件是当前基线；重新设计时若变更须明确记录。重新独立编译完整源码、ABI、链接/immutable引用、代码大小和存储布局；不能手改产物摘要躲过检查。
- **单机基础**：8 个业务库、PoolVault、PoolFactory、ShareMarket、AtomicDeployment、PoolBeacon、PoolTimelock、ERC1967Proxy、PoolLens 及其全部角色与回指。现有浏览器流程是旧单机图的 13 步，不能给它换标题便说全部新功能已部署。
- **预算项目**：`BudgetPortfolioFactory`、`BudgetPortfolioVault`、`TransferableBemRewards` 以及该项目的治理/Beacon/代理拓扑、子池Factory关联、共同100份、未领BEM随份额转移、剩余款/售款固定归属、底层子池唯一登记。前两项虽已经加入生成产物，**现有 AtomicDeployment/部署台未涵盖预算项目完整上线图**；需要补齐部署、验证、清单、journal action、index发现、Lens/前端读取和市场适配。
- **预算采购**：官网完整候选已有读取器；Firsto 全量发现及逐笔同区块签名可执行性尚未接通多机规划器。不能拿一页低价列表当全量覆盖，也不能复用单机 keeper 就宣称预算自动买满。需逐台原子交易、跨市场/跨项目永久唯一性、单台与总预算上限、截止结算和部分失败恢复。
- **Firsto 卖方接口**：用户目标为 Firsto 原生外部挂单、BNB 售款回矿池。5f160c5 最新提交修改的 `docs/firsto-exclusive-sale-2026-09-28.md` 明确要求每个实际成交入口在过户前严格结清 BEM、归池并记入成员权益。预算文档以及出售文档验收列表还残留“挂单后新增收益归买家”的旧句，属于必须统一的文档冲突，不能据此取消严格结清。需要合约卖家 ERC-1271/授权或经证实的 Firsto 路由适配、精确NFT/price/nonce/expiry/payoutRecipient绑定、仅有效治理授权可卖、撤单/过期/成交识别、售款进入合约后 1%/99%及成员权益记账。当前 V2 直购不主动claim，ERC-1271 验签不能视作可写状态领取入口；必须验证兼容的官方成交路径，不能只靠挂单前领一次满足成交前清零。当前内部 `completeSale` / 拒收 BNB / `settleSale` 拒绝的旧逻辑不能直接支持外部售卖目标。
- **新部署清单**：必须覆盖上述每个真实部署节点与外部协议依赖，chainId、初始化/创建交易、blockHash、codehash、implementation、Beacon、owner/operator/treasury、费率、唯一登记域、Factory whitelist、功能版本全部匹配。若新旧Factory并存，永久唯一性不能各管各形成重复；旧用户资产和旧日志仍需可读可恢复。
- **迁移和不可变版本记录**：旧地址的运行实现与旧清单是旧版本；新部署不能覆盖它们的 sourceCommit、历史价格、nonce或回执。升级则需原子批次和48h治理、存储兼容、旧池/订单迁移证明。当前自动Firsto升级证明只覆盖空历史池情形，不能扩展宣称预算/卖方新架构自动适用。
- **发布环境**：继续现有 Linux 服务+HTTPS精确前缀，用户已拒绝容器。静态网页、部署台、journal、index、候选读取器、keepers、通知worker要有共同release清单但独立进程/持久目录；密钥只在服务器私有文件或进程环境，公开仓库只放变量名和样例。
- **统一启用验收**：官网与Firsto购买必须测试真实协议合约调用、NFT确实进入子池；预算资金/权益守恒；Firsto原生外部订单成交和售款入池；低价治理、投票锁定、份额买卖1%+1%、未领BEM转移、退款与售款不转移；多钱包、并发nonce、未知回执、取消/加速、重组、重启恢复、索引及通知完整链路。源码/CI存在不代表生产已经启用。

## 完整分支表

“已包含”表示该分支 head 是 5f160c5 的祖先；“基线”表示它自身；“独立”表示仍有主基线以外提交。默认分支明确登记。

| 仓库 | 分支 | head | 相对主基线 | 默认 |
|---|---|---|---|---|
| 主仓 | `codex/audit-remediation` | `200e544` | 已包含 |  |
| 主仓 | `codex/auto-mining-keeper` | `5f160c5` | 基线 |  |
| 主仓 | `codex/bemine-mainnet-live` | `be9e48f` | 已包含 |  |
| 主仓 | `codex/bnb-three-decimals` | `0e92319` | 已包含 |  |
| 主仓 | `codex/budget-multi-miner-pool` | `bb48f0c` | 已包含 |  |
| 主仓 | `codex/deploy-console` | `915dad3` | 已包含 |  |
| 主仓 | `codex/deployment-page` | `44a5db7` | 已包含 |  |
| 主仓 | `codex/firsto-contract-purchase` | `1c65f27` | 已包含 |  |
| 主仓 | `codex/firsto-frontend-integration` | `a5e8162` | 已包含 |  |
| 主仓 | `codex/formal-market-test` | `c2ab168` | 独立 |  |
| 主仓 | `codex/frontend-contracts` | `43c5c02` | 已包含 |  |
| 主仓 | `codex/frontend-data-backend` | `cc8a8df` | 已包含 |  |
| 主仓 | `codex/frontend-readiness` | `b4c8a7c` | 已包含 |  |
| 主仓 | `codex/official-first-purchase` | `8493cda` | 已包含 |  |
| 主仓 | `codex/onchain-governance-voting` | `b680a0d` | 已包含 |  |
| 主仓 | `codex/operator-miner-selection` | `3a5a952` | 已包含 |  |
| 主仓 | `codex/pure-verified-purchases` | `82e6066` | 已包含 |  |
| 主仓 | `codex/share-market-dual-fee` | `ad8a4e3` | 已包含 |  |
| 主仓 | `codex/t0-1-bootstrap` | `8873da4` | 已包含 |  |
| 主仓 | `codex/t0-2-protocol-probe` | `c678219` | 已包含 |  |
| 主仓 | `codex/t1a-funding-refunds` | `12f5b28` | 已包含 |  |
| 主仓 | `codex/t1b-atomic-purchase` | `951fdee` | 已包含 |  |
| 主仓 | `codex/t1c-mining-rewards` | `1e015e9` | 已包含 |  |
| 主仓 | `codex/t1d-share-market` | `1372fef` | 已包含 |  |
| 主仓 | `codex/t1e-voting-sale` | `7954c77` | 已包含 |  |
| 主仓 | `main` | `537100f` | 已包含 | 是 |
| 朋友仓 | `codex/bemine-design-v7` | `3c23ec6` | 独立 |  |
| 朋友仓 | `codex/bemine-live-share` | `3ca2423` | 独立 |  |
| 朋友仓 | `codex/bemine-more-services` | `19a5fe3` | 已包含 |  |
| 朋友仓 | `codex/deploy-console` | `8ce9535` | 已包含 |  |
| 朋友仓 | `codex/t0-1-bootstrap` | `8873da4` | 已包含 |  |
| 朋友仓 | `codex/t0-2-protocol-probe` | `c678219` | 已包含 |  |
| 朋友仓 | `codex/t1a-funding-refunds` | `12f5b28` | 已包含 |  |
| 朋友仓 | `codex/t1b-atomic-purchase` | `951fdee` | 已包含 |  |
| 朋友仓 | `codex/t1c-mining-rewards` | `1e015e9` | 已包含 |  |
| 朋友仓 | `codex/t1d-share-market` | `1372fef` | 已包含 |  |
| 朋友仓 | `codex/t1e-voting-sale` | `7954c77` | 已包含 |  |
| 朋友仓 | `codex/telegram-notifications` | `a26ed25` | 独立 |  |
| 朋友仓 | `main` | `537100f` | 已包含 | 是 |

## 全部 PR 对照

以下是本次公开 API 的全部状态 PR；没有把已关闭、草稿、朋友发往主仓的 PR 丢弃。PR状态不是完整集成/生产部署的证据。

| PR | 标题 | 状态 | head / base |
|---|---|---|---|
| [#28](https://github.com/jianfengliao774-sketch/pinkuang/pull/28) | Auto-restart stopped pool miners with proof-backed keeper | open / draft | `codex/auto-mining-keeper@5f160c5` → `codex/pure-verified-purchases` |
| [#27](https://github.com/jianfengliao774-sketch/pinkuang/pull/27) | 拒绝购入最优或未验证矿机 | open / draft | `codex/pure-verified-purchases@82e6066` → `codex/budget-multi-miner-pool` |
| [#26](https://github.com/jianfengliao774-sketch/pinkuang/pull/26) | feat: 接入拼矿 Telegram 通知与钱包绑定 | open / draft | `codex/telegram-notifications@a26ed25` → `codex/operator-miner-selection` |
| [#25](https://github.com/jianfengliao774-sketch/pinkuang/pull/25) | 固定预算多矿机项目：可升级合约与随份额转移的 BEM 收益 | open / draft | `codex/budget-multi-miner-pool@bb48f0c` → `codex/operator-miner-selection` |
| [#24](https://github.com/jianfengliao774-sketch/pinkuang/pull/24) | 运营选机支持链上核验并显示日产能价 | open / draft | `codex/operator-miner-selection@3a5a952` → `codex/onchain-governance-voting` |
| [#23](https://github.com/jianfengliao774-sketch/pinkuang/pull/23) | Route preview governance voting to on-chain proposals | open / draft | `codex/onchain-governance-voting@b680a0d` → `codex/share-market-dual-fee` |
| [#22](https://github.com/jianfengliao774-sketch/pinkuang/pull/22) | Charge buyer and seller 1% on share market fills | open / draft | `codex/share-market-dual-fee@ad8a4e3` → `codex/official-first-purchase` |
| [#21](https://github.com/jianfengliao774-sketch/pinkuang/pull/21) | feat: 官网矿机优先采购，官网无合格挂单再查 Firsto | open / draft | `codex/official-first-purchase@8493cda` → `codex/firsto-frontend-integration` |
| [#20](https://github.com/jianfengliao774-sketch/pinkuang/pull/20) | Show live daily capacity prices on separate BSC test page | open / draft | `codex/formal-market-test@c2ab168` → `codex/bnb-three-decimals` |
| [#19](https://github.com/jianfengliao774-sketch/pinkuang/pull/19) | test: 合并 Firsto 采购与页面修复并记录主网验收边界 | open / draft | `codex/firsto-frontend-integration@a5e8162` → `codex/frontend-readiness` |
| [#18](https://github.com/jianfengliao774-sketch/pinkuang/pull/18) | fix: 恢复失败后的页面加载并缩短链上读取等待 | open / draft | `codex/frontend-readiness@b4c8a7c` → `codex/bnb-three-decimals` |
| [#17](https://github.com/jianfengliao774-sketch/pinkuang/pull/17) | fix: 合并最新前端设计并将募集总额保留三位 BNB 小数 | open / draft | `codex/bnb-three-decimals@0e92319` → `codex/bemine-mainnet-live` |
| [#16](https://github.com/jianfengliao774-sketch/pinkuang/pull/16) | feat: 合约执行 Firsto 购机并永久限制同矿机单项目 | open / draft | `codex/firsto-contract-purchase@1c65f27` → `codex/bemine-mainnet-live` |
| [#15](https://github.com/jianfengliao774-sketch/pinkuang/pull/15) | 接入 BEMine 主网主页、运营建池与安全交易恢复 | open / draft | `codex/bemine-mainnet-live@be9e48f` → `codex/audit-remediation` |
| [#14](https://github.com/jianfengliao774-sketch/pinkuang/pull/14) | Fix audited governance and connect verified live trading | open | `codex/audit-remediation@200e544` → `codex/deployment-page` |
| [#13](https://github.com/jianfengliao774-sketch/pinkuang/pull/13) | 接入拼矿产品页与链上交易，并增加认购确认后的分享邀请 | open / draft | `codex/bemine-live-share@3ca2423` → `codex/deployment-page` |
| [#12](https://github.com/jianfengliao774-sketch/pinkuang/pull/12) | Finish BSC deployment console and product entry | open | `codex/deployment-page@44a5db7` → `codex/frontend-data-backend` |
| [#11](https://github.com/jianfengliao774-sketch/pinkuang/pull/11) | feat: persist chain data and wallet journals; permit 100-share ownership | open / draft | `codex/frontend-data-backend@cc8a8df` → `codex/frontend-contracts` |
| [#10](https://github.com/jianfengliao774-sketch/pinkuang/pull/10) | fix: atomic sale voting and finalized transaction recovery | open / draft | `codex/frontend-contracts@43c5c02` → `codex/deploy-console` |
| [#9](https://github.com/jianfengliao774-sketch/pinkuang/pull/9) | feat(web): add BEMine preview with updated reward rules and mobile review | open / draft | `codex/bemine-design-v7@3c23ec6` → `codex/deploy-console` |
| [#8](https://github.com/jianfengliao774-sketch/pinkuang/pull/8) | feat: BSC deployment console, share market and audited procurement safeguards | open / draft | `codex/deploy-console@915dad3` → `codex/t1e-voting-sale` |
| [#7](https://github.com/jianfengliao774-sketch/pinkuang/pull/7) | T1e：双多数出售、受控交割与预算销毁 | open / draft | `codex/t1e-voting-sale@7954c77` → `codex/t1d-share-market` |
| [#6](https://github.com/jianfengliao774-sketch/pinkuang/pull/6) | T1d：份额转让、锁定挂单与 ShareMarket | open / draft | `codex/t1d-share-market@1372fef` → `codex/t1c-mining-rewards` |
| [#5](https://github.com/jianfengliao774-sketch/pinkuang/pull/5) | T1c：挖矿权限、BEM 分账与七日领取批次 | open / draft | `codex/t1c-mining-rewards@1e015e9` → `codex/t1b-atomic-purchase` |
| [#4](https://github.com/jianfengliao774-sketch/pinkuang/pull/4) | T1b：原子购机、成交前结清与购机余款领取 | open / draft | `codex/t1b-atomic-purchase@951fdee` → `codex/t1a-funding-refunds` |
| [#3](https://github.com/jianfengliao774-sketch/pinkuang/pull/3) | T1a：实现整数份额认购、退款与时间锁升级 | open / draft | `codex/t1a-funding-refunds@12f5b28` → `codex/t0-2-protocol-probe` |
| [#2](https://github.com/jianfengliao774-sketch/pinkuang/pull/2) | T0.2：固定区块验证 Q1–Q9 协议行为 | open / draft | `codex/t0-2-protocol-probe@c678219` → `codex/t0-1-bootstrap` |
| [#1](https://github.com/jianfengliao774-sketch/pinkuang/pull/1) | T0.1：初始化 Foundry 工程、协议地址与 CI | open / draft | `codex/t0-1-bootstrap@8873da4` → `main` |

## 证据与未覆盖项

`repositories-rest.json` 保留原始 repo元信息、branches与PR全部分页响应及查询时间；`repository-map.json` 保存结构化分支关系、默认分支、与前轮对比、各独立分支提交和逐文件分类。生成脚本同目录保存，均只读 Git/公开 REST。

本报告是完整分支范围的盘点和重写交接，不是重新逐行审计所有历史文件、重新执行所有测试或重新验收生产。已有深读细节见上一轮 `pinkuang-latest-read-20260928` 的 backend/contracts/frontend/root 报告与覆盖清单。新业务文档与历史发布命令作为资料；历史文档有旧地址、旧摘要、旧费率与旧业务规则，不能自动执行或提升为当前规则。
