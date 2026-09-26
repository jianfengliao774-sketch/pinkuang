# BEMine 页面与合约对接

本轮把 PR #9 的 v7 设计页面合入本地 `codex/frontend-contracts` 分支，按用户最新规则修改合约、演示和接口。`web/` 仍明确处于演示模式；没有主网部署地址，也没有把模拟余额接成真实交易。既有 `deploy/` 控制台和 `web/` 是两个应用。

## 已确认的统一规则

| 业务 | 当前规则 |
| --- | --- |
| 参考筹资 | 参考产能价 ×（1 + 预留比例），默认 10%；向上取整到可被 100 整除的 wei，分为 100 个整数份额 |
| 购机付款 | `priceCap` 不超过参考价；候选价格同时受单位验证权重限价约束。10% 预留不提高采购上限。官方市场标价已经包含卖方承担的市场费用，不重复向买方加 1% |
| 购机余款 | 按购机时持份记为各人的 BNB 债权，个人 `withdrawBnb()` 提取；不会自动遍历并转账给所有人 |
| BEM 收益 | `harvest()` 任何人可发起，收益先入池，扣 1% 平台费后记入成员；`claim()` 仅本人领取已入账收益，无固定时间、无 24 小时限制、无到期作废、无销毁 |
| 份额成交 | 1% 从卖方成交款扣除；7 天到期；锁定份额仍归卖家并享有收益；提案表决期间禁止新挂单/成交，仍可撤单 |
| 整机成交 | 本轮由旧版 2% 改为 **1%**；其余 99% 归持有人，整数除法向下取整的手续费尾差也归持有人；不销毁 |
| 整机表决 | 价格必须大于零。低于实际 `purchaseCost` 时至少 60/100 份同意，且赞成人数超过快照人数一半；不低于成本时份额、人数均严格过半。仍须严格结清外部收益才可交割 |

参考产能价格和目标日产量是建池时披露的报价，不是链上实时预言机或保证收益。Firsto 直接采购和采购服务费分流尚未接入；不得把演示中的费率说明当作已有收费路径。

## 只读聚合合约

Factory 初始化时自动创建 `PoolLens`，绑定该 Factory，没有持币、授权、管理员或转账入口。升级旧 Factory 后可由任何人调用一次 `ensureLens()`，重复调用返回原地址，不允许替换。部署仍为原来的 13 次钱包交易；部署检查增加 Lens 归属和实际运行代码比对。

| 页面数据 | 读取方式与含义 |
| --- | --- |
| 拼矿目录 | `PoolLens.poolPage(offset, limit, account)`，每页最多 20 池；按 Factory 注册池分页，不按 NFT 去重 |
| 我的资产/收益 | `positions(poolAddresses, account)`；保留当前份额为零但有收益、退款或售款的旧持有人 |
| 认购 | `params.targetRaise`、`unitPriceWei`、`totalSupply`、`depositPaused`、`fundingDeadline`；同一钱包可反复认购，最多持有整池 100 份，整池总量不超过 100 份 |
| 份额可售数 | `availableShares`；不能用 `balanceOf` 代替，也不能把已经锁定的份额再次出售 |
| 收益余额 | `claimableBEM` 是已经入账的可领 BEM，不包含尚未 `harvest()` 的外部实时产出 |
| BNB 余额 | `bnbOwed` 已包含懒结算的余款/整机售款，不能再加一次；份额市场售款另从 `ShareMarket.bnbOwed(account)` 读取并单独提取 |
| 购机参考 | `purchaseReference(pool)` 返回参考 NFT、参考价、预留、最低验证权重、taskId、参考权重和报价证据；实际购入 NFT 以 `params.circuitId` 为准 |
| 共同决策 | `governance(pool, account)` 返回提案快照、赞成门槛、是否已投和当前可投/可执行状态；这些是当前区块判断，交易前仍需模拟 |
| 历史成本/记录 | `initialContributedWei` 只表示原始认购，不是二级买入成本。历史流水、全局统计/排序、历史收益率需事件索引，Lens 不伪造这些数据 |

