# 拼矿部署与报价工作台

本目录是独立 React / Vite / ethers 前端，使用仓库内的 Solidity 源码生成部署产物。当前分支仍为开发与审阅状态，未部署主网。

## 本机运行

手机扫码采用可选 WalletConnect 配置；未提供项目编号时继续使用浏览器扩展或钱包内置浏览器。配置与真实手机验收步骤见 [扫码连接说明](../docs/walletconnect-setup.md)。

在仓库根目录执行 `npm ci --ignore-scripts`，然后：

```sh
cd deploy
npm ci
npm run artifacts
npm run dev
```

默认地址为 http://127.0.0.1:4173/。开发服务同时运行本机 SQLite 操作日志；市场交易恢复还需设置 `DEPLOYMENT_JOURNAL_RPC_URL` 为可信 BSC HTTPS RPC。`npm run build` 只生成页面；`npm start` 必须按[服务器日志配置](server/JOURNAL.md)提供持久卷、精确 HTTPS Origin 与 RPC。纯静态托管没有操作日志 API，不能用于一键部署或市场签名。

若开发期间重新运行 `npm run artifacts`，Vite 会重新核对源码、刷新内置产物摘要并重载页面。旧版已运行的 Vite 进程不会自动获得这项监听；出现“源码摘要不一致”时，先运行 `npm run artifacts:check`，再停止旧进程并重新运行 `npm run dev`。源码、编译配置或产物在页面运行期间发生漂移时，部署签名前核对会失败，日志服务拒绝新的部署签名意图；已广播交易的哈希和回执仍可保存。`GET /api/journal/session` 在未登录时返回 JSON 401 是日志 API 已挂载的正常探测结果；返回网页 HTML 或 404 则说明访问到的是纯静态页面。

## 已实现

- 完整单钱包部署：9 个链接库、协调器与五个实现，最后原子初始化单机和多机项目，共 16 笔钱包确认。两类 Factory/份额市场均使用 UUPS，两套 Vault 各有固定 Factory 的 Beacon，共用至少 48 小时时间锁。新记录 kind=integrated-v2；旧记录不自动转换成新图。
- 部署预检、Gas 总预算和单价上限、逐笔服务器记录、广播不明时停止自动发送、跨标签页锁、只读恢复和部署结果核验。服务器持久化失败时不请求签名。
- 份额市场：真实链上读取、挂单、部分购买、撤单、领取卖款；升级后的每笔成交由买方在成交价外支付 1%，卖方从成交价扣除 1%，均记入金库。现有主网旧实现仍只向卖方收 1%，新增交易在新版页面与后台被版本门槛拒绝，直至完成时间锁升级与证据核验。这与矿机采购服务费是不同业务。
- 矿机报价：只允许官方 collection，区分挂牌价与 Firsto 买方总额，核对报价/详情/来源时效；按参考日产能价生成默认预留 10% 的筹款计划，钱包认证后保存到服务器并可导出 JSON。
- FlexiblePurchase 合约原型：建池时从官方链上参考 NFT 锁定 taskId；替代品必须同 collection、同 taskId、纯验证且非最优、达到最低验证权重且不超价格上限。原目标仍有符合条件的官网挂单时，合约拒绝购买替代品。成功采购后按当时持份快照将全部余款计入各持有人的可领取余额。
- 官网采购 keeper，默认 dry-run。筹款期间每 30 秒后台预热候选，每 2 秒探测满额；满额后从已准备队列逐台尝试，不等待整批核验完。需显式 `--send`、外部环境密钥与专用 journal 才能广播；本次未配置或运行主网发送模式。扫描有页数上限，不声称覆盖全市场。

原目标直接使用池内 NFT 编号查询官网，不等待 Firsto API。`--interval` 可调状态探测间隔，`--refresh-interval` 调候选刷新间隔；`--max-gas-bnb` 是包含失败交易在内的累计 Gas 预算。签名原文和确定哈希在广播前持久保存；广播不明时保留同一 nonce，不自动重发。核对 canonical 区块、至少两次确认和 BSC `finalized` 后才结案。后台程序须在筹款期间运行，才能预热替代候选。

