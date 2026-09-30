# v4 Authority 中继人工恢复

中继默认只对未完成交易查询链上状态，不会自动重播、替换或释放 Gas 钱包 nonce。恢复前先核对私有 journal、BSC 交易哈希、当前 nonce 和签名动作；保留原 journal 备份。以下命令仅适用于独立的 v4 签名服务，不适用于 v2/v3。

**先隔离发送者。** 停止 `pinkuang-purchase-v2.service`、`pinkuang-v4-signer.service`、`pinkuang-v4-purchase.service` 和 `pinkuang-v4-mining.service`，逐一确认处于 `inactive`；同时排查其他机器或手动进程是否也持有原 Gas 地址 `0xA285…6619`。核对 v2 未决 journal、BSC `pending` nonce 和 v4 journal 后，才能将 `BEMINE_V2_GAS_SENDER_DRAINED=1` 作为已完成接管的断言。必须使用 `authority-relay-recovery.mjs`：它在启动 `systemd-run` **之前**查询四个 unit，任一活跃或状态不明即拒绝，避免 `Conflicts=` 先自动停掉 v2、掩盖其原先在跑的事实。CLI 还要求 30 秒内生成的启动前检查标记，并在独占的 transient unit 中再次核对状态；直接运行下方内部 CLI 命令没有标记会被拒绝。这个本机检查不能代替跨机器核对。恢复期间不要重新启动发送服务。`systemd-run` 的 `Conflicts=`/`After=` 同样包含这四个发送者，作为检查后的竞态互斥。

以下命令从服务器上的 v4 部署根目录执行；将 `/ABS/PATH/TO/v4/deploy`、`/private/action.json`、RPC 和哈希替换为实际核验值。命令文件须能由 `pinkuang-v4-signer` 读取，且为私有 0600 文件；`/var/lib/pinkuang-v4-signer`、`keeper`、`authority` 目录均应为该用户可读写的 0700 真实目录，journal 为 0600 普通文件，不允许符号链接。**不要**在 shell 中导出 `KEEPER_PRIVATE_KEY` 或使用 `KEY=… node`；发送 CLI 只接受 systemd `LoadCredential`。复用原受保护凭据文件，不生成另一份私钥。

此人工工具只随未来独立签名服务的私有运行目录安装，不能从公开的预创世控制台包启动。私有运行目录需包含 `scripts/authority-relay-recovery.mjs`、`scripts/authority-relay.mjs` 及其经测试核对的完整相对导入闭包（`budget-multicall-read`、`keeper-credential`、`official-market-discovery`、`purchase-keeper`、`shared/authority-typed`、`shared/original-gas-wallet`、`src/firsto-purchase`）。目前预创世发布包有独立 allowlist，明确排除这些发送与恢复工具；未建好私有签名运行目录时，不使用此恢复命令。

- `signed-awaiting-manual-broadcast`：原始签名交易及哈希已经 fsync 到 journal，`broadcastCount=0`。确认要发送时，使用原来的管理员命令文件、同一个 journal 和准确哈希执行：

  ```sh
  BEMINE_V2_GAS_SENDER_DRAINED=1 \
    /usr/bin/node /ABS/PATH/TO/v4/deploy/scripts/authority-relay-recovery.mjs \
    --command /private/action.json \
    --journal /var/lib/pinkuang-v4-signer/authority/authority.json \
    --rpc https://YOUR_BSC_RPC --send --rebroadcast-signed --expected-hash 0x... \
    --max-gas-bnb 0.5 --max-gas-price-gwei 3
  ```

  原命令文件丢失时，可把 `--command /private/action.json` 换成 `--authority 0x... --expected-codehash 0x...`；工具从私有 journal 中的 calldata 重建并验证管理员签名、当前角色与 nonce，仍只重播原始字节。管理员授权按链上最新区块时间已经过期或不足 30 秒时，此入口拒绝广播；不会发送一笔必然回滚的交易。RPC 结果不明时先查回执，不能反复执行。
- `reverted`：先查明回滚原因。交易必须在 BSC 最终确定，journal 的交易、区块、Gas 账本和链上 nonce 均匹配后，才能归档已确定失败的交易。此动作不签名、不广播，不需要加载私钥：

  ```sh
  BEMINE_V2_GAS_SENDER_DRAINED=1 \
    /usr/bin/node /ABS/PATH/TO/v4/deploy/scripts/authority-relay-recovery.mjs \
    --command /private/action.json \
    --journal /var/lib/pinkuang-v4-signer/authority/authority.json \
    --rpc https://YOUR_BSC_RPC --acknowledge-failure 0x...
  ```

  新操作需由管理员重新审核并签名。
- `unknown-wallet-nonce-manual-review`：只有**另一笔交易已在 BSC 最终确定**、交易发送者与原 Gas 钱包相同、nonce 与原 journal 相同、区块仍在规范链上，才可归档原已签字节。先从独立链上浏览器核对替代交易，再使用原始哈希和替代哈希执行下列只读核验及 journal 归档；此动作不加载私钥，不签名也不广播：

  ```sh
  BEMINE_V2_GAS_SENDER_DRAINED=1 \
    /usr/bin/node /ABS/PATH/TO/v4/deploy/scripts/authority-relay-recovery.mjs \
    --journal /var/lib/pinkuang-v4-signer/authority/authority.json \
    --authority 0x... --expected-codehash 0x... \
    --rpc https://YOUR_BSC_RPC \
    --acknowledge-replacement 0xORIGINAL_HASH --replacement-hash 0xFINALIZED_REPLACEMENT_HASH
  ```

  工具保留完整原始签名交易到私有归档。仅看到 `pending` nonce 变化、交易池丢弃，或管理员签名过期，都**不能**释放钱包指针；如果同 nonce 仍空闲，只能按下方独立、显式的过期签名取消流程处理。
