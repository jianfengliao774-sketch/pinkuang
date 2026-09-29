# v4 产品前端独立接线（候选包）

本分支只准备 `/bemine-v4/` 静态前端与新合约图的接线，不安装线上服务，也不发送链上交易。部署台 `/pinkuang-deploy-v4/` 的 16 笔部署和 7 笔 Authority 接线是另外的链上流程。未取得完整回执、独立索引、审核代发与购机服务验收前，候选包中的 `activationAllowed` 固定为 `false`。

完成新图链上核验并生成新的 `integrated-v2` *结构格式*清单后，在独立检出目录执行：

```sh
cd web
node scripts/build-fresh-product.mjs /absolute/path/to/reviewed-fresh-manifest.json
```

这里的 `integrated-v2` 是现有清单 schema 的名称，不能取用旧 v2 的合约地址或旧清单文件。构建要求新清单含独立 Factory、预算 Factory 和已核验的 Authority/Gas 钱包字段，并与当前编译 ABI 的 artifact digest 相符。脚本设置 `NEXT_PUBLIC_BASE_PATH=/bemine-v4`、`NEXT_PUBLIC_BEMINE_PRODUCT_FAMILY=fresh-v4`、固定的 `NEXT_PUBLIC_V4_MANIFEST_SHA256`。它在这个独立检出目录构建期间暂时以新清单替换编译时固定清单，结束后恢复原源码字节；构建后删除输出中的旧文件名 `data/frontend-manifest.json`，只留下 `data/frontend-manifest.v4.json` 和 `fresh-product-release.json`。产物中的 `public/` 内容应原样放在专属 release 的 `public/` 目录；cutover 草案的 nginx `alias` 将 `/bemine-v4/` 对应到该目录。不要将 `out/` 内容与旧 `/bemine-v2/` 的目录合并。

页面启动时只请求 `/bemine-v4/data/frontend-manifest.v4.json`、`/bemine-v4/api/journal/product-graph`，后续读取 `/bemine-v4/api/chain-index` 和 `/bemine-v4/api/rpc`。新清单内容由构建摘要固定；产品图必须为 `fresh-active`，且 Factory、预算 Factory、所有部署地址、代码摘要、Authority、部署交易及阶段区块与新清单一致。交易前同样重验该新图；历史快照仅供展示。旧 v2 的静态清单不作为 v4 信任根，旧页面预加载缓存不会在 v4 构建使用。

当前服务端仍把新图的 `operationalReady` 固定为 `false`，`prepare-fresh-cutover.mjs` 也只输出禁用状态的 unit 草案。因此本构建不证明正式产品已经上线，也不能仅靠改前端变量开放交易。正式开放前需独立核对新图最终链上回执、产品 API、索引追到安全链头、钱包交易与 Authority 审核代付及自动购机的真实端到端结果，再用独立守卫激活；旧 v2 的 Factory、索引和资产不得接入这套服务。
