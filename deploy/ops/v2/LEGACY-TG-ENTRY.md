# 旧 Telegram 项目入口迁移

旧 `/bemine/` 读取旧 Factory；新项目只在 `/bemine-v2/` 的双 Factory 索引中。旧 Telegram 消息中的 `/bemine/?source=tg#pools` 因此会错误显示零项目。

在既有 Nginx `location ^~ /bemine/` 内、`alias` 前增加且仅增加：

```nginx
if ($args = source=tg) { return 302 /bemine-v2/?source=tg; }
```

只匹配查询字符串恰好为 `source=tg` 的旧邀请，不改变带 `mode`、`project` 参数的旧分享海报，也不改变不带该参数的旧站。浏览器在 `Location` 未给新 fragment 时继承原有 `#pools` 或 `#detail/...`。新站的分享地址由构建的 `NEXT_PUBLIC_BASE_PATH` 生成，不能再默认为旧 `/bemine/`。

发布时先备份原站点配置并核对现场配置；修改后 `nginx -t` 通过才 reload。验收旧 Telegram 入口返回 `302` 和 `Location: /bemine-v2/?source=tg`，旧站普通入口仍返回 `200`，新站项目接口返回已核验项目。回滚只还原本次备份并再次 `nginx -t`，不触碰索引数据库或合约。