- 独占锁记录损坏：先确认 v4 服务进程已退出，再以 v4 服务用户运行 `PINKUANG_KEEPER_STATE_ROOT=/var/lib/pinkuang-v4-signer/keeper node scripts/authority-relay-lock-recovery.mjs --journal /var/lib/pinkuang-v4-signer/authority/authority.json`；钱包锁用 `--wallet 0x...`。正常的 `flock-v1` 旧记录无需恢复。工具先取得同一 inode 的内核锁，仅对已超过 60 秒、无活跃持有者的旧式或截断记录原地重建元数据，绝不删除锁文件；身份或活跃状态不明时保留原文件并停止。

## 管理员签名过期且原交易已签未发

`signed-admin-authorization-expired-review-required` 表示原始字节不能再安全广播。保持上述三个发送服务为 `inactive`，保留 journal 和钱包锁指针；用至少两个独立 BSC RPC 核对原哈希的交易与回执、钱包 `latest`/`pending` nonce、最新区块时间，以及私有 journal 中原 attempt 的 `broadcastCount`。如果另一笔同 nonce 交易**已经最终确定**，走上面的 `--acknowledge-replacement`。若 nonce 仍空闲，不得删除 journal、手工改 `phase`、把过期字节重播，或借另一个发送者抢占 nonce。

只有原记录是唯一的 `phase=signed`、`kind=purchase`、`broadcastCount=0` attempt，且是带 deadline 的管理员签名动作，才能显式运行取消。`executeOperation` 没有管理员 deadline，不能使用。下列三个命令均由同一个受保护恢复入口启动；发送命令会使用原 systemd `LoadCredential`，持有同一个 journal 锁与 Gas 钱包锁，并再次检查三个发送服务。示例里的哈希与 Authority runtime codehash 必须从私有 journal 和独立部署证明核对，不能猜测。

```sh
BEMINE_V2_GAS_SENDER_DRAINED=1 \
  /usr/bin/node /ABS/PATH/TO/v4/deploy/scripts/authority-relay-recovery.mjs \
  --journal /var/lib/pinkuang-v4-signer/authority/authority.json \
  --authority 0x... --expected-codehash 0x... --rpc https://YOUR_BSC_RPC \
  --send --cancel-expired-signed --expected-hash 0xORIGINAL_HASH \
  --max-gas-bnb 0.5 --max-gas-price-gwei 3
```

工具再次核对 chainId 56、链上最新时间严格超过签名 deadline、原交易与回执都不可见、`latest == pending == journal.nonce`、钱包代码为空、余额和累计 Gas 预算足够。它只签同 nonce、零值、空 data、21,000 Gas 的 type-0 自转账；Gas 价格至少等于原签名价格，且固定不得超过 3 gwei 或命令上限。取消 raw 和哈希作为第二个 attempt **先 fsync**；广播前再检查链状态并持久增加 `broadcastCount`。任何核验结果未知都保留 wallet hold，不能发新动作。一次命令只执行这一笔人工指明的取消，不开启自动重试。

如果在签名持久化后崩溃，或广播 RPC 结果未知，先分别核查**原哈希和取消哈希**的交易与回执。只有两个哈希均不可见、nonce 仍空闲、签名仍过期及 EOA/费用核验继续通过时，才可人工重播 journal 中**同一取消 raw**；此命令从不重签或更改费用：

```sh
BEMINE_V2_GAS_SENDER_DRAINED=1 \
  /usr/bin/node /ABS/PATH/TO/v4/deploy/scripts/authority-relay-recovery.mjs \
  --journal /var/lib/pinkuang-v4-signer/authority/authority.json \
  --authority 0x... --expected-codehash 0x... --rpc https://YOUR_BSC_RPC \
  --send --rebroadcast-cancel --expected-hash 0xCANCEL_HASH \
  --max-gas-bnb 0.5 --max-gas-price-gwei 3
```

取消成功后，用以下**不加载私钥、不广播**的动作触发原有两次确认、BSC finalized 与 Gas 入账，再重验规范区块、交易/回执与 21,000 Gas 空自转、原哈希无回执和 finalized nonce，归档两个原始签名字节并清理钱包指针：

```sh
BEMINE_V2_GAS_SENDER_DRAINED=1 \
  /usr/bin/node /ABS/PATH/TO/v4/deploy/scripts/authority-relay-recovery.mjs \
  --journal /var/lib/pinkuang-v4-signer/authority/authority.json \
  --authority 0x... --expected-codehash 0x... --rpc https://YOUR_BSC_RPC \
  --acknowledge-expired-cancel 0xORIGINAL_HASH --cancel-hash 0xCANCEL_HASH
```

若原交易先上链，`reconcilePending` 按实际胜出的回执结算；原交易回滚时用其哈希走 `--acknowledge-failure`，不能把它写成取消成功。取消回滚、两个回执冲突、RPC 看不到可能已广播的交易、重组或 Gas/身份不一致时保持人工复核锁，不自动签第三笔。未上线私有签名运行目录或未完成独立双 RPC 核查时，维持原 fail-closed 状态。

新交易的 CLI 发送还必须显式提供经审核的 `--gas-limit`（1–10,000,000）；HTTP 中继已有按操作固定的上限。两条路径都不执行 `eth_estimateGas` 模拟。