每条结果含 `status.validMask/errorMask/trustError`。位号由源码的 `Field`、`GovernanceField`、`ReferenceField` 定义；**没有 valid 位就显示未知，不能显示 0 或允许交易**。Lens 对单个异常、错误 ABI、超大返回、耗尽子调用 Gas 的 getter 隔离，对派生字段也检查依赖。全页 `eth_call` 仍需足够的 Gas，RPC 超时可缩小页数重试；不能据超时断言矿机不可用。所有结果仅限该 Factory 注册、且正反向 Factory 绑定一致的池。

网页身份必须用 `chainId + Factory + poolAddress`；矿机身份用 `chainId + collection + tokenId`。同一个 NFT 可有多个历史池，替代购机也会改变实际 NFT，不得使用页面短编号作为交易地址或唯一键。

## 精确金额和交易准备

`web/lib/chain-client.mjs` 提供 BSC 56 的只读 EIP-1193 适配器、精确参考筹资计算、个人直调交易数据及批量领取的**独立交易队列**。地址来自已核验的部署配置；适配器读取 Factory 的 Lens 并反查归属和版本，所有读取固定同一区块，返回前核对区块哈希和链。跨页时传相同 `blockNumber`，并核对返回 `blockHash` 一致。

金额和 NFT ID 使用 `bigint` 或十进制整数字符串，禁止浮点交易金额。`referenceQuote()` 同步两次向上取整规则；`checkedPoolCreation()` 编码 `createFlexiblePoolChecked(params, config, expectedTaskId, expectedReferenceWeight)`。合约在同一交易中校验实际模型和权重，变化时回滚整次建池/注册；此入口保留 operator 和暂停约束。旧 API 保留兼容，新的页面建池应选 checked 入口。

所有适配器产出都是未签名交易数据。接入钱包时需重新读取账户/链/最新状态、模拟并估 Gas，再让用户确认；不能把只读查询或编码成功展示为交易成功。个人 `claim()` 直接发送到每个池，不经公共批量路由器，不能增加 `claimFor`；它不调用 Mining，外部领取失败不妨碍取回已入账收益。未知收益不加入领取队列，空队列不能说明所有池均无收益，页面仍应保留未知项。`harvest()` 仅 Active/Listed 状态可准备，自领已入账权益不受矿机已出售影响。

份额市场接入沿用 `list(pool, amount, pricePerUnit)` / `fill(orderId, amount)` / `cancel(orderId)` / `expire(orderId)`，从真实订单读取 `pool`、`pricePerUnit`、`remaining`、`orderExpiresAt`，同区块核对 Factory 注册和池可交易状态。`fill` 的支付值为精确单价乘份数。提案冻结不阻止卖家撤单；到期可由任何人解锁，但份额始终留在原卖家钱包。`deploy/` 已有真实份额市场流程，`web/` 当前仍是带规则约束的演示。

## 构建和产物绑定

先安装根目录和 `deploy/` 的锁定依赖，再安装 `web/` 依赖。合约修改后执行：

```sh
cd deploy
npm run artifacts
cd ../web
pnpm contracts:sync
pnpm check
pnpm build
```

`contracts:sync` 先按锁定 Solidity/OZ/编译设置独立重编，验证部署 JSON，再导出四个 ABI 和规范化摘要。`contracts:check` 仅核对、不覆盖文件。`pnpm build` 的 prebuild 与 CI 均强制检查，源代码、部署产物或网页 ABI 漂移会失败。`pnpm dev` 是设计预览；其模拟值不得进入真实交易编码。

验证结果及遗留边界见[页面合约审计记录](audits/2026-09-26/frontend-contracts.md)与[单钱包 100 份专项审计](audits/2026-09-27/multi-share.md)。
