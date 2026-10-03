# 2026-09-30 正式新版发布与旧版关闭

后续更新：2026-09-30 08:36 UTC 静态前端已更新为 `d91b1e2`，后台仍为下述 `4986715`。当前前端、统一项目列表、公开记录说明及最终线上验收见 [v4-unified-records-release-20260930.md](v4-unified-records-release-20260930.md)。本页保留较早的配对发布与旧版退役事实。

本记录是三台开发电脑接手时的运行基线。用户已要求关闭旧版，后续只维护正式新版。不要恢复旧站服务、重新运行旧 sender 的迁移流程，或把历史数据库导入新版。

## 07:31 UTC 配对发布基线

- 正式入口：https://bemine.cc.cd/bemine-v4/
- 实际部署源码：`4986715e1f34bda98854c13b113f7c5c866b554c`，分支 `codex/v4-product-launch`。本记录之后的文档提交不代表另一轮业务发布。
- 2026-09-30 07:31:47 UTC 完成静态前端与五个后台角色的配对升级。前端、产品 API、索引、签名器、采购、挖矿均使用同一已验证源码。
- [完整 CI 36682448579](https://github.com/jianfengliao774-sketch/pinkuang/actions/runs/36682448579)：contracts、deployment-console、fork 均成功。
- [签名发布 36682273038](https://github.com/jianfengliao774-sketch/pinkuang/actions/runs/36682273038)：成功；下载包的 GitHub/Sigstore 来源另行验证。
- 前端压缩包 SHA256：`aa12bafc8852b20ab5f4702410e467ccdbf48a269037e9f14c3493b76e20d819`。
- 后台压缩包 SHA256：`1ed9c0f2233992b15df73b5929dfd4ae65dfef1dc771b7d457d88af229bbc9a1`。
- 前端内容 SHA256：`ca32308f511da5ba17ac660055d1cde9ae312500c6ab8c662bc0fa430aaa590d`。

本轮未改变 Solidity、ABI、正式合约地址、管理员或费用规则。旧数据库和交易账本保留；没有手工签名、广播或转移资金。已有自动化仍按用户授权处理必要后台调用，领取、退款、撤单继续由用户自己的钱包支付 Gas。

钱包、管理员与部署入口规则，以及募集退款入口见 [frontend-wallet-access-20260930.md](frontend-wallet-access-20260930.md)。建池读取使用网站只读 RPC，纯预览超时 20 秒后给出重试；取消或切换账户后的旧结果不能再请求签名。实际授权、签名、发送不因预览超时重复执行。表单显示精度不改变报价的精确 Wei。

## 旧版已关闭

07:40:56 UTC 开始 apply 预检后完成。`tapeout.cc.cd` 上的以下入口及子路径返回 410：`/bemine`、`/bemine-v2`、`/bemine-test`、`/bemine-live-test`、`/bemine-preview`。v2 API、Firsto 代理、静态资源和旧价格路由均关闭。旧部署/升级入口 `/pinkuang-deploy/`、`/pinkuang-deploy-v2/`、`/pinkuang-deploy-v3/`、`/pinkuang-upgrade-v2/` 继续返回 410。

四个旧服务已停止并取消开机启动：`pinkuang-deploy.service`、`pinkuang-index.service`、`pinkuang-deploy-v2.service`、`pinkuang-index-v2.service`；实际状态均 inactive / disabled / PID 0。`pinkuang-purchase-v2.service` 一直关闭，未重启。

保留并验证的服务：五个新版后台角色、新版受保护部署台、共享价格服务、芯火夺宝站点及 bot/keeper。关闭前后这十个服务的 PID、InvocationID 和配置均未变化。新版首页 200，部署台未认证访问 401；18 个旧 URL 的 GET 和旧 API 的无效测试路径 POST 均返回 410。

**保留共享价格文件**：`bemine-price.service` 与 `/var/www/bemine-preview/data/bem-price.json` 仍服务于新版的精确价格路由。关闭旧 preview 的公网入口不等于删除其目录或停止价格服务。

五个历史数据库的 inode、属主和权限保留。旧合约仍存在矿机、份额、历史订单和可领余额；本次没有取消订单、清算、迁移或重置链上状态。原 ABI、地址及私有运行记录已归档。这些记录只用于追溯，不是维持旧站上线的要求。

## 验证结果与范围

- 本地通过 42 项钱包/读取恢复单元检查、12 个权限与预览浏览器场景、7 个 Authority/用户自付 Gas 场景、6 个钱包选择/移动场景。钱包和交易使用测试夹具。
- Windows 全量 web 单测曾有 14 项 POSIX 文件权限环境失败；实际发布源码的 Linux CI 已完整通过，未放宽权限保护。
- 线上只读验收通过电脑端 7 个页面、手机端 3 个页面及双方手动刷新。未连接钱包时无运营/部署入口；无最终错误横幅、历史技术卡片、页面横向溢出或静态资源失败。报价身份、正式部署图和接口隔离均核对通过。
- 浏览器验收保留 53 个被取消的读取请求记录，均为 `net::ERR_ABORTED`，没有 HTTP 错误或页面 JS 异常；测试未授权钱包、签名或发送交易。
- 最初本机 Windows 时钟未同步、慢约 9 秒，导致报价“未来最多 5 秒”的保护检查失败；原失败记录保留。使用系统 `w32tm /resync` 同步成功，时间服务事件 35 确认来源为 `time.windows.com`。随后报价客户端 age 为 1318 ms、服务器 age 为 279 ms；未放宽应用报价阈值，也未伪造浏览器时间。
- 一次首页初始数据来自服务器的短期历史图，显示“资料更新中，操作暂不可用”。渲染结束不等于后台核验结束；保留原失败记录后，验收等待有界重试恢复，后续所有页面达到 current / ready。后台原缓存规则为 45–120 秒资料返回 verified_snapshot 并触发刷新。

以上不是主网资金全流程的完成证明。真实认购、购机、收益领取、退款及出售仍需用户用自己的钱包测试；本轮没有替用户签名。WalletConnect 扫码仍需项目自有 Project ID。

## 运维证据与后续限制

本机完整证据保存于 `outputs/pinkuang-formal-readiness-20260930/`：

- `product-runtime-4986715e1f34-verified/`：发布身份、独立干净 Git 配对核验、数据库备份摘要、首次失败、恢复和成功重试、真实后台就绪证明。
- `frontend-recovery-readiness/production-readonly-4986715-time-synced/`：最终线上只读结果、各页面截图和价格时间证据；其他同前缀目录保留早期失败。
- `frontend-recovery-readiness/retire-legacy-execution/`：dry-run/apply 原配置、保护服务、五份数据库身份、资产归档和结果。
- 关闭计划 SHA256：`6e70eff7fa411a48581df97231b74d6be77f62db24b96fad0c8e3bbdae81dd37`；关闭脚本 SHA256：`890f5f42215f6fb8543fc0377f65353f37c44bd73b404264513d551bfbd1ef7c`。

首次升级遇 Node 进程 active 但 HTTP 尚未监听，恢复流程也遇到同一竞态；原账本未变化。运维 helper 已修正为在原 30 秒窗口等待连接拒绝/503，session 的 401 仍是唯一成功；仅在明确观测到 start-limit-hit 且 PID 0 后复位指定五服务的启动计数，再单次启动。49 项 Python 检查通过。实际升级工具 SHA256 为 `76c845eab372221e17ee3e36d7fa71e8ad3c7bd36c9e696b1fed1c6aefb03dc9`。

**不要复用本次升级脚本执行未来自动回滚**：旧版退休后，过去要求旧站 200/旧服务 PID 不变的基线已作废。新发布必须以本记录的旧版 inactive/disabled/410 为基线，禁止为了通过旧断言而重新打开旧版。链上 nonce、项目数量会随用户操作变化，不应固定为本次停写时的 nonce 5 或零项目。
