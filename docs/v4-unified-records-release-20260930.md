# 拼矿前端 d91b1e2 上线记录

**2026-09-30 08:36 UTC（北京时间 16:36），新前端静态发布成功；后台继续运行 498。随后第三次线上只读浏览器验收通过，前两次未通过的证据完整保留。**

正式入口：[拼矿 BEMine](https://bemine.cc.cd/bemine-v4/)。本轮只更新静态前端，不升级或部署合约，不迁移资产，不切换后台。

## 发布身份与来源

| 项目 | 值 |
| --- | --- |
| 前端 sourceHead | `d91b1e2a98d14b501579f04703001d201ca4cd68` |
| 运行中后台 sourceHead | `4986715e1f34bda98854c13b113f7c5c866b554c` |
| 发布后 current | `/var/www/bemine-v4/releases/v4-product-d91b1e2a98d1` |
| 前端内容 SHA-256 | `e303c43758f46e8efa4cbe94bddaf7528019ff99028fc291f82885216823cdf9` |
| 前端归档 SHA-256 | `a7401586db132c889d07a278e9ccc4be37d2940bed7055e924ff7e2b97ac2454` |
| 线上部署清单文件 SHA-256（原始字节） | `8ee4c26770cf3a496cb78494e1cea8eb9f3025d4a5cd7fb14ee9a7b25d8490d4` |
| 部署清单 canonical SHA-256 | `0x3a4cf8593310c538cbbf67cf260258a053ef05e88fbb98dd65b7f3e8e2bc12d8` |
| 合约 artifactDigest | `0x6007118ac4568be4743a99b44b5259518fcf5a73e091469bfdc4d05a7dc4dd75` |

同一精确 HEAD 的 [Contracts CI 36689807549](https://github.com/jianfengliao774-sketch/pinkuang/actions/runs/36689807549) 与 [Reviewed v4 product release 36689802756](https://github.com/jianfengliao774-sketch/pinkuang/actions/runs/36689802756) 均 completed/success。三份 CI 产物完成 GitHub/Sigstore 来源验签，干净 checkout 使用 `verifyGit=true` 核验完整配对。

来源与执行证据：`ci-product-d91b1e2a98d1/verified-provenance.json`、`static-product-d91b1e2a98d1-verified/preparation-summary.json`、`static-product-d91b1e2a98d1-verified/publish/{ci.json,result.json}`。本记录中的证据相对目录均以 `outputs/pinkuang-formal-readiness-20260930/` 为根。

## 本次变化

- **参与拼矿统一列表**：单矿机与多矿机项目共用列表、筛选、搜索、排序和加载更多；父项目沿用原有详情读取及权限验证。局部失败不隐藏剩余有效项目，也不把不完整数据冒充完整计数。
- **灵活替代购机预览修复**：安全整数元数据转换为准确十进制字符串，解决 `Use an exact bigint or unsigned decimal string.`；保留 uint 范围校验与精确 Wei，实际报价、金额和签名参数不变。
- **42 种公开记录操作说明**：中英文解释创建、认购、退款、采购、出售、领取、份额订单和治理。明确退款/余款/卖款入账与实际付款、满募与购机、池内归集与个人领取的区别；保留原始事件、区块、合约/交易链接及精确 CSV。多矿机详情使用同一说明。
- **三位显示**：金额与参考价格按三位四舍五入，极小正值显示 `<0.001`；计数仍为整数。交易使用精确原值，不改变募集输入和 `capacity-input` 的业务规则。

## 验证与发布边界

本地聚焦测试 **65 项通过**（最终聚焦集 60 项加通知格式 5 项）；本地浏览器 **22 组通过**（统一目录 6、灵活预览 4、Authority 7、公开记录 5）。公开记录单独跑过的 22 项单测属于相关子集，不再次累加。证据分别为 `public-records-readiness/final-focused-tests.log` 及下列结果：

- `unified-project-readiness/browser-three-decimal/results.json`
- `frontend-recovery-readiness/flexible-integer-fix/browser-three-decimal/results.json`
- `frontend-recovery-readiness/authority-three-decimal/results.json`
- `public-records-readiness/browser-first/results.json`

这些浏览器测试使用本地 fixture，不代表主网资金完整业务已经验收。公开记录测试未连接钱包、签名或发送交易。

静态兼容工具逐项核对新 CI 的 **129 个后台业务文件与线上 498 字节一致**，后台 release manifest 唯一差异为 `sourceHead` 元数据；前端部署清单字节一致。新后台归档只作证明，没有安装。发布使用已审核静态计划，精确 CAS 切换 current；失败回滚限于自身静态指针，不恢复旧服务或覆盖第三方更新。

实际 `publish/result.json` 返回 `phase=static-published`，旧 current 为 498，新 current 为 d91。发布时索引完整追平至区块 `124877600`，机器 `ready=true`，产品 `verified/fresh-active` 且 `operationalReady=true/userExitReady=true`；公开首页、静态脚本、release 清单、部署清单和新鲜价格已核验。该结果没有独立“完成秒”字段，因此这里只记录 08:36 UTC：证据中的索引检查为 `08:36:07.877Z`，价格更新时间为 `08:36:25.241Z`。

结果同时确认 `protectedStateUnchanged=true`、`serviceOperations=0`、`databaseWrites=0`、`transactionsSentByTool=0`。没有启停既有应用服务、改写数据库或由发布工具发送交易；v4 五角色、部署台、价格源与芯火服务受保护。

候选沿革保持原样：`3d9e4c2` 仅 dry-run，未暂存/发布；`2cd97f6` 只暂存、未 publish，其旧五位通知测试预期失败证据仍保留；本次正式发布的是修正测试后的 **d91b1e2**。旧站已退役，旧入口/API 为 410，四个旧 app/index 服务停止禁用，旧 purchase-v2 保持 inactive/disabled；历史数据库和链上资产保留，未迁移、撤单或代领。

## 发布后线上验收

1. **第一次外部浏览器验收失败**：产品图在检查窗口进入 `verified_snapshot/stale=true`，严格 current/readiness 断言未通过。证据 `public-records-readiness/production-d91b1e2/failure.json` 与原始 graph 样本保留。
2. **第二次未完成全套验收**：版本及初始图验证通过，桌面首页、资产、参与、市场、收益、治理已检查；到公开记录页发现历史技术提示，脚本失败。证据 `public-records-readiness/production-d91b1e2-recheck/failure.json` 保留，不能写成全站通过。
3. **后台独立只读核验已证明采样期间恢复**：08:39:13–08:39:35 UTC 两次产品图均 current、非 stale、可操作/可退出；索引从正常刷新推进至完整追平 `124878045`，worker 心跳正确。日志保留两次瞬时 `eth_chainId SERVER_ERROR`，不能据此断言具体端点或 429 限流，也不宣称持续稳定。未修改或重启服务。证据 `public-records-readiness/d91-runtime-readonly{.json,-conclusion.md}`。
4. **第三次外部浏览器通过，exit 0**：桌面 7 页（首页、资产、参与、市场、收益、治理、公开记录）、手机 3 页（首页、参与、市场）以及桌面/手机 2 次正常刷新检查全部通过。临时历史状态在最多 150 秒的有界等待内自行恢复：治理页约 231ms、公开记录约 3415ms；恢复过程中未点击刷新、未修改客户端时间、未放宽最终页面与图谱门禁。单独的正常刷新检查不作为这两次自动恢复的依据。

第三次原始结果及截图保存在 `public-records-readiness/production-d91b1e2-final/`。最终结果 `passed=true`、sourceHead 精确匹配 d91；无页面异常、无 HTTP ≥400、无非主动取消的网络失败，无写入请求或钱包签名。记录的 95 个网络取消样本为页面路由切换主动取消，不计作零网络样本。

根任务另独立核对并保留最终页面文本的正向当前数据证据 `positive-current-data-proof.json`：8 个数据页均显示数值数据区块；治理为 `124878409`，公开记录为 `124878435`，手机页为 `124878463`。资产与收益页显示“未连接钱包”提示，因此只确认入口及未连接状态正常，**不声称该两页个人资产数据已加载**。根任务目视公开记录桌面图与参与拼矿手机图正常。

本次线上验收不登录钱包、不签名、不发送交易。静态发布与只读页面验收已完成；真实认购、自动采购、开挖、收益领取和出售等资金业务仍需用户后续小额测试，不能由本记录代替。
