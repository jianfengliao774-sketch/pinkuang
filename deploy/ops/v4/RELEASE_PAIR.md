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

输入沿用 `prepare-fresh-cutover.mjs` 的 JSON 格式，包含 `recordPath`、`bundlePath`、`activationPath`、`manifestPath` 以及公开 Gas 钱包、RPC、release ID。两个 SHA-256 参数必须来自针对**同一份最终部署清单**的独立 CI 构建或受审的隔离重建记录，不能从待验包自报字段复制。校验器要求本地源码仓库恰为 `--source-head` 且工作区干净；后端每个运行模块、锁文件及部署产物均逐字节对照该提交的 Git blob。前端会核对元数据中的源码 HEAD 和独立内容摘要，但目前尚未独立证明真实静态构建的每一字节均来自该 Git 提交。随后核对前后端独立摘要、实际包内清单、独立 Factory、Authority、Gas 钱包、部署产物摘要及索引清单。成功后以 `0600` 写出一次性配对草案；文件已存在时拒绝覆盖。

CI 的 `validate-release-ci.mjs` 用**合成合约图**走真实静态构建、后端打包与配对路径，并上传摘要供回归检查。它的哈希不适用于真实部署清单。实际产品发布仍需在最终部署清单确定后单独构建并保存可信摘要。

真实前端的独立 Git 溯源仍是上线门槛。2026-09-30 在相同提交和相同合成 manifest 的隔离 checkout 连续两次真实 Next 构建，303 个文件中有 103 个字节不同；固定 build ID 并将 webpack parallelism 设为 1 后仍不一致，主要差异包括 chunk 顺序、内容哈希文件名及引用它们的 HTML。因此不能把“重新构建后逐字节相等”直接加入校验器，否则会错误拒绝正常包。下一步需让构建可复现并在独立环境验证，或由可信 CI 对真实 manifest 的产物摘要、Git commit、依赖锁文件和构建命令形成可验签证明，再让配对校验器验证证明与实际包；仅复制包内自报 SHA-256 不够。

## 真实清单的 CI 来源证明

`.github/workflows/v4-product-release.yml` 在 GitHub 托管 runner 上用锁定依赖和已提交的 `docs/deployments/bsc-v4-20260930` 公开证据构建真实包，固定域名 `https://bemine.cc.cd`。`build-reviewed-product-ci.mjs` 校验前后端配对，输出前端、后端两个归档及 `build-summary.json`；摘要记录确切源码 HEAD、部署清单、依赖锁文件、构建命令和归档 SHA256。工作流随后使用固定版本的 `actions/attest` 为三份文件生成 Sigstore 签名。工作流不持有服务器或钱包密钥，不部署。

从成功的同一轮工作流下载产物后，执行以下验证器。它调用官方 `gh attestation verify`，强制核对仓库、工作流、源码提交和签名工作流提交，并拒绝自托管 runner；任何文件无有效证明都不会输出可用摘要。`gh` 需要支持 `--source-digest`、`--signer-digest` 选项。

```sh
node deploy/ops/v4/verify-ci-product-provenance.mjs \
  --directory /absolute/downloaded-release \
  --source-head <reviewed-40-hex-commit> \
  --out /absolute/new-ci-verification.json
```

只有验签成功后，才可将输出 `releasePair` 中的独立前端内容 SHA256 和后端清单 SHA256 交给上述配对校验器。解包仍须遵循下方暂存工具的普通文件、目录和逐文件哈希规则。不可把本地自报摘要、另一提交的 CI、合成清单回归或仅仅 CI 绿色当成真实产物来源证明。验签不改变 `activationAllowed: false`；链上权限、运行时门禁及资金操作另行验收。

实现依据：[GitHub 官方 attest action](https://github.com/actions/attest) 与 [gh attestation verify](https://cli.github.com/manual/gh_attestation_verify)。

## 按配对计划安装到未启用的发布目录

`stage-fresh-release-pair.remote.py` 只把经上述校验的前后端文件写入计划指定的全新 release 目录，不切换 nginx、systemd 或 current 链接。先以 `tar -C <frontend-out> -czf <frontend-archive> .` 和相同方式制作后端归档；归档只允许普通文件和目录。将两个归档、配对计划及脚本上传到服务器 root 专用目录，独立核对计划文件的 SHA-256。服务器上的两个 releases 父目录须预先存在、由 root 拥有且不可被组或其他用户写入。执行时从已审查的本地计划记录填写摘要：

```sh
python3 stage-fresh-release-pair.remote.py \
  --plan /root/fresh-v4-stage/bound-plan.json \
  --plan-sha256 <reviewed-plan-sha256> \
  --frontend-archive /root/fresh-v4-stage/frontend.tar.gz \
  --backend-archive /root/fresh-v4-stage/backend.tar.gz \
  --dry-run
# 预检成功后，以相同参数将 --dry-run 改为 --stage。
```

安装前脚本核对计划的 disabled 状态、两个归档的逐文件哈希、内容清单、源码 HEAD、部署产物及索引摘要；已存在的目标 release 会拒绝覆盖。如果两个目标目录的最后一次重命名之间发生磁盘或进程错误，可能留下第一个未启用目录；应按其实际内容复核并另行处理，不能直接重试同名 release。计划含服务配置和 RPC 来源，保存在 root 私有目录，不公开正文。

配对草案始终保留 `activationAllowed: false`、Stage 2 HOLD、Gas relay 和自动购机关闭。离线文件一致性不能替代链上最终性、角色、索引追平或钱包签名核验；配对校验器不安装文件，暂存工具不切换网站、不连接 RPC，也不发送交易。