采购恢复支持显式原样重播、同 nonce 限次提价和零值自转取消；待确认期间不换矿机、不创建新的采购 nonce。本机钱包锁跨资金池和进程生效，持久指针位于 `~/.local/state/pinkuang/purchase-keeper/wallets/`。多机器及其他钱包软件不受该锁控制，必须保持同一钱包只有一个采购执行器。签名账本不得删除或公开；旧版本只有两次确认的终态账本需要人工核实最终确认，不能自动当作已结案。具体步骤见 [采购保护与交易恢复](../docs/purchase-execution.md)。

已购矿机的停挖监测及两笔恢复交易由独立[自动挖矿 keeper](../docs/automatic-mining.md)执行。Factory 级 supervisor 自动发现新增子池并为各池维护私有 journal。Vault 原有 `mine(bytes)` 限定操作对象和 operator；智能合约本身不具备定时发交易能力。默认只读，启用 `--send` 后需单一 operator 执行点。

## 本次整合与真实使用边界

当前源码加入 Firsto SignedAsk V2 合约采购、多机预算项目和严格结清的受控 Firsto 出售。完整前端、索引、通知与新部署图须以同一源码和构建摘要发布；具体入口及验收状态见 [统一交接说明](../docs/INTEGRATION_HANDOFF.md)。旧清单与旧线上代理不会因为网页更新而获得新能力。

Firsto 整机出售由买家在本站确认总价，矿池先结清 BEM，再临时授权精确订单并调用 Firsto；售款回矿池，平台按售价 1% 记账，余款按成员权益分配。原生 Firsto 页面成交、批量/托管订单和全市场最低价保证均未开放。

部署完成后导出公共清单；集成清单含 kind、portfolioFactory、portfolioMarket、portfolioBeacon、portfolioImplementation、portfolioFactoryImplementation 及对应 codehash。浏览器、后台和索引各自核验图，缺失项不能降级为“已完整部署”。历史清单仍可只描述单机图。新源码与旧记录摘要不一致时不能在新页面继续签旧计划，须使用匹配版本只读核对与归档，不能重发不明交易。

所有主网签名仍由用户钱包确认。keeper 和通知 worker 的上线配置、生产环境验收及实际主网业务测试须单独核验，源码测试不代表已自动启用。

单钱包仍由一个私钥掌握升级提案权。时间锁提供等待与观察窗口，不等同于多签，也不能保证升级后的逻辑或资产绝对安全。源码测试通过不能替代独立审计。taskId 表示同一道任务，并不保证门数、成本或日产收益完全相同；最低验证权重单独约束产能资格。

## 验证入口

```sh
npm test
npm run build
npm run artifacts:check
```

## 隔离 v2 部署台打包

审阅后的源码提交完成，再重新生成产物并构建页面。`scripts/package-release.mjs` 只在本机创建一个新的发布目录，不上传、不改 Nginx、不重启服务、不发送链上交易。输出参数必须是已存在父目录下的绝对路径，且在源码仓库之外；目标已存在时拒绝覆盖：

```sh
node scripts/package-release.mjs --out /absolute/releases/pinkuang-deploy-v2-reviewed
```

白名单为 `dist/`、`server/`、`shared/`、两个 package JSON、`public/deployment-artifacts.json`，以及日志服务静态依赖的 `scripts/official-market-discovery.mjs` 和 Firsto 校验依赖的 `src/firsto-purchase.mjs`。没有打包采购/挖矿 keeper 的执行入口。脚本拒绝符号链接、`.env`、钱包密钥、数据库及不受支持的文件类型，检查运行时相对 import 完整、浏览器内置摘要与产物一致，生成含逐文件 SHA-256、原产物源码提交、当前源码提交、artifactDigest 和 16 步标识的 `release-manifest.json`。不要把生产 journal、会话、环境文件或通知凭据复制到此目录。

