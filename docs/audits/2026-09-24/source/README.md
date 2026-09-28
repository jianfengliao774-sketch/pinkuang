# 用户提供的审计输入

原审计基于 `6879557`，不是完整出售提交 `8ba9fb1`。原表和 PoC 为证据输入；其中规则备选及“等待确认”等文字不自动成为项目决定。项目方后续批准优先于原报告中的旧进度描述。

Markdown 的 18 项问题与 Excel 工作表“审计问题”A2:H19 逐项一致；Excel 的“已核实无问题”A2:B8 也与 Markdown 一致。只读抽取 Excel，没有修改用户原文件。

原始输入的 SHA-256（复制前原字节，Git 文本规范化后可能不同）：

| 输入 | SHA-256 |
|---|---|
| pinkuang代码审计问题表.xlsx | `258f093501559498476a30025074f82b88a09211ea164cb5faae250379820203` |
| [findings.md](findings.md) | `c2029088bda9a3844ed12c2ed8c87485853e6a510373c71a346a3fe69f669a31` |
| [AuditFindings.original.sol.txt](AuditFindings.original.sol.txt) | `86245b5e4edf331c253785a4b1e8a008634212f6f383bc285c0f4828e925ebbc` |
| [AuditRevokedFork.original.sol.txt](AuditRevokedFork.original.sol.txt) | `aa2a477d9c0f1d09300dd103b6024c0ecd15ed352196506637319a8cfbca343c` |

PoC 原样存档于测试目录之外，以免将“旧缺陷复现成功”混称为“修复回归通过”。新的回归改为断言修复后的行为，并在处理记录中关联原问题编号。
