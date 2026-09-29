# 独立 v4 部署台

v4 是一套全新合约图和独立部署记录。`FreshPoolFactory` 只检查自己登记的矿机，不读取或要求旧版 Factory 停建；服务端对已核验的新图也不执行旧版建池门禁。旧 `/bemine-v2/` 与 `/pinkuang-deploy-v3/` 保持原样。v3 已发生的链上交易及服务器记录不得删除或冒充 v4。

预算项目 ABI 中保留的 `legacyFactory` 字段属于合约旧命名；原子初始化会把它设为 **同一次 v4 部署中的核心 Factory**。它不指向 v1/v2/v3 的地址。

部署台单独使用 `/pinkuang-deploy-v4/`、`pinkuang-deploy-v4.service`、端口 4177 和 `/var/lib/pinkuang-deploy-v4/journal.sqlite`。公网入口必须先启用 nginx Basic Auth，部署台页面、部署产物和 `/api/` 都受同一访问控制保护；只用钱包会话或 API 限流不够。公网 HTTP 进程只配置 Gas 钱包公开地址，不加载、复制或派生私钥；公开地址本身不能证明独立签名服务已就绪，第二阶段继续保持关闭。旧版安装已生成的 `keeper-v4.key` 副本须先核实没有其他使用者，再单独退役，不由发布脚本自动删除。中继和自动购机默认关闭。安装脚本从现有服务读取一次 BSC RPC 地址作为配置来源，运行后不查询任何旧合约。部署产物的合约内容以 `artifactDigest` 绑定；浏览器与后端发布源码使用同一个受审 `sourceHead`，允许后续服务修复而保持已部署合约内容不变。安装前核对归档和服务器配置的 SHA256。

首次安装或修复现有公网 v4 部署台前，由服务器运营者在服务器交互式执行 `htpasswd -B -c /etc/nginx/pinkuang-deploy-v4.htpasswd <operator-name>`，再执行 `chown root:www-data /etc/nginx/pinkuang-deploy-v4.htpasswd` 和 `chmod 0640 /etc/nginx/pinkuang-deploy-v4.htpasswd`。密码不要放进仓库、shell 参数或部署包。对现有 nginx 片段先独立核对 SHA-256，再以 `python3 deploy/ops/v4/protect-console.remote.py --current-snippet-sha256 <审核值> --dry-run` 预览，去掉 `--dry-run` 后生效。脚本验证未认证页面、产物和无需会话的产品图 API 均返回 401、旧产品保持 200；正式修改后若 nginx 校验或 v4 探针失败，脚本停止 v4 服务并保留受保护片段，绝不回滚为公网片段。现有控制台未实际完成此步骤前仍是公网可访问状态，不应进行 Stage 1 签名。

现有预创世部署台的热钱包凭据隔离更新使用 [UPDATE_PREGENESIS_CONSOLE.md](./UPDATE_PREGENESIS_CONSOLE.md) 的固定哈希、空日志和回滚核验步骤。

**第二阶段解除冻结条件**：源码现在提供独立 signer 经私有 Unix socket 返回 EIP-191 证明；挑战绑定链 ID、网页来源、当前完成的部署记录、产物摘要、Gas 公开地址和一次性 nonce，公网进程验签后才会返回 `credentialVerified:true`。仅配置公开地址、文件存在或网页显示地址均不能放行。生产尚未安装和核验这个受限 signer，且 `BEMINE_FRESH_STAGE2_HOLD=1` 继续禁止第二阶段写入；证明成功本身也不会解除冻结。

Stage2 激活前的离线工件由 `package-stage2-attestor.mjs --out <独立私有发布目录>` 和 `prepare-stage2-attestation.mjs <输入.json> <输出.json>` 生成。前者只复制受审源码的 19 个静态依赖、package/lock 和哈希清单，私钥与 HMAC 凭据均不入包；后者输出独立 signer unit 和公网部署台 drop-in。所指的 signer release 必须是这份独立包，经清单哈希与源码提交核对并安装运行依赖后才能审查安装。两个 unit 均固定 `AUTHORITY_RELAY_ENABLED=0`，公网 `AUTHORITY_RELAY_PUBLIC_ENABLED=0`，signer 固定 `AUTHORITY_SIGNER_ATTEST_ONLY=1`；公网 unit 保持 `BEMINE_FRESH_STAGE2_HOLD=1`。工件只生成文件，不安装、启动、广播或解除冻结；仍需单独核对受保护 Gas 凭据来源、独立用户/组、socket 权限和部署钱包链上结果。

