# v4 Authority 中继人工恢复

中继默认只对未完成交易查询链上状态，不会自动重播、替换或释放 Gas 钱包 nonce。恢复前先核对私有 journal、BSC 交易哈希、当前 nonce 和签名动作；保留原 journal 备份。以下命令仅适用于独立的 v4 签名服务，不适用于 v2/v3。

- `signed-awaiting-manual-broadcast`：原始签名交易及哈希已经 fsync 到 journal，`broadcastCount=0`。如确认要发送，使用原来的管理员命令文件、同一个 journal 和准确哈希执行 `node scripts/authority-relay.mjs --command /private/action.json --journal /var/lib/pinkuang-v4-signer/authority/authority.json --rpc https://YOUR_BSC_RPC --send --rebroadcast-signed --expected-hash 0x... --max-gas-bnb 0.5 --max-gas-price-gwei 3`。此入口不会再签名，只能广播 journal 中的原始字节一次；RPC 结果不明时先查回执，不能反复执行。
- `reverted`：先查明回滚原因。交易必须在 BSC 最终确定，journal 的交易、区块、Gas 账本和链上 nonce 均匹配后，才能执行 `node scripts/authority-relay.mjs --command /private/action.json --journal /var/lib/pinkuang-v4-signer/authority/authority.json --rpc https://YOUR_BSC_RPC --acknowledge-failure 0x...`。这一步仅归档已确定失败的交易，不签名、不广播。新操作需由管理员重新审核并签名。
- 独占锁残留：先确认 v4 服务进程已退出，再以 v4 服务用户运行 `PINKUANG_KEEPER_STATE_ROOT=/var/lib/pinkuang-v4-signer/keeper node scripts/authority-relay-lock-recovery.mjs --journal /var/lib/pinkuang-v4-signer/authority/authority.json`；钱包锁用 `--wallet 0x...`。工具只删除至少 60 秒、内容与目标一致且 PID 已死亡的锁。锁文件损坏、PID 活跃或无法确认时会拒绝删除，应人工调查。

新交易的 CLI 发送还必须显式提供经审核的 `--gas-limit`（1–10,000,000）；HTTP 中继已有按操作固定的上限。两条路径都不执行 `eth_estimateGas` 模拟。
