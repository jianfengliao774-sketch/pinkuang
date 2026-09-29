# 独立 v4 部署台

v4 是一套全新合约图和独立部署记录。`FreshPoolFactory` 只检查自己登记的矿机，不读取或要求旧版 Factory 停建；服务端对已核验的新图也不执行旧版建池门禁。旧 `/bemine-v2/` 与 `/pinkuang-deploy-v3/` 保持原样。v3 已发生的链上交易及服务器记录不得删除或冒充 v4。

预算项目 ABI 中保留的 `legacyFactory` 字段属于合约旧命名；原子初始化会把它设为 **同一次 v4 部署中的核心 Factory**。它不指向 v1/v2/v3 的地址。

部署台单独使用 `/pinkuang-deploy-v4/`、`pinkuang-deploy-v4.service`、端口 4177 和 `/var/lib/pinkuang-deploy-v4/journal.sqlite`。公网 HTTP 进程只配置 Gas 钱包公开地址，不加载、复制或派生私钥；公开地址本身不能证明独立签名服务已就绪，第二阶段继续保持关闭。旧版安装已生成的 `keeper-v4.key` 副本须先核实没有其他使用者，再单独退役，不由发布脚本自动删除。中继和自动购机默认关闭。安装脚本从现有服务读取一次 BSC RPC 地址作为配置来源，运行后不查询任何旧合约。部署产物与浏览器包必须由同一源码提交生成，且安装前核对归档和服务器配置的 SHA256。

现有预创世部署台的热钱包凭据隔离更新使用 [UPDATE_PREGENESIS_CONSOLE.md](./UPDATE_PREGENESIS_CONSOLE.md) 的固定哈希、空日志和回滚核验步骤。

**第二阶段解除冻结条件**：需要另建不对公网服务的 Gas signer，通过可核验的签名或受保护的本机证明绑定预设公开地址、链 ID、当前部署图和权限交易；服务端验证该证明后，才可把 `credentialVerified` 改为 `true` 并开放第二阶段。当前返回 `false` 是有意的 fail-closed 状态，不可当作接线完成，也不能仅凭环境变量中的公开地址、服务器文件存在或浏览器显示地址来放行。

源码中的独立 Authority signer 是后续产品审核代付的**关闭状态草案**，不是上述 Stage2 证明。公网 `server/index.mjs` 只校验钱包会话和同源请求，使用仅有 HMAC 凭据的本地代理；`server/authority-signer.mjs` 在独立 `pinkuang-v4-signer` 用户下持有 Gas 凭据，监听 `/run/pinkuang-v4-relay/authority.sock`，不监听公网 TCP。代理只转发准确的 `POST /api/journal/authority-relay` 和 `GET /api/journal/authority-relay/status`，请求限 64 KiB、回包限 64 KiB、45 秒超时。短时断言绑定方法、路径、请求体 SHA-256、会话地址和期限，signer 拒绝重放；signer 仍独立重验管理员 EIP-712 签名、当前新合约图、角色、codehash、nonce 与 Gas 预算。公网进程若被完全控制，攻击者可能伪造会话断言，但仍不能伪造管理员的业务签名；因此这个隔离降低私钥暴露面，不能代替管理员签名核验。

离线 cutover 草案中的普通 runtime 不加载任何私钥或 IPC 凭据。启用前须另外审查 `runtimeRelayDropIn` 和 `signerUnit`：创建专用用户 `pinkuang-v4-signer` 与专用组 `pinkuang-v4-relay`，仅公网服务用户和 signer 用户加入该组；UDS 父目录 0750、socket 0660。公开服务只加载独立随机 32 字节 HMAC 凭据，Gas 私钥只通过 systemd `LoadCredential` 交给 signer。需把同一已核验 v4 部署记录和 Authority 激活记录按 SHA256 核对后复制到 signer 私有的 `/var/lib/pinkuang-v4-signer/`，不能给 signer 读写公网 journal DB。签名 journal 与 nonce 锁只在 signer 私有根目录。用户选择继续使用原 Gas 公开地址 `0xA285…6619`，草案为私有 signer 指向原受保护凭据 `/etc/pinkuang/keeper.key`，不创建新密钥副本，也不把它交给公网进程。当前 v2 购机服务仍在发送域内，两版日志和锁不互通，因此 v4 signer 与自动购机保持关闭。启用前须停用并核对全部 v2 发送者、逐笔对账未决日志和链上 pending nonce；之后才能把 `BEMINE_V2_GAS_SENDER_DRAINED` 从 `0` 改为 `1`。这个变量只是已完成人工核对的断言，不是链上证明；若 v2 继续运行，则必须先实现共用的 nonce 调度与持久账本。

Authority 的无管理员签名 `mine(bytes)` 现在只可执行 arm/start；`reclaim(bytes32)` 要管理员签署准确目标、准确 calldata 的 EIP-712 `executeApprovedOperation`。HTTP 签名路由还要求目标是当前新 Factory 登记的矿池，外层 `mine(bytes)`、内层 `reclaim(bytes32)` 都是标准 ABI 编码，且 key 与当前矿机链上 key 一致。自动 keeper 在签名通道就绪前必须暂停 reclaim，不能把失败操作反复重试。

安装完成只表示可用部署台。用户需在自己的 MetaMask 中逐笔确认 16 笔新图部署和 7 笔 Authority 接线；服务器不能代签。链上完成后，再独立准备 `/bemine-v4/` 前端、索引和交易服务，核验新合约地址、权限及完整业务流程后开放。不能把 v2/v3 的矿池、份额、订单或旧索引写入 v4。

预部署控制台设置 `BEMINE_FRESH_CONSOLE_PRE_GENESIS=1`，市场、报价、采购队列及旧记录导入均不可写。部署页也不加载旧版份额市场及其浏览器交易记录。当前另设 `BEMINE_FRESH_STAGE2_HOLD=1`，在失败交易恢复流程通过链上验证前，禁止新建或推进 Authority 七步日志，页面也禁用第二阶段按钮；第一阶段及只读核验可继续。两项标志都不是产品上线开关。产品开放需要另外实现经核验的新图交易门禁、独立索引、审核中继及购机流程。已有 v4 服务的修正版使用 `update-console.remote.py` 更新；脚本要求新部署与 Authority 日志均为空，并保留旧站及其服务。

新旧合约完全独立，无法通过新合约自动阻止旧版使用相同矿机编号。开放建池前必须核对 NFT 当前所有权和可购买状态；这项运营核对不把旧合约引入 v4 的链上执行路径。复用 Gas 地址仅涉及发送者的交易序号，不让新合约读取旧合约；启用 v4 发送端仍须完成上一段所述的旧端排空和权限核对。

第二阶段完成后，`prepare-fresh-cutover.mjs` 仅生成 v4 产品服务的离线草案，`activationAllowed` 固定为 `false`。它不会替用户发送交易、启动服务或改 nginx。实际开放产品前仍须核对最终链上回执、角色、索引、审核代发及购机流程。

第二阶段若某笔交易已在链上失败、被取消或替换，当前七步日志会终止，页面不会自行重发或清除记录；必须先设计并验证部分角色已变更时的独立恢复流程。持续挖矿 claim 失败阻塞转让/出售、跨版本矿机重复登记以及对管理员提供的市价参考和在线服务的依赖，仍是正式开放前需评估的边界。