独立发布目录和其中代码须由 root 持有、供 signer 只读；私钥仅通过 systemd `LoadCredential` 装入 signer 进程，不能复制进发布目录或公网服务。安装后仍须核对实际 unit 的所有有效 drop-in；清单和生成器不能证明服务器现状。

后续 cutover 草案的 `runtimeRelayDropIn` 沿用旧字段名，但仍固定关闭公网交易中继；`signerUnit` 指向同一独立私有 signer 发布目录，且同样是仅证明模式。产品代发需另行审查，不能把这份草案改成交易发送单元直接安装。

源码中的独立 Authority signer 可用 `AUTHORITY_SIGNER_ATTEST_ONLY=1` 且 `AUTHORITY_RELAY_ENABLED=0` 仅提供上述证明；这种模式下产品审核代付路由返回 503，不能广播交易。公网进程使用仅有 HMAC 凭据的本地代理；`server/authority-signer.mjs` 在独立 `pinkuang-v4-signer` 用户下持有 Gas 凭据，监听 `/run/pinkuang-v4-relay/authority.sock`，不监听公网 TCP。产品中继只有经独立审查启用后才转发准确的 `POST /api/journal/authority-relay` 和 `GET /api/journal/authority-relay/status`，请求限 64 KiB、回包限 64 KiB、45 秒超时。短时断言绑定方法、路径、请求体 SHA-256、会话地址和期限，signer 拒绝重放；正式启用时仍独立重验管理员 EIP-712 签名、当前新合约图、角色、codehash、nonce 与 Gas 预算。公网进程若被完全控制，攻击者可能伪造会话断言，但仍不能伪造管理员的业务签名；因此这个隔离降低私钥暴露面，不能代替管理员签名核验。

离线 cutover 草案中的普通 runtime 不加载任何私钥或 IPC 凭据。启用前须另外审查 `runtimeRelayDropIn` 和 `signerUnit`：创建专用用户 `pinkuang-v4-signer` 与专用组 `pinkuang-v4-relay`，仅公网服务用户和 signer 用户加入该组；UDS 父目录 0750、socket 0660。公开服务只加载独立随机 32 字节 HMAC 凭据，Gas 私钥只通过 systemd `LoadCredential` 交给 signer。需把同一已核验 v4 部署记录和 Authority 激活记录按 SHA256 核对后复制到 signer 私有的 `/var/lib/pinkuang-v4-signer/`，不能给 signer 读写公网 journal DB。签名 journal 与 nonce 锁只在 signer 私有根目录。用户选择继续使用原 Gas 公开地址 `0xA285…6619`，草案为私有 signer 指向原受保护凭据 `/etc/pinkuang/keeper.key`，不创建新密钥副本，也不把它交给公网进程。当前 v2 购机服务仍在发送域内，两版日志和锁不互通，因此 v4 signer 与自动购机保持关闭。启用前须停用并核对全部 v2 发送者、逐笔对账未决日志和链上 pending nonce；之后才能把 `BEMINE_V2_GAS_SENDER_DRAINED` 从 `0` 改为 `1`。这个变量只是已完成人工核对的断言，不是链上证明；若 v2 继续运行，则必须先实现共用的 nonce 调度与持久账本。

Authority 的无管理员签名 `mine(bytes)` 现在只可执行 arm/start；`reclaim(bytes32)` 要管理员签署准确目标、准确 calldata 的 EIP-712 `executeApprovedOperation`。HTTP 签名路由还要求目标是当前新 Factory 登记的矿池，外层 `mine(bytes)`、内层 `reclaim(bytes32)` 都是标准 ABI 编码，且 key 与当前矿机链上 key 一致。自动 keeper 在签名通道就绪前必须暂停 reclaim，不能把失败操作反复重试。

