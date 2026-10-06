# integrated-v2 主网测试准备核对

核对时间：2026-09-28 05:10 UTC 左右。本记录是仓库、公开网页和 BSC RPC 的只读核对；没有连接用户钱包、签名或发送交易。用户确认 16 笔部署已完成，实际链上图以本轮读取和[公开清单](../deployments/integrated-v2-frontend-manifest-20260928.json)为准。

## 已核对

| 范围 | 结果与证据 |
| --- | --- |
| 整合源码 | 核对时为 `codex/contracts-v2-integration@c90c255`，本报告随后以 `6c86e5a` 推送。PR [#29](https://github.com/jianfengliao774-sketch/pinkuang/pull/29) 保持 draft，已改为直接面向 `main` 的完整整合审阅入口。主仓 `main@537100f` 仍是初始化空树，尚未合并；现有旧 PR 为历史堆叠。 |
| 两仓来源 | 再次抓取主仓和协作仓所有远端 head；整合分支以外的四条非祖先分支仍为 `formal-market-test`、`telegram-notifications`、`bemine-live-share`、`bemine-design-v7`，与[来源清单](../history/integration-source-inventory-2026-09-28.md)相同，没有发现新的分支提交。其独有功能按统一交接逐项吸收或保留历史；不能直接把旧分支整体合入。 |
| 合约代码 | BSC 块 `124466199` 读取公开清单列出的十个合约地址；十项运行代码哈希均匹配清单。Factory/两个 ShareMarket/PortfolioFactory 的代理实现槽及两个 Beacon 的实现、owner 可读；Beacon owner 均为清单中的 Timelock。 |
| 当前工厂 | BSC 块 `124466222`：新 Factory `poolCount=0`、`creationPaused=false`、矿机登记 `initialized=true,ready=true`，BudgetPortfolioFactory `portfolioCount=0`、`creationPaused=false`，回指新 Factory、份额市场地址均匹配清单。旧 Factory `0xcB24E7F96D81037086A268d6ea63c53f91D412A2` 仍是 `poolCount=0`、**`creationPaused=false`**。 |
| 线上页面 | [v2 产品页](https://tapeout.cc.cd/bemine-v2/) 与 [v2 部署台](https://tapeout.cc.cd/pinkuang-deploy-v2/) 均返回 HTTP 200。产品页清单的 SHA-256 与仓库 `web/public/data/frontend-manifest.json` 同为 `5bf6596502e966de526e899c31d4bc71ef2a9a176e365bf75c0603a12c1b10ae`。实际浏览器加载完成后可见链上项目数 0、数据区块和可用的连接钱包按钮；预览页仍独立保留演示数据。 |
| 索引和只读数据 | 线上 `/bemine-v2/api/chain-index/health` 曾报告 `index_not_caught_up`；随后追至观察到的安全块并报告 `complete=true`。`/v1/stats` 在 05:10 UTC 返回 `registeredPoolCount=0`、`portfolioCount=0`，与链上相符。05:14 UTC 实际浏览器进入资产页显示「数据服务暂不可用（HTTP 503）」；连续 8 次、约 10 秒读取 `/v1/stats` 均为 503，索引停在 `124466816`、安全头 `124466843`。05:14:45 UTC 又恢复 `complete=true`。这是可复现的间歇性可用性问题，不能仅凭某次健康请求成功标为稳定。 |
| Firsto 价格与产能 | 用户截图中本站 `9.0255 BNB/(BEM/天)` 是**所选矿机的官网挂单价 ÷ 该机预计日产出**；Firsto 顶栏 `8.10` 是全市场参考值，口径不同。05:16:32 UTC 本站同源代理与 Firsto 原接口同时返回 `dailyCapacityPriceWei=8100000000000000000`、`sourceBlock=124467197`。此前直接按编号选择官网矿机时，为加快链上核价跳过 Firsto 报价，页面因此漏显预计日产出。源码现改为官网核验后异步读取同一矿机的产能，并核对 NFT 身份、持有人、任务、验证权重和来源时效；页面并排标注单机价与全市场参考价。线上仍需发布新版前端。 |
| 权限边界 | 产品页与部署台的 `/api/journal/build` 均在无钱包会话时返回 401。未代替真实登录、Cookie 签发或签名测试。 |
| 构建绑定和 CI | 本机 `deploy npm run artifacts:check` 与 `web node scripts/sync-contracts.mjs --check` 均通过，摘要 `0x7617c81d718e2127be6b1878abad81d7a3c8bf9c4f8cb35bf85755e42df049d7`。PR #29 最新提交的 contracts、deployment-console、fork 三项[CI](https://github.com/jianfengliao774-sketch/pinkuang/actions/runs/36380029399) 均通过。CI/fork 不是主网钱包成交证明。 |

## 仍需完成，按测试先后排序

1. **旧 Factory 停建。** 旧 owner 须用钱包对旧 Factory 调用 `pauseCreation(true)`，待回执确认后在同一新快照复核 `creationPaused=true`、`poolCount=0`。服务端[创建门禁](../../deploy/server/creation-cutover.mjs)在此之前应拒绝新图建池；不能为了测试关闭这项防重复登记保护。若旧 Factory 先出现池，零历史切换方案不再成立。
2. **稳定只读索引。** 页面会因索引落后几十块而出现 503，并在追平后恢复。最新源码 `c90c255` 已并行化四类全局日志读取并界定超时，但未取得线上索引进程实际运行提交的独立证据；应核对运行版本、日志延迟/错误及追块耗时，再对同一页面重复验收，不能仅凭健康状态短暂变绿解除问题。
   **报价页面发布。** 本次修复只改只读产能和价格口径展示，不改合约或购机金额。上线后需对同一矿机、同一时间分别核对官网挂单价、Firsto 预计日产出、单机日产能价和全市场参考价；当前线上版本尚未包含修复。
3. **真实钱包小额验收。** 新旧工厂目前都没有项目，所以尚无实际认购、撤回、官网或 Firsto 购机、父项目多机采购、收益归集/个人领取、份额双边费、链上投票、受控整机出售与 BNB 提款的主网交易证据。按[部署与测试顺序](../RELEASE_V2_START_HERE.md)逐笔由用户钱包确认并保存交易哈希；所有失败/竞态测试优先在本地 fork 或低金额受控场景做，不伪造主网完成状态。
4. **Firsto 原生页面挂单尚未交付。** 当前合约的 `completeFirstoSale` 在本站同笔先严格领取 BEM，再由一次性执行器调用 Firsto V2 成交；它不在 Firsto 网站发布长期可见的卖单。原生直购不会自动领取 BEM，不能绕开严格结清。若产品仍要求 Firsto 网站原生挂单，需单独设计、审计并升级合约；不把本站受控成交标为原生挂单。
5. **无人值守多机最优采购尚未交付。** 当前有固定预算、官网优先的持久分步采购队列，但统一交接明确 Firsto 全量多机发现和持久无人值守预算执行器仍未实现。用户可测试现有手动确认路径，不能声称已自动买遍市场最低价矿机。
6. **可选服务未开放。** WalletConnect 真机扫码缺公开 Project ID/真实配对验收；通知 bot、无人值守 keeper、质押和质保均非本次主网小额测试的已启用功能。
7. **仓库合并尚未完成。** PR #29 已直接面向 `main`，但仍是 draft；`main` 仍为空树。主网测试使用整合分支/已核验清单；完成钱包验收和处理上述产品差异后，再审阅合并这一个整合 PR，不能逐条旧 PR 盲目叠加部署版本。

## 多矿机项目入口核对

截图中的“指定矿机建池”和“灵活购机报价建池”均创建单台矿机池。已部署的 `BudgetPortfolioFactory.createPortfolio` 单独创建共享 100 份的预算项目，参数只有总预算、单机/单位算力上限和两个期限，**不包含预选的 NFT 编号**。募满后，运营页面的采购队列可在每批预算内指定最多 1–20 台，先完整核对官网候选，再在无合格官网候选时查看有限的 Firsto 页面；逐台创建子池、再逐台由父项目付款购入。项目可用剩余预算继续下一批。现有合约没有“建池时一次锁定 N 个具体 NFT 并在同一交易全部买入”的入口，不应把分步采购称为原子批购。

网页原先把多机建池折叠在单机工作台下方，造成入口误认。已将多机建池表单前置并显式提供从单机表单跳转的按钮，写清楚先募资、再选台数的流程；仍需发布新版静态前端。**当前采购队列清单和进度保存在浏览器 `localStorage`，服务端 journal 只保存每笔交易意图与回执。** 这不满足用户此前要求的队列数据以服务器为主；大额或长时间多机采购前，应另行实现服务端持久队列及跨设备恢复。Firsto 侧候选最多扫描前五页，也不能称作全站最低价保证。

线上页面和链上状态会变化；每次真实签名前重读具体矿机、报价、合约实现/费率、旧工厂停建状态、索引完整性和钱包地址。本文件中的区块/HTTP 结果只代表上述核对时点。
