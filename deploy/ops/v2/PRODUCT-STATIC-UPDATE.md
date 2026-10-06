# 只更新已上线产品前端

此流程适用于 `/bemine-v2/` 已正常配置、只替换静态网页的场景。不修改或重启 v2 runtime/index、六项既有服务，不修改 nginx、journal 或索引数据库，不签名、不发送链上交易。后端API/合约升级须使用另一个明确流程。

先将新前端按 `product-release-manifest.json` 完整打包并 stage 到新的 `/var/www/bemine-v2/releases/v2-product-...`。确认发布清单文件 SHA256 和源码提交号；新旧包内 `public/bemine-v2/data/frontend-manifest.json` 必须逐字节相同，因此本流程不能暗中更换合约。

本地计划 JSON 需要 `operationId`（新的 `v2-static-...`）、`releaseId`、`previousReleaseId`、`sourceHead`、`previousSourceHead`、`manifestSha256`、`previousManifestSha256`、`frontendManifestSha256` 和 `artifactDigest`。所有 hash/提交号均取实际产物，旧 release 必须等于服务器当前链接目标。

```text
python deploy/ops/v2/render-product-static-update.py --plan /absolute/reviewed-plan.json --out /absolute/new-drafts
```

渲染器只生成 prepare/activate/rollback 三个草稿，不联网、不执行。通过已批准且校验主机密钥的 SSH 方式在服务器执行 prepare，审核输出后执行 activate。模板要求 root 和非优化 Python，使用同一静态更新排他锁。

prepare 校验新旧清单、每个文件的字节数和 SHA256、源码、产物 digest、链56及 `/bemine-v2` basePath；拒绝 symlink、私密文件、额外文件和不可信文件权限。它验证当前公网 HTML/合约清单仍逐字节对应旧包，保存旧 target 与受保护服务/文件/数据库身份。activate 重新检查这些前提，以 `os.replace` 原子切换 current，并通过本机 TLS/SNI 验证 `/bemine-v2/` HTML 和前端合约清单完全匹配新包。只比较 HTTP 200 不算成功。

出现错误时只在 current 仍指向本次候选或原目标时恢复旧链接；如果其他操作者已切到第三版本，拒绝覆盖。回滚之前再次核验旧包，回滚后核验公开内容。旧 target、清单和备份均保留，不复制或还原数据库，不触碰服务或 nginx。公网精确字节探测最多每文件5次，每次4秒；保护条件失败即停止，不跳过验证。

保护测试：`python deploy/ops/v2/test-product-static-update.py`。文件属主、symlink、目录fsync及真实指针切换测试须在隔离Linux root临时目录运行；Windows只执行平台无关配置测试。测试从真实模板提取函数执行，模拟错误网页、部分生效、并发第三目标、旧包篡改及受保护配置变化，绝不连接服务器或执行服务变更命令。
