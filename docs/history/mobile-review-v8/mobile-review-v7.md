> Historical v7 report. Superseded by v8; public legacy links now lead to the current review. Do not restore the old public symlinks.

# 手机端审查册 v7

- 审查基准：2026-09-26，拼矿 BEMine v7；来源分支 codex/bemine-design-v7，基础提交 813500d。
- 地址：https://tapeout.cc.cd/bemine/review-mobile-v7/mobile-review.html
- 91 项：12 主页面、15 列表筛选、24 矿机详情、17 弹窗、19 完成/空态/校验、4 手机补充场景。
- 360 / 390 / 430px；默认 390px。正文展开，弹窗/导航保留 844px 视窗；单页入口可交互。
- 反馈使用独立 localStorage 键 bemine-mobile-review-v7，支持 Markdown / JSON 导出；不与 v5 意见混合。
- 真实移动设备浏览器的键盘、安全区域、手势差异仍需用户真机验证。

## 生成

1. python3 web/scripts/build-mobile-review-v7.py
2. node web/scripts/build-mobile-review-checklist.mjs
3. NEXT_PUBLIC_BASE_PATH=/bemine/review-mobile-v7 pnpm --dir web build

生成器只写带 MobileReviewV7 的组件和独立基准文件，不改产品组件或历史 v5 快照。

## 部署位置

静态文件：/var/www/bemine-preview/reviews/mobile-v7-20260926
入口：current/review-mobile-v7 → 上述目录。
币价缓存：审查目录内 data → /var/www/bemine-preview/data。
后续更新产品 current 时，需要保留 review-mobile-v7 与 review-20260926 两个审查入口。

## 验证记录

- pnpm check：目录筛选、排序、未知价格、收益和币价校验通过；Next 静态构建通过。
- 浏览器逐项加载：390px 中文日常、360px 英文深色，各 91 项均有页面主体，没有整页横向溢出。表格保留内部横向滚动供审查。
- 修改意见：填写、勾选、刷新恢复、Markdown 下载验证通过，导出含全部 91 项和输入意见；测试意见已清空。
- 规则弹窗位置和高度实测在 390×844 视窗内。
- 主站 index SHA256 部署前后相同：4ef6b0b77a2609554c57ee6284dac66f340f211282071a8153bfce8533c9058a。
- 历史 v5 index SHA256 部署前后相同：39b803d53cbd2277488e418f91522e62fe48a02f971e8cb64d0188ea9cac9f7c。
