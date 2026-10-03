# Firsto 批量订单采购候选代码

状态：**代码已实现，真实协议采购关闭，尚未部署或升级正式合约。**
本分支为 `codex/firsto-batch-support-20261003`，以正式分支
`codex/formal-three-day-sale-20261002` 的 `efad448cb82e5c5bf3f46a35c9d6b0541c6a4f92` 为基础。
此次工作不修改正式站、链上资产、旧部署记录或已部署的非代理 Authority。

## 实现范围

- `PoolVault.buyFromFirsto(uint8,bytes)` 的 route 1 按一份 `BatchAsk` 签名和一条 `AskLeaf` 的 Merkle proof 收购指定矿机；不会购买整个批次。route 0 的单笔订单编码保持原样。
- 固定交易所、BSC chain 56、严格运行时代码哈希、规范 ABI 编码、字段一致性、双重叶子哈希和排序 proof 检查。拒绝过期、撤销、已消耗叶子、错误费用/epoch、错误矿机或未授权 NFT。
- 保留原矿机优先、质量/型号/算力、全部支出上限、登记占用、挖矿收益结算、精确 NFT 回调、付款前后复核和余款分配。失败撤回本次资金及状态改变。
- 预算池仍使用现有 `buyFirsto(address,bytes)`。批量订单增加显式 envelope：`abi.encode(bytes32 magic,uint8(1),bytes inner)`；旧单笔 bytes 不变。现有 Authority 的签名绑定整个 envelope，预览、审批、keeper 和后台使用同一份冻结数据。
- `BudgetPortfolioVault` 新增链接 `FlexiblePurchase`；授权与子池绑定检查发生在 helper 之前，资金及持仓核对发生在其后，外层 `nonReentrant` 覆盖整个过程。存储字段和外部 ABI 不变。
- 前端、keeper、账户交易 journal、预算采购队列统一使用带 kind 的编码与核验；恢复操作保留原始 kind/bytes。预算冻结订单不再重新请求 Firsto 行情替换交易数据。
- 部署 artifact、生成的前端 ABI、链接图核验及两种升级计划生成器同步适配新依赖。历史 artifact/catalog 仍按其原有链接图验证；旧部署 manifest 和固定升级计划不替换。

## 上线阻断：Firsto 合约来源与指纹计算规范未核实

交易所：`0x3F58C9cbce933c76158B2A29B0d612c46546Dc43`。

| 证据 | 指纹值 |
| --- | --- |
| Firsto 官方配置/API 公布的 RuntimeCodeHash | `0x0a44a1aa18057cf5345eea9e1c58e4d40b0ff9c3da52c0f6eb8032320e7f23fb` |
| 固定块原始链上代码的 keccak256，11,524 bytes | `0x84072ba0b149f0cb72a8d1be49797ba293206d931407eeb2a25eeaf9f28db0b0` |

