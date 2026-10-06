# v4 正式产品运行时切换

本工具必须输入经独立验签、精确源码与源码产物配对核验的 release pair，不能把部署成功或 CI 全绿当成运行环境验收。正式 manifest 是 `fresh-product-manifest.json`（kind `fresh-v4-index`），其 SHA 是文件规范字节哈希；不能换成前端 `frontend-manifest.v4.json`。

## 发布工件与配置

按现有 `verify-fresh-release-pair.mjs` 生成 bound plan，再用 `stage-fresh-release-pair.remote.py` 只暂存。CI `frontend.tar.gz` 内容已平铺，`index.html`、`data/frontend-manifest.v4.json`、`_next/` 直接位于 productRoot。这里的 current 指向 productRoot；若使用原始 buildFreshProduct 的中间目录，必须先按正式打包流程导出，不能混用其 public 子目录。

离线生成器 `prepare-product-runtime.py` 参数为 `--pair-plan`、`--pair-sha256`、`--inputs`、`--gas-limits`、`--out`。inputs 只包括 root 私有 Stage1 完成记录和 Stage2 完成记录的路径及 SHA256；不要含私钥。Gas 输入必须显式给出，本次确定值是 Authority 同一 journal 0.01 BNB、采购每池 journal 0.01 BNB、挖矿每池 journal 0.02 BNB、最高 1 gwei。这不是跨所有 journal 的共享总预算。

产品 API 4187、索引4184、Authority signer、purchase worker、mining worker 使用同一源码发布包。公共进程只有 HMAC credential；Gas credential 只进入私有 signer/worker。现存 HMAC 文件继续 root0600；`/etc/pinkuang-v4` 仅为 root:relay0750，公开图输入和 drain proof 为 root:relay0640。产品私有 DB0700目录不授权 signer 读取；signer 的 HMAC assertion 使用独立认证路径。

EnvironmentFile **只能包含4个 RPC 白名单项**：DEPLOYMENT_JOURNAL_RPC_URL、BEMINE_READ_RPC_URL、CHAIN_INDEX_RPC_URL、CHAIN_INDEX_LOGS_RPC_URL。不得复制 console 的整个环境，避免覆盖 unit 的 origin、HOLD、PRE_GENESIS 和 relay 开关。日志源使用已验证的新 index 运行配置，不重新照搬只保留1024块历史的旧服务。

新索引 DB `/var/lib/pinkuang-index-v4/index.sqlite` 已预热。后续 source 更新必须保留该 DB、起始块和完整历史校验，unit/env SHA 不符时停止。不能 pull、重置游标、删除 DB 或继承旧 v2 DB。

## 分阶段执行

每一步都使用 `activate-product-runtime.remote.py --plan /root/...json --plan-sha256 <reviewed SHA> --mode <phase> --evidence /root/pinkuang-v4-product/<new-unique-phase>`。该工具不随 import 执行。

1. `dry-run`：核文件 inventory、所有 SHA、两个图、公开与私有角色、旧维护 vhost、新路径、现存 attestor 和 index 基线。无写入。
2. `install-readers`：锁定 npm ci，禁安装脚本；导入5个入口验证闭包；安装全新的产品 DB/API，更新独立 index runtime，保留 index DB。原 console、attestor、v2 sender/index 均不变。产品只在 loopback，域名仍维护。
3. 单独执行 `legacy-gas-drain.remote.py` 的 reviewed plan：先 `--inspect`；准备明确切换时才 `--stop-and-attest`，禁用并停止所有已登记旧 Gas sender；未知交易必须停在这里。逐 journal 校验 calldata/nonce、canonical finalized 回执、Gas钱包 latest/pending/finalized nonce、unit inactive+disabled。生成固定 `/etc/pinkuang-v4/legacy-drain.json`。不清 journal、不猜测 nonce、不重启旧 sender。
4. `enable-automation`：完整近期 index 门禁与实时链上 drain 验证通过后，才替换原 attestation-only signer，并启动2个新 worker。等待真实成功扫描 heartbeat 和 HMAC-only machine proof；这不是伪造钱包会话，不产生持钥挑战签名。signer 保留 tapeout 的只读 attestation origin，真实 relay origin 仅 bemine。worker unknown 状态 exit2 保持停机，不能被 systemd 自动重试。
5. `publish`：再次查 index、machine proof，且本机 product-graph 必须 current/verified/fresh-active、operationalReady=true、userExitReady=true、图和 Authority/Gas/artifact 全匹配。CAS 切换 current 与**新域名独立 vhost**，nginx -t 通过才 reload；有界等待旧 worker 退出。公网 HTML/manifest 必须字节一致，Next.js 文件/Cache-Control 实测，BEM 参考价精确 alias 的响应须新鲜。部署/升级入口404、会话401；旧网站和 console 保持原状态。
6. `finalize-enable`：发布验收后显式 enable 全部5个 v4 unit，仅持久化开机启动，不重启机器、不重启运行服务。旧 sender继续disabled。若 enable 部分失败，只撤销本步新增的开机链接。