这是一份独立测试发布包。安装依赖可以在该目录运行 `npm ci --omit=dev --ignore-scripts`，运行环境须支持 `node:sqlite`（本次 Linux 验证使用 Node 24）。安装后可仅检查模块导入，不启动服务：

```sh
node --input-type=module -e "await import('./server/index.mjs'); await import('./server/chain-index/indexer.mjs'); console.log('runtime imports ready')"
```

部署到服务器前，为 v2 单独指定 release/current 链接、服务名、空闲 loopback 端口和新 journal 数据库；数据库直接父目录 `0700`，服务 `UMask=0077`。例如拟用 `/pinkuang-deploy-v2/` 与 `127.0.0.1:4193`，必须先核实端口未占用。`DEPLOYMENT_JOURNAL_ORIGIN` 只写精确 HTTPS origin（不含路径），`DEPLOYMENT_JOURNAL_RPC_URL` 显式指定可信 HTTPS BSC RPC。索引若需要启用，另用独立端口、数据库和新双图配置；不要默认代理生产索引。保持 `BEMINE_NOTIFICATIONS_ENABLED=0`，不继承生产环境秘密、工厂白名单或旧部署记录。新图完成并核验后，才能按新清单配置业务入口。

Vite 构建使用相对资源路径，独立 URL 前缀需要反向代理去除前缀，同时把日志 cookie 路径改写到该前缀。以下仅是配置模板，未安装或启用：

```nginx
location = /pinkuang-deploy-v2 { return 308 /pinkuang-deploy-v2/; }
location ^~ /pinkuang-deploy-v2/ {
    proxy_pass http://127.0.0.1:4193/;
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For "";
    proxy_set_header X-Forwarded-Host "";
    proxy_set_header X-Forwarded-Proto "";
    proxy_cookie_path /api/journal /pinkuang-deploy-v2/api/journal;
    proxy_read_timeout 120s;
    add_header X-Robots-Tag "noindex, nofollow" always;
}
```

不要直接运行历史 `activate.remote.py`、`install-nonce-hotfix.remote.py` 或旧 `product-live` 发布脚本；它们绑定旧基线并可能切换生产 `current`、重启已有服务。隔离部署后先检查静态产物逐文件摘要、未登录 `/pinkuang-deploy-v2/api/journal/session` 的 JSON 401、精确 Origin、cookie 路径和两个环境的日志隔离；这些检查不需要签名或真实资金。

`src/deployment.test.ts` 使用本机 Anvil；没有真实钱包或主网签名。`scripts/artifacts.test.mjs` 检查编译产物与链接关系。Solidity 与升级检查见仓库根目录脚本和 `evidence/`。

采购调查和未完成的验证边界见 [采购费用对照](../docs/procurement-fees-2026-09-26.md)。最新型号约束与原目标优先版本，以 `evidence/model-validation-summary.json`、`model-ci-regression.log` 和 `model-upgrades/` 为准；旧 `contracts-ci.log`、`flexible-ci-regression.log` 只对应前期版本。前端与部署/市场/报价 28 项回归见 `evidence/purchase-ui-and-recovery-tests.log` 首组；最新 keeper/产物/恢复集成/代理共 60 项见 `evidence/purchase-final-scripts-tests.log`。

## 最新业务与验证覆盖

业务变更记录见[页面合约优化报告](../docs/audits/2026-09-26/frontend-contracts.md)及[份额市场双边费补充](../docs/audits/2026-09-27/share-market-dual-fee.md)：取消业务销毁；矿机产出平台费 1%，份额市场买卖双方各 1%，整机出售卖方 1%；份额表决期间冻结交易，订单 7 天到期。Factory 自动部署只读 Lens，最终核验检查其归属和运行代码，当前集成部署为 16 笔（旧部署历史为 13 笔）。旧测试日志保留作历史。Vite 启动/构建独立重编源码，产物未同步时拒绝构建，需先运行 `npm run artifacts`。