官方来源：[Firsto 当前前端 bundle](https://tapeout.firsto.ai/assets/index-CCV82TiP.js)，
文件 SHA-256 为 `107b7394a02126d9fa208e637b0082b927197339b66cf73ec0c79468cee553a0`。
链上代码复核固定块为 `0x77b2733`，块哈希
`0xbd5db61807ef295d4da4f4c00b39137d63b928fa05a9eeaf7caa4d3d9a98d427`。
剥离 metadata 后也不匹配。官方 bundle 只比较 API 返回的 `circuitBatchAskExchangeRuntimeCodeHash` 与配置常量，未在浏览器中计算批量合约代码哈希。API 服务端采用 raw keccak、metadata 去除或 immutable/address 规范化的计算约定尚未取得证据；因此本次差异**不能单凭 bundle 解释成确定的合约版本不一致**。ABI、getter 返回结果及历史成交证明仅支持协议字段推导，不能替代源码与实际代码对应关系。

生产候选 Solidity 保留官方公布 pin；后台私有常量
`FIRSTO_BATCH_PROVENANCE_VERIFIED = false` 在任何批量核验 RPC 之前拒绝订单。
没有环境变量或配置开关绕过。前端展示的批量来源不能被转换为可采购报价。
不能把实际观察到的未知代码哈希直接替换为可信 pin。

详见 [runtime-provenance.json](firsto-batch-candidate-20261004/runtime-provenance.json)
和 [protocol-wire-evidence.json](firsto-batch-candidate-20261004/protocol-wire-evidence.json)。

## 验证范围与复现

生产候选原始 pin 的安全测试与隔离正向测试分别运行，不混作真实协议成交证明。

| 已运行检查 | 结果 |
| --- | --- |
| 完整 nonfork 单元/并发/审计/不变量测试 | 576 项实际测试通过，9 个不变量 suite 全部通过；见下方统计说明 |
| 原始生产 pin 安全测试 + 单笔采购回归 | 28/28，通过，无跳过 |
| 临时副本的批量逻辑测试 | 19/19，通过，无跳过；仅 mock 逻辑证据 |
| 前端全部 Node 测试 | 990/990，通过，无跳过 |
| 后端、keeper、journal 与 artifact 相关测试 | 113/113，通过，无跳过 |
| 两类升级计划和精确新旧库链接回归 | 11/11，通过，无跳过 |
| 存储兼容、链接源码/AST、兼容及不兼容布局 fixture | 26 项完成，预期坏布局被拒绝 |
| 前端 ABI/source 校验、价格及产品规则检查 | 通过 |
| Next 网页及 Vite 部署台 production build | 通过；未上传服务器 |

Node 检查及两项 production build 使用 Node `24.19.0`。Solidity 使用固定 `0.8.24`、optimizer runs `1`、Shanghai、非 via-IR；没有放宽编译参数规避大小限制。
候选 runtime 大小：`FlexiblePurchase` 18,554 bytes，`PoolVault` 24,490 bytes，`BudgetPortfolioVault` 24,415 bytes，均低于 EIP-170 的 24,576 bytes。
候选 artifact 内容 digest 为 `0xd125e3ae8358dd0c387d0c8055f9a265e9f62de3f63c6a76954c3f86cf823273`。
存储及库调用证据见 [upgrade-checks.json](firsto-batch-candidate-20261004/upgrade-checks.json)
和 [library-link-audit.json](firsto-batch-candidate-20261004/library-link-audit.json)。这些检查并非完整第三方安全审计。

完整 nonfork 输出为 57 suites、577 passed、0 failed、0 skipped。其中 mock 原来的 public mapping 名称 `testLeafUsed` 使 getter 被 Forge 当作一项无断言 fuzz test，此项不计入有效验证（577−1=576）。交付源已改为 `leafUsed`，最终改名后的隔离 19 项和加强后的原始 pin 安全 4 项均另行通过；原完整 run 使用的生产合约实现与交付实现相同，未重复长时间运行未受影响的不变量测试。

```sh
npm test
npm run test:firsto-batch:isolated
npm run build
VALIDATION_TASK=T2 VALIDATION_EVIDENCE_ROOT=/tmp/bemine-batch-storage npm run validate:upgrades
cd web && pnpm check && pnpm build
cd ../deploy && npm test && npm run build
```

隔离 runner 将源复制到临时目录，计算受控 mock 的代码哈希，仅替换临时副本 pin，运行完核对原始生产源完全不变。后台正向 verifier 测试同样只在临时模块副本打开 gate/替换 pin，不影响交付代码。

TapeOut #5181 已在区块 `125506635` 被第三方买走：
`0x73f1e94ac9736937f323aeb9228e3e25af58d60ec4764549ea81aeccffaff2ae`。
其公开历史订单用于离线签名、batch hash、leaf hash 和真实 calldata fixture；不能再作为当前可成交挂单。
前一块 `125506634` 的免费公开节点返回 `missing trie node`，本次**没有通过真实历史 fork**。

未来严格真实协议演练命令：

```sh
BSC_RPC_URL=<archive endpoint> FIRSTO_BATCH_FORK_BLOCK=125506634 npm run test:fork:firsto-batch
```

该 fixture 不使用 `etch/store/mockCall/skip`，也不放宽生产 pin；当前来源问题及 archive 缺失会使它失败，不能将失败或未运行标成通过。它与旧固定块 `123728000` 的默认 fork 测试独立。

## 激活条件

1. 取得 Firsto 可核验源码、编译设置、部署证据及指纹计算规范，解释官方公布指纹与本次 raw hash 差异，并核实签名、bitmap、费用、收益及 NFT 结算实现。
2. 审核对应 runtime 后再通过代码审查更新 pin/gate，完成严格真实协议采购与预算池端到端演练。
3. 根据验证后的 library 依赖与实际链上角色生成独立升级计划，部署及核对新库/实现；按现有 timelock 完成链上升级，再发布匹配的服务与网页。

本分支 artifact 是可复现的候选编译产物，不是已激活的链上实现；没有为本次 batch 功能发送部署、升级、签名、授权或付款交易。
