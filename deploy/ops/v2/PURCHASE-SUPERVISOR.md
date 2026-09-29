# 自动购机执行器

`#operator` 页的建池和认购只会改变链上状态；募满 100 份后，合约不会自行发送购机交易。`scripts/purchase-supervisor.mjs` 每 2 秒发现新池与已募满池，按「官网挂单优先、原矿机 Firsto SignedAsk 其次」调用现有 `purchase-keeper.mjs`。每次发送前重新读取链上订单、核对 NFT 和矿机状态，并模拟完整购买。默认只读；只有显式 `--send`、私有 journal 及 Gas 钱包凭据同时存在才会签名。

此执行器只支付购机交易 Gas，矿机价款来自资金池；它不会创建池子、认购份额、自动补 Gas、自动加价/重播未知交易或使用硬件升级钱包。购机订单失效、Gas 不足、超出价格上限、RPC 无法核验及购买期限过期时，必须查看日志处理，不得把只读预演当作购机完成。

生产凭据由管理员保存为 `/etc/pinkuang/keeper.key`，目录权限 `0700`、文件权限 `0600`、所有者 `root`。文件内容是一行 `0x` 开头的 64 位私钥；**不要通过聊天、公开网页、Git 或命令参数传递**。管理员可在本机运行 `node deploy/ops/v2/local-keeper-setup.mjs`，打开它生成的 `127.0.0.1` 一次性页面录入专用 Gas 钱包：该页面不部署到公开网站，私钥只经本机 SSH 标准输入写入服务器，成功后只显示公开钱包地址。页面 15 分钟失效，提交成功即关闭，不覆盖已有凭据。systemd `LoadCredential` 只把它交给服务进程；私钥与 journal 均不属于网页发布包。启用服务前，必须核对钱包地址、BNB Gas 余额、工厂地址、服务单实例和当前池的只读预演结果。`/etc/pinkuang/keeper.key` 不存在时，unit 条件会阻止服务启动。

`pinkuang-purchase-v2.service` 只负责新 Factory `0x2995B10d19056c8C24C57b281C22562a603C571F`。签名原文和哈希先落入 `/var/lib/pinkuang-purchase-v2/journal/`；未知广播状态会阻断任何新 nonce，需按 `docs/purchase-execution.md` 核对和恢复。新池自动发现，但不同机器/程序同时使用同一 Gas 钱包不受本机锁保护；不得在另一台机器上启用第二个发送实例。

只读验收示例：

```sh
node scripts/purchase-supervisor.mjs --factory 0x2995B10d19056c8C24C57b281C22562a603C571F --rpc https://bsc-dataseed.bnbchain.org --once
```
