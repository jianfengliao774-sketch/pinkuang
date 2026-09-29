# Fresh v4 前后端离线配对

先在同一个已提交的源码 HEAD 上分别生成 `/bemine-v4/` 静态包和 fresh-v4 后端包；前端包内的 `frontendSourceHead` 与后端包内的 `sourceHead` 必须相同。`--source-commit` 是 Stage 1 部署记录的合约源码提交；后端部署产物可来自之后的提交，但其 `artifactDigest` 必须与 Stage 1 完全相同。`sourceCommit` 仅记录合约源码出处，不能用它锁死后端服务代码；后端服务代码由 `sourceHead`、Git 文件内容和独立包哈希核对。

```sh
node deploy/ops/v4/verify-fresh-release-pair.mjs \
  --frontend /absolute/path/to/frontend-out \
  --backend /absolute/path/to/backend-release \
  --input /absolute/path/to/reviewed-cutover-input.json \
  --source-commit <40-hex-genesis-source-commit> \
  --source-head <40-hex-reviewed-release-source-head> \
  --frontend-content-sha256 <independently-reviewed-frontend-content-sha256> \
  --backend-release-sha256 <independently-reviewed-backend-release-manifest-sha256> \
  --out /absolute/path/to/new-bound-plan.json
```

输入沿用 `prepare-fresh-cutover.mjs` 的 JSON 格式，包含 `recordPath`、`bundlePath`、`activationPath`、`manifestPath` 以及公开 Gas 钱包、RPC、release ID。两个 SHA-256 参数必须来自针对**同一份最终部署清单**的独立 CI 构建或受审的隔离重建记录，不能从待验包自报字段复制。校验器要求本地源码仓库恰为 `--source-head` 且工作区干净；后端每个运行模块、锁文件及部署产物均逐字节对照该提交的 Git blob，再核对前端和后端独立摘要、实际包内清单、独立 Factory、Authority、Gas 钱包、部署产物摘要及索引清单。成功后以 `0600` 写出一次性配对草案；文件已存在时拒绝覆盖。

CI 的 `validate-release-ci.mjs` 用**合成合约图**走真实静态构建、后端打包与配对路径，并上传摘要供回归检查。它的哈希不适用于真实部署清单。实际产品发布仍需在最终部署清单确定后单独构建并保存可信摘要。配对计划当前只是离线草案；安装工具尚未消费它，部署前应把计划中的前端内容与后端发布摘要作为强制安装输入进行审查。

配对草案始终保留 `activationAllowed: false`、Stage 2 HOLD、Gas relay 和自动购机关闭。离线文件一致性不能替代链上最终性、角色、索引追平或钱包签名核验；此工具不安装文件、不切换网站、不连接 RPC，也不发送交易。
