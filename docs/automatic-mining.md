# 停挖检测与自动恢复

购买入口只接收链上状态为 `1`（正在挖矿）、纯验证、非最优的矿机；NFT 转入 Vault 后，原挖矿状态和后续收益仍跟着该 NFT。Vault 已有 `mine(bytes)`，只允许当前 Factory operator 为本池 NFT 调用 Mining 的 `arm`、`start`、`reclaim`，转发前后核对 NFT 归属和矿机身份。智能合约不能自己定时发交易，所以服务端 `deploy/scripts/mining-keeper.mjs` 持续读链、签名并发起恢复交易；不需要升级 Vault。

当前自动恢复只覆盖**已购买、Vault 处于 Active、协议状态为 3（正常停挖）、非最优、已有明确 stopBlock、超过链上 `STOP_COOLDOWN` 区块**的矿机。真实协议在 stop 时会把验证与未验证权重都清零，所以不能用停挖后的权重判断购买时质量；购机合约在接收 NFT 前已强制纯验证、非最优。状态 0/2、未知状态、矿机撤销或证明无法模拟通过时不会盲目上链；运行结果会说明原因，待人工核对。Listed/Closed 等状态下 Vault 不接受 `mine`，因此不会在出售流程中自动重启。多矿机项目的子 Vault 由 Factory 登记，`mining-supervisor.mjs` 会自动发现已有和新建子池。

服务端先从 [TapeOut 官网向量库](https://tapeout.net/pod/pod-vectors-all.json) 下载对应 task 的 256 条向量，重建 Merkle 根并核对。检查 operator、Factory 注册、池当前实际 NFT、Miner 身份、冷却区块及链上新增反例后，用 `eth_estimateGas` 完整模拟 Vault `mine(arm)`。arm 最终确认后，再核对一次反例，使用该交易的规范区块哈希生成抽样和 Merkle 证明并模拟 `mine(start)`；锚点超过保守的 60 块会重新 arm，最多自动重试两次。两步都需要独立链上交易，不能原子化为一笔。

在 `deploy/` 下运行；默认只读。推荐启动 Factory 级 supervisor，自动扫描 `poolCount/allPools` 并轮流检查所有现有及新建子池；有待确认交易或已 arm 的池优先处理，串行使用同一个 operator 钱包。每个池有独立 journal 文件，目录放在服务器受保护存储，权限 0700、文件 0600，不能放用户浏览器缓存、公开静态目录或仓库。`--send` 读取进程环境里的 `KEEPER_PRIVATE_KEY`，必须是当时的 Factory operator，并支付两笔交易的 Gas。先用只读模式检查，再启用发送：

```sh
node scripts/mining-supervisor.mjs --factory 0xFACTORY --once
node scripts/mining-supervisor.mjs --factory 0xFACTORY --journal-dir /private/path/mining --send
```

如只监控一个池，可以用 `node scripts/mining-keeper.mjs --factory 0xFACTORY --pool 0xPOOL --journal /private/path/mining-pool.json --send`。一次只用同一钱包运行一个签名执行器，也不要与采购 keeper 或手工钱包同时占用该 operator 的 nonce。本机钱包锁与采购 keeper 共用；多服务器之间仍需运维层面保持单一 operator 执行点。脚本把原始签名交易、哈希、nonce、Gas 预算写入私有 journal 并 fsync 后才广播；结果不明不会换 nonce 重发。只有交易达到两次规范确认且被 BSC `finalized` 包含后，才放行下一步。脚本不自动加价或取消；如果广播结果不明、nonce 被其他交易消耗、交易失败或验证发生变化，保留 journal 和钱包锁指针，先人工对照链上结果。默认每个池 Gas 总预算 0.02 BNB、Gas 单价上限 1 Gwei，均可按运行环境调整。

现有 [真实协议 fork 测试](../contracts/test/fork/MiningStartProbe.t.sol)验证合约持有人可以 arm/start、停挖状态为 3、权重归零、冷却超过 1200 **区块**和 1–64 区块的锚点窗口；[生产 Vault fork 测试](../contracts/test/fork/PoolRewardsFork.t.sol)验证 Vault `mine(bytes)` 可使用真实证明恢复。`deploy/scripts/mining-keeper.test.mjs`核对向量根、证明、状态筛选与账本动作。它们不代表服务端已在主网持续运行，也不保证外部协议以后仍沿用当前状态和证明规则。