普通成员的认购、交易、领取、退款、撤单由用户钱包支付 Gas。平台 Gas 钱包仅承担必要后端自动化手续费，调用 value=0；购机本金由矿池合约支付。

## 已披露的账本外交易迁移

旧 worker 账本与钱包指针必须原样保留。若链上另有已完成交易，先逐笔公开核对交易哈希、nonce、发送方、目标、value、原始 calldata **字节**的 SHA256、区块号/哈希、回执状态与最终确认，并确认用户接受这些已披露交易之后继续切换。不能把“继续”记录成操作者身份或另一发送端已确认停机。2026-09-30 本次接受范围仅为已披露 nonce 1–3，用户原话为“直接开启吧”“我要进行测试 然后上线了”。

可审阅的 drain plan 使用可选 `acknowledgedExternalTransactions` 精确列表（每项仅上述9个字段）和 `expectedCutoverNonce`，以及 `externalMigrationAcknowledgement`：`userInstructions` 保存原话，`scope` 为 `continue-after-disclosed-transactions`，`transactionOriginConfirmed` 必须为 false。本次明确固定 cutover=4；任何新增 nonce 或 pending/finalized 不一致均拒绝。原 worker 证据与迁移证据的 nonce 必须连续覆盖 0–3，不能重叠、遗漏或只提供最高 nonce。

`--inspect` 只返回待写证据与摘要，不停进程、不生成正式文件。经审核后 `--stop-and-attest` 仍先停止已登记旧 sender，再扫描本机所有持同类 Gas 凭据的自动发送进程、复查全部链上证据和最终 nonce。通过后 create-only 写入 root:relay0640 的 `/etc/pinkuang-v4/external-finalized-migration.json`，明确 kind 为 `external-finalized-migration-evidence`，随后才写固定 drain proof。文件已存在时拒绝覆盖；失败遗留证据应保留复核，不自动重试覆写。

为复用已验签的 6a runtime 验证器，drain 的 `journals` 兼容数组仍包含所有已确认交易。迁移项明确标注 `evidenceKind`、独立 `evidencePath` 和 `evidenceSha256`；历史字段 `journalSha256` 在该项仅表示**独立迁移证据文件**的摘要，`journalSha256Meaning` 明确此语义，绝不仿造旧 worker journal，也不表示这些换币/授权操作由业务 worker 执行。此扩展只属于运维工具，正式业务 runtime 的源码和已验签包保持原样。

## 失败与恢复

只读安装失败会 CAS 恢复原 index unit、保留新 DB/nonce记录/发布工件并停止新公共 API；已经写入的 root 配置保留作证据，重试不能直接覆写。自动化失败会停止全部新发送者、CAS 恢复原只读 attestor；**绝不自动重新启动 v2 sender**。前端发布失败只撤销自己的 vhost/current，不更改链上状态。

手动恢复/加速/取消未知交易时，必须先停止并确认4个发送者：旧 `pinkuang-purchase-v2.service`、新 `pinkuang-v4-signer.service`、`pinkuang-v4-purchase.service`、`pinkuang-v4-mining.service`。共享 nonce 锁不是停止并发发送者的替代品。恢复使用现有 Authority recovery 工具、同一 journal 和全局锁，不能删除锁或写新的 nonce。恢复后重新核验回执、drain和 readiness；未知状态不得发布可操作页面。

## 验证范围

Linux离线测试覆盖 CAS、拒绝覆盖/符号链接、预算与角色边界、未知worker停止、HMAC-only机器探针、产品集成未就绪拒绝、stale index/超过120块拒绝、stale价格拒绝、worker失败恢复原attestor且不启动旧sender、nginx失败回滚自己的链接、部分开机启用失败仅撤销本步链接。离线测试不代表生产已启用；现场产物、RPC、完整索引、签名角色和浏览器仍须按各阶段验收。
