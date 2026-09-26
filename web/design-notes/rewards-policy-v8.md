# v8 页面规则调整与合约边界

用户于2026-09-26确认：前端暂不设计BEM销毁，取消收益领取间隔和到期失效；最终以已部署合约为准。

本次只修改 web/，不改动合约、后端、部署控制台或实际资金规则。前端仍为演示。参与规则和收益确认弹窗明确提示：实际领取条件与分配规则以已部署合约为准。对接时必须由合约/后端读取可领取金额、状态、费用与限制，不能把演示常量当成权威配置。

## 变更

- 清理首页、统计、公开记录、筛选、详情、CSV及中英文词典中的相关旧规则。
- 已到账未领取收益持续保留，领取期间禁用重复操作，演示领取结束后余额与待办同步。
- 收益批次移除到期字段；治理24小时窗口、募集截止和挂牌期限不变。
- 公开记录统计改三列；手机审查保留90项，撤下A12且不复用编号。
- 旧review组件改用当前快照，下载清单同步。旧浏览器意见仅读取，不覆盖：手机意见沿用既有键，撤下项与旧桌面意见单独随导出保留。

## 构建与发布

```sh
python3 web/scripts/build-mobile-review-v8.py
node web/scripts/build-mobile-review-checklist.mjs
node web/scripts/export-review-index.mjs
pnpm --dir web check
NEXT_PUBLIC_BASE_PATH=/bemine pnpm --dir web build
node web/scripts/prepare-preview-release.mjs
```

静态产物上传到新的 releases/20260926-rewards-v8，再原子切换 current；data 继续链接公共行情缓存目录。不要再链接旧审查目录到 current。prepare-preview-release.mjs 为旧审查链接写入新版跳转和更新后的下载文件。旧发布目录与审查文件继续离线保留，不改写历史文件。

当前审查入口：/bemine/mobile-review.html。旧 review-20260926 和 review-mobile-v7 链接会进入当前页面。

## 验证

- pnpm check 覆盖目录、价格、规则文案、数据清理及审查基准哈希。
- Next静态构建成功。
- 90场景 × 中文390px / 英文深色360px，180次加载均无旧规则文案及整页横向溢出。
- 浏览器验证领取处理中按钮禁用，完成后可领收益归零、3个批次已领取、按钮禁用。
- 合约规则提示、治理期限保留；服务端与Git核验见最终交付。
