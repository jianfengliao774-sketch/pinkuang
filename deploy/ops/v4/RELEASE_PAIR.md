# Fresh v4 前后端离线配对

先在同一个已提交的源码 HEAD 上分别生成 `/bemine-v4/` 静态包和 fresh-v4 后端包；前端包内的 `frontendSourceHead` 与后端包内的 `sourceHead` 必须相同。两个包的 `sourceCommit` 是部署产物的源码提交，可能早于这个发布 HEAD，不能把它称作网页源码版本。

```sh
node deploy/ops/v4/verify-fresh-release-pair.mjs \
  --frontend /absolute/path/to/frontend-out \
  --backend /absolute/path/to/backend-release \
  --input /absolute/path/to/reviewed-cutover-input.json \
  --source-commit <40-hex-deployment-artifact-source-commit> \
  --source-head <40-hex-reviewed-release-source-head> \
  --out /absolute/path/to/new-bound-plan.json
```

输入沿用 `prepare-fresh-cutover.mjs` 的 JSON 格式，包含 `recordPath`、`bundlePath`、`activationPath`、`manifestPath` 以及公开 Gas 钱包、RPC、release ID。校验器只读实际包目录，核对所有前端文件的内容摘要、后端逐文件 SHA-256、两包来源提交、独立 Factory、Authority、Gas 钱包、部署产物摘要及后端索引清单，再以 `0600` 写出一次性配对草案。文件已存在时拒绝覆盖。

配对草案始终保留 `activationAllowed: false`、Stage 2 HOLD、Gas relay 和自动购机关闭。离线文件一致性不能替代链上最终性、角色、索引追平或钱包签名核验；此工具不安装文件、不切换网站、不连接 RPC，也不发送交易。
