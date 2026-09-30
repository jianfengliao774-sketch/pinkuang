# v4 产品前端、后台与独立发布

本分支将 `/bemine-v4/` 静态前端、独立产品 API、索引和后台自动化接到已经完成部署的新合约图。部署台 `/pinkuang-deploy-v4/` 的 16 笔部署和 7 笔 Authority 接线保留原始证据，不重部署或覆盖。构建出的候选包 `activationAllowed` 固定为 `false`；现场启用使用 [分阶段发布工具](PRODUCT-RUNTIME.md)，要求完整回执、实际索引、审核代发与采购/挖矿服务验收。构建和签名产物本身不发送链上交易。

完成新图链上核验并生成新的 `integrated-v2` *结构格式*清单后，在独立检出目录执行：

```sh
cd web
node scripts/build-fresh-product.mjs /absolute/path/to/reviewed-fresh-manifest.json /absolute/path/to/fresh-activation-evidence.json
```

公开产品域名通过构建进程环境变量 `BEMINE_FRESH_PRODUCT_ORIGIN` 设置；例如正式域名为 `https://bemine.cc.cd`（不能带结尾斜杠）。缺省仍为 `https://tapeout.cc.cd`。该值必须是规范的 HTTPS origin，不接受用户名、密码、路径、查询参数或片段；空值也会拒绝。构建会将分享地址固定为 `${origin}/bemine-v4/`，并在 `fresh-product-release.json` 记录 `publicOrigin`、`publicUrl` 和 `deployConsoleUrl`。修改域名后必须重新构建，不能只换 DNS。部署台链接始终是受保护的 `https://tapeout.cc.cd/pinkuang-deploy-v4/`，不会随公开产品域名迁移。

```powershell
$env:BEMINE_FRESH_PRODUCT_ORIGIN = 'https://bemine.cc.cd'
node scripts/build-fresh-product.mjs C:/absolute/reviewed-fresh-manifest.json C:/absolute/fresh-activation-evidence.json
```

正式站点可将新域名根路径以 `308` 跳转到 `/bemine-v4/`，保持既有严格路径校验。静态分享地址配置不代替服务端 HTTPS、Origin、会话 Cookie 和签名来源校验；这些仍须在新域名上线验收中分别确认，也不会开启产品交易门禁。

构建同时固定 `NEXT_PUBLIC_BEMINE_PUBLIC_ORIGIN`，供单机、多机分享链接与海报预览图片使用。分享只接受原站或这一明确的构建来源，不从浏览器地址、邀请参数或待校验 URL 扩大信任范围；历史设计预览保持原样。

这里的 `integrated-v2` 是现有清单 schema 的名称，不能取用旧 v2 的合约地址或旧清单文件。构建要求新清单含独立 Factory、预算 Factory 和已核验的 Authority/Gas 钱包字段，并与当前编译 ABI 的 artifact digest 相符；管理员和 Gas 公开地址还必须与部署台固定角色、七步激活证据一致。脚本设置 `NEXT_PUBLIC_BASE_PATH=/bemine-v4`、`NEXT_PUBLIC_BEMINE_PRODUCT_FAMILY=fresh-v4`、固定的 `NEXT_PUBLIC_V4_MANIFEST_SHA256`。它从干净的 Git HEAD 建立一次性检出目录，只在那里编译新清单，不改动旧站源码或 `web/out/`；完成后原子发布到独立的 `web/out-v4/`。发布包仅包含 `data/frontend-manifest.v4.json` 和 `fresh-product-release.json`，不包含旧文件名。产物中的 `public/` 内容应原样放在专属 release 的 `public/` 目录；cutover 草案的 nginx `alias` 将 `/bemine-v4/` 对应到该目录。

页面启动时只请求 `/bemine-v4/data/frontend-manifest.v4.json`、`/bemine-v4/api/journal/product-graph`，后续读取 `/bemine-v4/api/chain-index` 和 `/bemine-v4/api/rpc`。新清单内容由构建摘要固定；产品图必须为 `fresh-active`，且 Factory、预算 Factory、所有部署地址、代码摘要、Authority、部署交易及阶段区块与新清单一致。交易前同样重验该新图；历史快照仅供展示。旧 v2 的静态清单不作为 v4 信任根，旧页面预加载缓存不会在 v4 构建使用。

服务端已提供独立的 fresh 产品模式：只有 `127.0.0.1:4187`、明确的 `BEMINE_FRESH_PRODUCT_ENABLED=1`、精确双 Factory 清单及专用索引配置可进入。`operationalReady` 每次重新核对 `4184` 索引和私有 signer 的机器状态，要求同源码版本、真实运行的采购/挖矿进程、有效心跳、规范区块以及已停止的旧 Gas 发送端。部署和激活接口仍在公开产品进程禁用；前端不能自行更改变量绕过门禁。详细配置见 `docs/ops/v4/FRESH_PRODUCT_READINESS.md`。

普通成员领取、退款、撤单由用户钱包直接发送并支付 Gas。共享退出白名单仅在当前完整合约图验证通过时提供 `userExitReady`，不依赖平台 Gas 服务可用性；原有账户、精确调用、金额、nonce 和链上规则核验保留。历史快照只用于展示。购机本金由矿池按规则支付，Gas 钱包仅用于必要的后端自动化手续费和受管理员签名约束的平台调用。

离线 `prepare-fresh-cutover.mjs` 继续输出禁用草案，不应直接作为正式产品的 systemd 单元使用。产品实例必须与部署台 `4177` 分开，用独立数据库与严格产品模式配置；启用需通过完整链上及实际运行验收。静态候选包与后端候选包必须使用同一份新部署清单、源码提交和已验签的真实 CI 产物，完成链上与本机探针后才可切换站点。旧 v2 的 Factory、索引和资产不接入这套新图。
