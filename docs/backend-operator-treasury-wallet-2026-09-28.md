# 后台运营与金库钱包接线

状态：后端脚本已增加**默认只读**的 BNB 佣金发现和 opt-in 提款入口；没有配置私钥、启动后台服务或发送主网交易。用户计划在服务器部署一个私钥钱包，为未挖矿矿机的恢复及其他运营交易支付 Gas，并领取平台手续费。私钥只能由用户在服务器私有进程环境中提供，不能写进仓库、网页、浏览器缓存、公开 API、日志或此文档。

## 当前链上身份与费用去向

2026-09-28 只读查询 BSC 区块 `124417640`：既有 Factory `0xcB24E7F96D81037086A268d6ea63c53f91D412A2` 的 owner、operator、treasury 均为 `0x6F4d78fB59eC938cBAF65b9fc822aD04d00c155E`，`poolCount()=0`。这是当时状态，不证明后台已经持有该私钥。如果后台改用新地址，须先由有权钱包在链上设置 `setOperator` 和 `setTreasury`，然后重新核验；对未来新池生效，已创建池的 treasury 不随 Factory 更新。新地址只需放在后台，不需要把 owner 升级权放进无人值守服务。多矿机 BudgetPortfolioFactory 的 treasury 在初始化时设置，没有当前 Factory 的直接 `setTreasury` 入口；启用前单独核对。下表的双边份额费与多机服务费描述的是本开发分支；主网原 ShareMarket 在 2026-09-27 核对时尚不支持 `buyerFeeBps()`，不能把新版费率当成已上线。

| 费用 / 操作 | 当前合约行为 | 后台钱包动作 |
| --- | --- | --- |
| 停挖矿机恢复 `arm/start` | 只允许当时 Factory operator 调用 Pool `mine(bytes)` | 运营钱包付两笔交易 Gas；现有 mining supervisor 可发现新池并串行处理。 |
| 官网 / Firsto 购机执行 | 调用钱包支付 Gas，购机价从募集资金池支付 | 同一个后台地址可执行，但采购 keeper、恢复挖矿与提现不能并发使用同一 nonce。 |
| 挖矿平台 1% BEM | 池 `harvest()` 记账时**直接把 BEM 转至 pool.treasury** | 触发归集者支付 Gas；BEM 平台费无需另发提款交易。现有恢复挖矿 supervisor 不负责定时 `harvest()`。 |
| 份额市场卖方 1% + 买方 1% BNB | 开发分支的 ShareMarket 按该池 `treasury()` 记入 `bnbOwed`；主网尚须升级验收 | treasury 自行调用 ShareMarket `withdrawBnb()`，支付 Gas；脚本只领取链上实际记账金额。 |
| 整机出售平台 1% BNB | 现有内部出售结算记入池 `bnbOwed[treasury]`；Firsto 原生出售仍待合约实现 | treasury 自行调用该池 `withdrawBnb()`。未来 Firsto 路径必须保持相同权利。 |
| Firsto 出售前矿机 BEM 归集 | 目标流程要求 NFT 实际过户前严格验证该台矿机待领 BEM 为零，已领取 BEM 留在矿池并记入共同份额；当前 Firsto 卖方适配未实现。Firsto 批量购买路由在已核验成交中先领后转，但 Signed Ask V2 直购不自动领取 | 后台运营钱包可支付挂单前归集的 Gas；归集失败或成交时待领未归零，必须阻止过户。 |
| Firsto 成交时 NFT 过户 | Firsto `fillSignedAsk` 由买家支付售价并发起交易，NFT 在该交易中转给指定接收地址 | 原生成交网络 Gas 先由买家付。后台钱包不能在该买家交易内直接成为 Gas payer；如要平台承担，须成交后依据链上回执向买家限额返还，或证明 Firsto 支持真实代付路径。此补贴未实现，也不计为平台 1% 手续费。 |
| 多矿机项目官网采购服务费 1% | 项目在结算时从可退余款记入 `bnbOwed[treasury]` | 待多机项目完成部署及索引后，扩展收款执行器枚举该 Factory 的项目；当前脚本尚未覆盖。 |

## 收取 BNB 的脚本

`deploy/scripts/treasury-collector.mjs` 默认只读，查当前 Factory、ShareMarket 和全部已登记单机池的 treasury 债权。使用例子（地址为现有公开 Factory，不能当作新的部署确认）：

```sh
cd deploy
node scripts/treasury-collector.mjs --factory 0xcB24E7F96D81037086A268d6ea63c53f91D412A2
```

仅在后台配置好匹配 Factory treasury 的 `KEEPER_PRIVATE_KEY`、私有 journal 目录且明确启用发送时，才会发起**至多一笔** BNB 提款；脚本不接受命令行私钥。它读取当前实际应付款、模拟精确 `withdrawBnb()`、只在应付款超过预计最高 Gas 时提交，并限制 Gas 单价与累计预算。使用与采购、挖矿 keeper 相同的持久钱包锁和 BSC finalized 回执规则；签名原文、哈希和 nonce 在广播前持久化。RPC 返回不明时不擅自换 nonce，可通过显式 `--rebroadcast`、`--speed-up` 或 `--cancel-pending` 恢复。示例中的目录必须由服务账户独占、权限 0700：

```sh
node scripts/treasury-collector.mjs \
  --factory 0xcB24E7F96D81037086A268d6ea63c53f91D412A2 \
  --journal-dir /private/bemine/treasury-journal --send
```

同一后台钱包只能有一个交易执行点。矿机采购与停挖恢复优先；佣金收取安排在它们空闲时运行，不能靠多台服务器各自的本地锁协调。当前脚本是单次执行入口，没有注册定时服务，也不会主动归集 BEM。服务器日后正式部署前须检查运营地址、金库地址、Gas 余额、目录权限、进程隔离、服务顺序和真实交易回执。用户钱包的个人领取不通过这个后台私钥代签。
