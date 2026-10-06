# 旧公众入口修复，2026-10-04

本次修复让普通访问者进入正式 BEMine 产品，而不是合约部署台。旧正式资产站及测试站继续暂停，旧合约和资产未迁移。没有钱包签名、交易、授权、资金操作或外部消息。

## 已发布内容

| 时间（CST） | 精确远端文件 | 结果 |
| --- | --- | --- |
| 12:39:27 | `/var/www/bemine-maintenance/bemine-paused.html` | 旧暂停页的唯一公众按钮改为正式网站；只保留支持的语言和完整产品路由，不将旧合约详情地址带入新图 |
| 12:49:27 | `/var/www/bemine-v5/current/mobile-review.html` | 单个“打开网站”链接改为 `https://bemine.cc.cd/#home` |
| 12:58:34 | `/etc/nginx/sites-available/bem2075`、新增 `/etc/nginx/snippets/bemine-v5-legacy-public-entry.conf` | TapeOut 的 60 个现有 v5 公众文档别名固定跳转正式域；API 和未知文档仍 404 |
| 13:04:50 | `/etc/nginx/snippets/bemine-retired-paused.conf` | 两域旧 demo 预览和生成的分享 URL 固定跳转正式 demo；旧 live 分享及不可信参数继续暂停 |
| 13:11:26 | `/var/www/bemine-v5/current/preview.html` | og/twitter 分享图改为已可达的固定同域图片，og:url 改为正式预览页面；DOM 与 Next 序列化元数据同时更新 |

维护页原入口 `https://tapeout.cc.cd/pinkuang-deploy-v5/` 是错误公众链接；真实管理员专用部署路径仍保留。没有全局 404 指向部署台的配置。旧暂停路径共用同一 HTML，因此第一项覆盖旧 `/bemine/`、v1–v4 及全部旧测试站/旧部署升级路由的暂停页面。

v5 别名只包含当前产物中确实存在的 19 个公众 HTML 文档的三种路径形式，另加三个产品根入口。域名写死为 `https://bemine.cc.cd`，查询参数原样保留；浏览器实测保留 fragment。API 不转发、未知文件不兜底。v5 与正式根使用同一合约图，因此该别名可以保留当前 v5 详情 hash。

旧 `/bemine/` 是不同的历史图，不能普遍重定向。只有演示页面例外：`preview.html` 的空查询或受支持的 source/lang；九个当前分享海报和六个已知演示项目 ID 的生成格式 `mode=demo&project=ID[&source=...]`。`mode=live`、未知 ID、重复 mode、额外跳转参数和 API 均返回原 503 暂停页。没有任意域名重定向。

## 验证及证据

- `publication.json`：20 条旧暂停路线及两域根/升级站验证，十个服务身份完全不变，未 reload。
- `mobile-publication.json`：单文件 overlay 的精确前后哈希和身份验证。
- `compatibility-publication.json`：60/60 v5 别名正确，七个 API/未知路径保持 404，根站与旧暂停站状态正确。
- `demo-compatibility-publication.json`：两域 114 个 demo URL 正确跳转，24 个旧真实资产/不可信参数/API 路由仍暂停。
- `public-entry-audit.json`：修复前的完整入口盘点，包括 48 个旧路径、12 个普通页面和 28 个已加载脚本引用。其时间早于最后两阶段发布，不能当作当前路由结果。
- `browser-results.json`：原维护页五项验证；`paused-public.png` 和 `formal-market-public.png` 是根任务保存的实际公共浏览器截图。
- `mobile-overlay-hydration-results.json`：只替换目标 href 的文档 overlay 验证，在现有不可变脚本水合及语言/搜索重渲染后链接仍指正式域。它不是完整源码重建证明。
- `cua-public-results.json`：最后阶段通过 CUA 在真实浏览器验证正式市场、演示预览、演示分享、旧 live 暂停和 mobile-review 的正式网站入口，及水合后 canonical 分享元数据；没有连接钱包或点击交易。
- `metadata-resource-check.json`：修复前仅 HEAD 检查分享图资源，不下载图片；root `/images/` 不可达，实际产物图片的同域 v5 资源 URL 可达。
- `preview-metadata-publication.json`：根任务批准后的单 HTML 元数据修复结果。实际三个语义字段在 DOM/序列化中共六处；将新值逆替换可完整恢复原 HTML，证明没有其他字节变更。两种预览入口 200、图片 HEAD 200；服务及 nginx 配置完全不变，未 reload。

最后两次 nginx 变更执行 `nginx -t` 和 reload。九个业务服务身份不变，产品所有文件（在 mobile overlay 之后的基线）及升级目录所有字节完全不变；nginx master 未变、新 worker ID 如实保留。初次 v5 发布首个请求落在旧 worker、读到 404，验证失败自动恢复了原配置并删除自建 snippet。已确认原配置哈希及根站状态正常；随后添加短时、有上限的 worker 就绪验证，第二次发布记录了首次 404、下一次 308，之后全量验证通过。

五组必要代码测试共 23 项通过，`git diff --check` 通过：

```sh
python3 docs/validation/legacy-entry-20261004/publish.test.py
python3 docs/validation/legacy-entry-20261004/compatibility.test.py
python3 docs/validation/legacy-entry-20261004/demo-compatibility.test.py
node --test docs/validation/legacy-entry-20261004/route.test.mjs
python3 docs/validation/legacy-entry-20261004/preview-metadata.test.py
```

## 源码和产物范围

原维护 HTML 和 shared guard 同步到 `deploy/ops/retired-20261002/`。mobile-review 的源 href 同步到 `web/app/mobile-review/page.jsx`。其余公众 canonical 链接源修复由根任务的 artifact_builder 负责。

正式产品当前仍是 `af164a6ad76427e53a4bb1a6e1e907f96dae998a` 构建。该精确 Git object 无法在本次检出的仓库获取，所以本次未完整重建产品。mobile-review 和 preview 各做了一个 HTML overlay，原产物 content digest 标记保留，不声称 overlay 后的整个产物仍对应原完整摘要。preview 不可变 JS 没有修改；旧 demo URL 依靠上述兼容规则可达。根任务已经同步 preview 源码的正式页面地址及已可达的 v5 图片资产地址。

## 回滚

远端受保护备份和发布脚本位于 `/root/bemine-legacy-entry-20261004/`。本目录的 `*.before.*` 是历史测试/回滚 fixture，保留原错误公众链接不代表生产链接。

每个 publisher 均使用精确字节比较并拒绝并发改动；先验身份与公共状态验证、原子写入、失败自动回滚；涉及 nginx 时先语法测试再 reload。只回滚需要撤回的 overlay：

```sh
python3 /root/bemine-legacy-entry-20261004/publish-demo-compatibility.py --rollback
python3 /root/bemine-legacy-entry-20261004/publish-compatibility.py --rollback
python3 /root/bemine-legacy-entry-20261004/publish-preview-metadata.py --rollback
python3 /root/bemine-legacy-entry-20261004/publish-mobile.py --rollback
python3 /root/bemine-legacy-entry-20261004/publish.py --rollback
```

回滚不会恢复旧资产站业务。三个 HTML 回滚会恢复原错误 href 或元数据，仅在确需撤回该 HTML 变更时使用。
