# 指定购机双重 ±10% 替代：候选核验

本报告核验候选代码，不证明正式站已升级。旧 `deploy/public/deployment-artifacts.json`、`web/lib/contracts.generated.json`、历史部署清单及生产服务均未替换。本轮没有 BSC 交易、生产服务重启或付费行情 API 请求。

## 构建与尺寸

候选制品内容摘要：`0xe2b8f661379d95c1e1271c95ef3937e2115d97661df3ca231bbf6882a024cd62`。固定 solc `0.8.24+commit.e11b9ed9`，optimizer runs=1，Shanghai，viaIR=false；21 个制品、82 个源文件。独立候选路径的构建、源码哈希一致性检查和 `--check` 均通过。该摘要不包含 `sourceCommit`，发布前需用最终提交重新生成出处字段。

| 合约 | runtime 字节 | EIP-170 余量 |
| --- | ---: | ---: |
| PoolVault | 24,415 | 161 |
| PoolFactory | 24,462 | 114 |
| FreshPoolFactory | 23,398 | 1,178 |
| BudgetPortfolioVault | 24,478 | 98 |
| PlatformAuthority | 20,028 | 4,548 |

全部制品均通过 24,576 字节上限，未新增外部链接库。多个合约余量较少，后续编译器或功能变动必须重新测量。为控制 Vault 大小，既有认购/撤回认购记账移入既有 PoolFunds 库；mint/burn、事件及非重入入口仍在 Vault，属于本次必须审核的旧路径变更。

## 已完成的离线检查

- 网页测试：1,052 项通过。Next.js webpack 生产构建和 catalog、价格显示、review-policy 检查通过。
- deploy Node 测试：962 项，961 通过、1 项跳过，0 失败。包括签名、中继、keeper、创建查重、运行包实际导入及依赖闭包。
- 新指定购机合约测试：18 项通过，覆盖区间端点及 1 wei 越界、512 位精确比较、费用/余额、同任务、原机优先、撤销授权、回调改动、矿机占用和旧池默认关闭。
- 完整非 fork Foundry：56 套、590 项通过，0 失败/跳过。该轮启动于最后六条指定购机测试新增前；冻结源码后另跑全部 unit：44 套、572 项通过，包含最新指定购机 18 项。没有 BSC fork 测试。
- 新签名 Authority 测试及字段篡改检查通过；旧签名类型不变。
- 链接库 AST 审计通过：Factory 精确四个 PurchaseValidation 调用；新非只读 helper 仅配置新建 Vault 并回读矿机身份/任务/权重，创建入口保持 nonReentrant。
- 存储兼容检查：五个历史基线通过，新增独立 ERC-7201 namespace；详见同目录存储核验 JSON。这是相对记录的 integrated-v2 基线核验，不是当前正式链上全部实例的兼容性证明。
- 统一 `forge build --force --sizes`、`validate-upgrades.mjs` 的单体/历史基线/fixtures/反例闸门检查通过。
- 本地 Anvil 实际部署 16 步全部成功，回执和运行图核验通过。新候选仍绑定精确 Gas 计划摘要；只提高 PoolFunds、PurchaseValidation、FlexiblePurchase 三步上限，每步至少留 10% 余量。详见 [Gas 计划](designated-purchase-gas-plan-20261004.json)。这不是正式链 Gas 报价。
- deploy TypeScript EVM 回归：146 项全部通过，包含新候选 16+7 本地部署/激活、替换交易恢复和旧制品摘要在请求钱包签名前被新 Gas 计划拒绝。`tsc --noEmit` 通过。

## 复现候选构建

在仓库根目录执行，候选输出必须使用独立路径，不能覆盖旧正式制品：

```sh
node deploy/scripts/build-artifacts.mjs --output /tmp/bemine-designated-candidate/deployment-artifacts.json
node deploy/scripts/build-artifacts.mjs --check --output /tmp/bemine-designated-candidate/deployment-artifacts.json
node scripts/run-forge.mjs test --root contracts --no-match-path 'test/fork/**' -vv
cd web
node --test scripts/*.test.mjs
node node_modules/next/dist/bin/next build --webpack
```

网页构建在本轮直接调用 Next：普通发布 prebuild 仍会因旧发布制品与新候选源不一致而拒绝。它必须在部署审查后使用新清单、新制品摘要及新 ABI，不能用测试成功代替运行图激活。

## 保留的上线条件

需核验 Factory/Vault 链接库、Authority 新签名入口与运行图版本，再按治理规则升级。新项目必须明确选择新政策；已有项目不自动允许替代。keeper 的新标志默认关闭，服务模板未变。

历史 Firsto JSON 报价由管理员签名冻结；摘要不是独立订单证明。Firsto bestAsk 不等于完整订单簿；官网优先由合约强制，Firsto 原机优先由准确编号查询和订单核验执行。公开 API 不能证明未返回的订单不存在。