安装完成只表示可用部署台。用户需在自己的 MetaMask 中逐笔确认 16 笔新图部署和 7 笔 Authority 接线；服务器不能代签。链上完成后，再独立准备 `/bemine-v4/` 前端、索引和交易服务，核验新合约地址、权限及完整业务流程后开放。不能把 v2/v3 的矿池、份额、订单或旧索引写入 v4。

预部署控制台设置 `BEMINE_FRESH_CONSOLE_PRE_GENESIS=1`，市场、报价、采购队列及旧记录导入均不可写。部署页也不加载旧版份额市场及其浏览器交易记录。当前另设 `BEMINE_FRESH_STAGE2_HOLD=1`，在失败交易恢复流程通过链上验证前，禁止新建或推进 Authority 七步日志，页面也禁用第二阶段按钮；第一阶段及只读核验可继续。两项标志都不是产品上线开关。产品开放需要另外实现经核验的新图交易门禁、独立索引、审核中继及购机流程。已有 v4 服务的修正版使用 `update-console.remote.py` 更新；脚本要求新部署与 Authority 日志均为空，并保留旧站及其服务。

新旧合约完全独立，无法通过新合约自动阻止旧版使用相同矿机编号。开放建池前必须核对 NFT 当前所有权和可购买状态；这项运营核对不把旧合约引入 v4 的链上执行路径。复用 Gas 地址仅涉及发送者的交易序号，不让新合约读取旧合约；启用 v4 发送端仍须完成上一段所述的旧端排空和权限核对。

第二阶段完成后，`prepare-fresh-cutover.mjs` 仅生成 v4 产品服务的离线草案，`activationAllowed` 固定为 `false`。它不会替用户发送交易、启动服务或改 nginx。实际开放产品前仍须核对最终链上回执、角色、索引、审核代发及购机流程。

产品后端离线包使用 `node deploy/scripts/package-fresh-product-backend.mjs --input reviewed-cutover-input.json --out /absolute/new-release-dir`。输入需包含完成的新图部署记录、对应部署产物、七步 Authority 记录，以及当前 `/api/journal/product-graph` 在 `fresh-active` 且非 stale 时返回的 `manifest`，各自通过 `recordPath`、`bundlePath`、`activationPath`、`manifestPath` 指定。打包前会用新图记录逐项核对 manifest 地址、codehash、激活区块和 Gas 公开地址，再将固定地址清单、部署台 API 与独立 chain-index 完整依赖写进哈希发布清单。索引启动时只从该发布目录中的 `fresh-product-manifest.json` 读取四个新合约地址和起始区块，拒绝环境变量覆盖和使用旧索引数据库。

此包仍是离线草案：公开 API 的产品写入、Stage2、Authority 代发和自动购机继续关闭。生成包或草案不证明链上部署完成，也不代表 `/bemine-v4/` 产品前端已发布。安装前还须按清单验文件哈希、当前链上区块及角色，独立验收产品前端和真实业务流程。

第二阶段若某笔交易已在链上失败、被取消或替换，七步日志会先终止，页面不会自行重发或清除记录。候选恢复路径见 [STAGE2_RECOVERY_REVIEW.md](./STAGE2_RECOVERY_REVIEW.md)：仅对已最终确认且已知同 nonce 赢家的交易归档不可变历史、复核权限前缀，再由用户单独确认同一动作的新 nonce。此路径仍须独立审查和可弃用分叉演练，生产 `BEMINE_FRESH_STAGE2_HOLD=1` 保持不变。持续挖矿 claim 失败阻塞转让/出售、跨版本矿机重复登记以及对管理员提供的市价参考和在线服务的依赖，仍是正式开放前需评估的边界。

v4 自动购机启用后，keeper 的稳定 `.lock` inode 与私有 `.lock.meta` 共同保护重启恢复：只有持有内核 flock、两者 inode/资源一致且旧 PID 已退出时，才可自动修复被截断的锁记录。首次创建 `.lock` 后、`.meta` 落盘前若崩溃，仍可能留下没有证明的空锁；这时服务必须拒绝签名并由运维停止所有相关发送者、核对链上 nonce 与未决交易、在保留 lock inode 且持有 flock 的条件下人工恢复，不能直接删除锁文件或仅凭 PID 猜测。现有 Authority 恢复命令不适用于逐池购机锁。
