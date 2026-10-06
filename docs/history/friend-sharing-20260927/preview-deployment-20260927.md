# 拼矿 BEMine 临时预览发布记录 · 2026-09-27

本次只发布静态页面。合约尚未部署，未启动产品交易 API、索引服务或管理台；没有发送真实交易或社交消息。

## 访问入口

- 完整交互预览：https://tapeout.cc.cd/bemine/preview.html#home
- 直接查看分享卡：https://tapeout.cc.cd/bemine/preview.html#share/16928
- 体验认购后分享：https://tapeout.cc.cd/bemine/preview.html#detail/16928
- 正式产品入口：https://tapeout.cc.cd/bemine/ （无核验清单，显示即将开放并关闭钱包入口）

预览底栏提供「查看分享效果」。在募集中项目完成模拟认购后也会出现分享卡。X/Telegram 的分享内容明确标注演示；朋友打开的是同一矿机的演示详情页。正式页面仍使用经过服务端核验的最终交易结果，不接受模拟成功状态。

## 发布范围与回滚

- 服务器：`144.126.242.139`。
- 新目录：`/var/www/bemine-preview/releases/20260927-integration-share-v9`。
- `current` 原子切换前：`/var/www/bemine-preview/releases/20260926-rewards-v8`，旧版保留。
- 仅上传 `NEXT_PUBLIC_BASE_PATH=/bemine` 构建的静态产物；管理台地址为空。排除历史设计稿、内置审查稿、review-files 及 source map。
- 上传后对 83 个文件执行 SHA-256 核对通过，再切换入口。没有修改 Nginx 配置或其他应用的 `/api/`。
- 保留 `data -> /var/www/bemine-preview/data`；保留 `review-20260926` 和 `review-mobile-v7` 历史审查链接。
- 报价服务 `bemine-price.service` 发布后为 active，原域名首页发布前后的内容摘要相同。

回滚须先确认 `current` 仍指向本次 v9，避免撤销其他人的后续发布，再新建临时软链接并原子切回 v8。不要覆盖或清空独立的 `data` 目录。

## 验证

- `pnpm check`：68 个单元测试通过，目录与币价检查通过。
- 构建前 ABI 校验与 `/bemine` 静态构建通过。
- iPhone 优先视口：375、390、393、402、430、440px 竖屏与 852×393 横屏；124 个布局检查通过。包含主产品的隔离数据联调、交互演示、分享弹窗、中英和深浅色。
- 表单字号至少 16px、顶部触控至少 44px；无整页横向溢出，分享按钮可滚动到屏内，底栏不遮挡页面尾部内容；未限制用户缩放。
- 公网复核：分享直达、复制文案、模拟认购后分享、朋友打开项目、中英切换及深色模式均通过；没有 JS 页面错误、缺失资源、钱包调用或产品 `/api` 请求。
- 手机检查使用 Chrome 移动触控仿真，不等同 iPhone 真机或 Safari 内核验收。真机键盘、钱包回跳和正式链上资金路径仍待相应环境完成后验收。

本地证据目录：`/Users/chcken/Documents/商业!/BEMine-对接验收-20260927/服务器预览/`。移动批量检查脚本为 `web/scripts/iphone-browser-check.mjs`，依次运行 `BEMINE_IPHONE_PHASE=preview`、`live`、`demo-share`。
