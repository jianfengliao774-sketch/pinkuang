# 整机出售渠道：Firsto 原生挂单

状态：**产品规则已确定，合约与页面尚未实现，禁止把内部挂牌标成 Firsto 挂单。** 本文件记录 2026-09-28 用户确认的出售规则；不代表主网升级、Firsto 发布订单或真实资金测试已经完成。

## 已确定的业务规则

- 持份人按现有链上投票规则批准**某一台具体矿机**及其固定 BNB 售价。多矿机项目逐台投票；低于该台实际购机价仍须参与地址过半、至少 60 份赞成。投票通过后仅在 Firsto 发布原生矿机挂单，不向官网 CircuitMarket 挂单，也不以本站内部 `completeSale()` 冒充 Firsto 成交。
- 2026-09-28 最新要求：**矿机过户前严格结清 BEM**。Firsto 的批量购买路由在已核验的主网成交中先调用挖矿领取，再转移 NFT；但 Signed Ask V2 直购合约并不执行领取，因此不能仅凭挂在 Firsto 页面就认为所有成交路径都会结清。矿池必须在每个实际可成交入口转移 NFT 前强制验证该矿机 `pending == 0`，并确保已领取 BEM 留在矿池、记入成员权益。只在挂单时领取一次不足以保证成交时归零；“提前一秒”也不能保证链上执行顺序。归集失败时不得过户。
- Firsto 卖方挂单服务费当前为 0%，买方吃单服务费当前为 1%；以 Firsto 实际订单和链上费率为准。拼矿在卖方收到的**挂单价**中独立收取 1% 平台出售费，其余 99% 按出售时冻结的份额分配，仍由持有人主动领取。例：挂单 10 BNB，若 Firsto 买方费为 1%，买家付 10.1 BNB；Firsto 收 0.1 BNB，矿池收 10 BNB，平台金库待领 0.1 BNB，持份人合计待领 9.9 BNB。不得把 Firsto 的买方费算作拼矿收入。
- 只读费率证据：BSC 区块 `124417480`（哈希 `0x47af4d1093f33d90281e07d60e7640e966d5e290cb1c41eccfdd4ed3fc8573e4`）读取 Firsto V2 `0x33423244F9a5bF81b12B1a018aF6F4e079B97f29`，`defaultTakerFeeBps=100`、`feeEpoch=1`、`paused=false`；卖方 0% 来自当时 Firsto 页面公开费率说明。以后仍须按订单和成交区块重新确认。
- 矿机 NFT 从池地址经 Firsto 的已核验交易转至买家指定接收地址；份额、购机余款、挂单前已记账 BEM 与出售款保持各自的既定归属。Firsto 合约或费率变化时必须重新核对，不能用旧报价自动签名。运营钱包支付归集、挂单授权/发布、平台结算等**由它发起的交易**的 Gas；原生 Firsto 成交交易由买家调用 `fillSignedAsk` 并支付售价，网络 Gas 先由发起成交的买家支付。平台若承担这笔过户 Gas，须在真实成交确认后按核验回执作有上限的 BNB 返还，或经实证采用 Firsto 支持的代付协议；不能声称后台钱包直接替买家的原生交易付 Gas。

## 当前仓库的实际行为

`SaleGovernance.execute()` 只开启内部七天固定价挂牌，`SaleListed.listingId=0`；它没有调用 Firsto、授权 NFT 或生成 Firsto 签名。`PoolVault.completeSale()` 要求买家直接把挂牌价发给矿池，然后同笔严格领取 BEM、按 1%/99% 分账并过户 NFT。`PoolVault.settleSale()` 固定回滚，`receive()` 固定回滚。Firsto 原生买家若直接成交，不会经过 `completeSale()`，所以现有实现无法收 Firsto 卖款或创建成员出售款债权。前端 `live-governance.mjs` 也把 `executeSale` / `completeSale` 作为内部成交路径。现有主网部署更不能因页面修改自动具备 Firsto 出售能力。

## 必须单独实施的合约变更

