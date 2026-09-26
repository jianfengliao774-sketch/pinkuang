# 拼矿部署与报价工作台

本目录是独立 React / Vite / ethers 前端，使用仓库内的 Solidity 源码生成部署产物。当前分支仍为开发与审阅状态，未部署主网。

## 本机运行

在仓库根目录执行 `npm ci --ignore-scripts`，然后：

```sh
cd deploy
npm ci
npm run artifacts
npm run dev
```

默认地址为 http://127.0.0.1:4173/。`npm run build` 生成静态文件；`npm start` 启动本机静态服务和固定 Firsto GET 代理。纯静态托管需要另外部署同源代理，不能直接假定报价请求可用。

## 已实现

- 单钱包部署：8 个链接库、协调器与三个实现、最后原子初始化，共 13 笔钱包确认。Factory/Market 使用 UUPS，Vault 使用共享 Beacon，升级经至少 48 小时时间锁。
- 部署预检、Gas 总预算和单价上限、逐笔记录、广播不明时停止自动发送、跨标签页锁、只读恢复和部署结果核验。浏览器持久化失败时不请求签名。
- 份额市场：真实链上读取、挂单、部分购买、撤单、领取卖款；现有份额交易费为成交价 1%，与本轮讨论的矿机采购服务费是两项业务。
- 矿机报价：只允许官方 collection，区分挂牌价与 Firsto 买方总额，核对报价/详情/来源时效；按参考日产能价生成默认预留 10% 的筹款计划，可导出 JSON。
- FlexiblePurchase 合约原型：建池时从官方链上参考 NFT 锁定 taskId；替代品必须同 collection、同 taskId、纯验证且非最优、达到最低验证权重且不超价格上限。原目标仍有符合条件的官网挂单时，合约拒绝购买替代品。成功采购后按当时持份快照将全部余款计入各持有人的可领取余额。
- 官网采购 keeper，默认 dry-run。筹款期间每 30 秒后台预热候选，每 2 秒探测满额；满额后从已准备队列逐台尝试，不等待整批核验完。需显式 `--send`、外部环境密钥与专用 journal 才能广播；本次未配置或运行主网发送模式。扫描有页数上限，不声称覆盖全市场。

原目标直接使用池内 NFT 编号查询官网，不等待 Firsto API。`--interval` 可调状态探测间隔，`--refresh-interval` 调候选刷新间隔；`--max-gas-bnb` 是包含失败交易在内的累计 Gas 预算。签名原文和确定哈希在广播前持久保存；广播不明时保留同一 nonce，不自动重发。核对 canonical 区块、至少两次确认和 BSC `finalized` 后才结案。后台程序须在筹款期间运行，才能预热替代候选。

采购恢复支持显式原样重播、同 nonce 限次提价和零值自转取消；待确认期间不换矿机、不创建新的采购 nonce。本机钱包锁跨资金池和进程生效，持久指针位于 `~/.local/state/pinkuang/purchase-keeper/wallets/`。多机器及其他钱包软件不受该锁控制，必须保持同一钱包只有一个采购执行器。签名账本不得删除或公开；旧版本只有两次确认的终态账本需要人工核实最终确认，不能自动当作已结案。具体步骤见 [采购保护与交易恢复](../docs/purchase-execution.md)。

## 尚未实现的本轮需求

- 官网代采费进入拼矿金库、Firsto 采购费付 Firsto 的双路径结算，以及不可变费率/收款配置。
- Firsto 签名、批量和托管订单的安全合约适配与本地 fork 成交验证。
- 筹款计划到建池、认购与余款领取的完整前端操作流程。报价页的导出操作不会创建资金池或购买矿机。
- BEM 收益归集、本人领取的前端入口和定时归集服务。合约支持任何人 `harvest()` 将收益归集到池子，再由各权益钱包自行 `claim()`，领取无 24 小时限制；参见[收益归集与本人领取](../docs/audits/2026-09-26/self-claims.md)。
- 主网实测、独立安全审计，以及最终代码发布。

单钱包仍由一个私钥掌握升级提案权。时间锁提供等待与观察窗口，不等同于多签，也不能保证升级后的逻辑或资产绝对安全。源码测试通过不能替代独立审计。taskId 表示同一道任务，并不保证门数、成本或日产收益完全相同；最低验证权重单独约束产能资格。

## 验证入口

```sh
npm test
npm run build
npm run artifacts:check
```

`src/deployment.test.ts` 使用本机 Anvil；没有真实钱包或主网签名。`scripts/artifacts.test.mjs` 检查编译产物与链接关系。Solidity 与升级检查见仓库根目录脚本和 `evidence/`。

采购调查和未完成的验证边界见 [采购费用对照](../docs/procurement-fees-2026-09-26.md)。最新型号约束与原目标优先版本，以 `evidence/model-validation-summary.json`、`model-ci-regression.log` 和 `model-upgrades/` 为准；旧 `contracts-ci.log`、`flexible-ci-regression.log` 只对应前期版本。前端与部署/市场/报价 28 项回归见 `evidence/purchase-ui-and-recovery-tests.log` 首组；最新 keeper/产物/恢复集成/代理共 60 项见 `evidence/purchase-final-scripts-tests.log`。

## 最新业务与验证覆盖

以 [2026-09-26 整改报告](../docs/audits/2026-09-26/remediation.md) 为准：取消业务销毁；收益 1% 平台费后归成员、整机出售 2% 平台费后归成员；份额表决期间冻结交易，订单 7 天到期。旧测试日志保留作历史，最新整合证据见该报告。Vite 启动/构建独立重编源码，产物未同步时拒绝构建，需先运行 `npm run artifacts`。