1. 引入固定 Firsto Signed Ask V2 合约的**卖方**适配。矿池本身是 NFT 持有人，不能使用普通 EOA 的 `eth_signTypedData_v4` 签名；须确认 Firsto 链上 `ERC-1271` 验签与其订单发布服务都接受合约 maker。矿池只能对链上已通过的提案价格、collection、tokenId、nonce、到期、`payoutRecipient=矿池`、当前 fee epoch / feeBps 认可一个订单哈希，不得授权任意运营签名改价或改收款地址。
2. 后台可以在挂单前归集，但成交入口仍须独立证明转移前 `pending == 0`。批量路由若在同一笔交易中先领取，矿池收到的 BEM 必须记入成员权益；Signed Ask 直购不领取，只能在已结清且执行时仍无待领收益的情况下放行。当前普通 `harvest()` 会捕获协议 `claim` 失败，单看交易成功或函数返回不能证明领币成功；新卖方适配须提供可验证的成功边界。多机项目须把子池已归集的 BEM 同步记入项目共同份额。然后只给固定 Firsto 交易合约授予该台 NFT 的精确授权。现有 Vault 运行时代码接近 EIP-170 上限，须重构/抽库并校验代理存储布局；授权须限于单台矿机、订单窗口，并在到期/撤销时撤销。
3. 允许矿池接收**来自固定 Firsto 合约**的售价 BNB，并设计与 Firsto 实际交割相匹配的状态机。交易可能先发生在外部合约、后由任何人触发池内结算；不能仅凭“有人给池转钱”或者网页回执认定售出。结算必须核对实际 NFT 已离开矿池、售价足额到账、提案/订单身份、只能结算一次，再原子记入平台和成员债权。成交未结算时禁止错误地撤销挂牌、转份或重挂。
4. `BudgetPortfolioVault` 逐台包装子池出售时，须等待子池确认 Firsto 成交并领取 99% 净款，项目再按出售时的 100 份单独记账；平台 1% 仍在子池金库，避免项目再次扣费。售完最后一台后才关闭项目。
5. 如 Firsto 发布服务不接收合约 maker / ERC-1271 订单，必须先取得其兼容路径并实测**真实可在 Firsto 页面展示与成交**。链上接受 ERC-1271 不等于网站会发布挂单；在此之前不得迁移 NFT 到个人钱包或以 operator 的个人挂单代替资金池所有权。

## 上线验收

- 在 Firsto 当前公开 API/页面上验证合约 maker 订单的发布、发现、取消与成交，检查实际卖方到账额和买方费用；不能只测本地 mock。
- 固定块 BSC fork：投票阈值、后台钱包支付挂单前归集 Gas、实际 BEM 到账与项目记账、归集失败不发布挂单、挂单后新增收益归买家、Firsto NFT 过户、矿池收款、平台 1% 与成员 99%、多矿机项目分账、整数尾差与重复结算。不得把 Firsto 买家支付的过户 Gas 错记为后台钱包支出。
- 故障/竞态：挂单已发布但 NFT 授权失败、费率或实现升级、订单过期/撤销、买家成交与撤单同块、Firsto 收款成功但池内结算尚未执行、RPC 或索引漏事件、重入、错误 NFT、恶意追加 BNB、多个钱包并发领取。
- 编译体积、存储布局、源码绑定产物、部署证明、页面与服务端版本检查均通过后，才允许主网小额测试；此处没有授权或执行任何钱包交易。

核对来源：[Firsto 矿机市场](https://tapeout.firsto.ai/circuits)、[Firsto 首页费率说明](https://tapeout.firsto.ai/)、`contracts/src/interfaces/IFirstoExchange.sol`、`contracts/src/PoolVault.sol`、`contracts/src/libraries/SaleGovernance.sol`、`contracts/src/libraries/SaleSettlement.sol`、`contracts/src/BudgetPortfolioVault.sol`。

## 2026-09-28 主网成交与分叉核对

- [成交交易一](https://bscscan.com/tx/0x878e1495c4edaee87ddc5a822786e0ee22637a9c8a563fb89ebedba0c9180ad7)和[成交交易二](https://bscscan.com/tx/0xb6b51c3519403864d21c4cc457c2be580a935518f236a6e9463228d21091966c)均由买家调用 Firsto 批量购买路由 `0x8b18Af20165c3168C17F4F5a9250414E5dF81d59`。交易回执中，BEM 铸给卖家与挖矿领取事件分别为第 0、1 条日志，NFT 转给买家为第 3 条日志。这证明**这两笔批量路由成交**在同一笔交易中先领 BEM 再过户。
- 对 Firsto Signed Ask V2 `0x33423244F9a5bF81b12B1a018aF6F4e079B97f29` 的主网分叉调用确认其接受 ERC-1271 合约卖家，但执行轨迹为验签、NFT 转移、支付卖家，没有挖矿合约领取调用。故不能将批量路由行为外推至直购或未来升级的所有渠道。Firsto 网站是否允许发布合约钱包卖家订单仍待真实发布验证。
