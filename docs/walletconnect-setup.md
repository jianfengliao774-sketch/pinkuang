# 手机扫码连接

WalletConnect Project ID 是网站在 Reown 创建项目时获得的公开服务编号。它不是钱包地址，也不包含私钥；网站用它建立电脑页面与手机钱包之间的通信。代码不需要、也不接收私钥或助记词。

当前没有收到本项目的 Project ID。此时扫码入口自动隐藏，Chrome/Edge 扩展、EIP-6963 多钱包选择以及手机钱包内置浏览器照常可用。不得填示例编号冒充已开通。

## 配置

1. 网站负责人在 [Reown Dashboard](https://dashboard.reown.com/) 创建自己的项目，复制 Project ID。
2. 在项目域名设置中允许实际使用的域名 `tapeout.cc.cd`；开发测试域名按需要单独配置。
3. 产品页面构建时设置 `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=<32 位项目编号>`；部署台构建时设置 `VITE_WALLETCONNECT_PROJECT_ID=<同一项目编号>`。两个变量都是公开构建配置，不能放钱包秘密。
4. 重新构建、发布静态文件。只修改服务器启动环境不会改变已构建页面。
5. HTTPS 与 CSP 允许 `wss://relay.walletconnect.com`、`wss://relay.walletconnect.org`，保持交易日志同源。其他网站或协议不放宽。
6. 在实际域名上验证手机钱包扫码、BSC 切换、拒绝、取消、超时及重新连接。缺少编号时只完成了接入代码与模拟回归，不能声称已验证真实配对。

SDK 固定 `@walletconnect/ethereum-provider@2.25.0`。点击扫码后才加载 SDK、连接服务，二维码在浏览器本地生成，配对 URI 不写入业务日志或分享链接。只申请 BSC 钱包会话；连接本身不发送链上交易。部署台连接后仍按既有流程请求一次无 Gas 的本站日志认证签名。

取消和超时会使本次 UI 请求失效并清除对应配对；后到的批准不能恢复已取消连接。SDK 2.25.0 的 `abortPairingAttempt()` 实际是空操作，所以使用该配对的 `core.pairing.disconnect`、独立 SDK 实例存储前缀和外层请求身份检查，不依赖该空操作。只有用户逐笔确认才可发送交易。

官方接口说明：[Ethereum Provider](https://docs.reown.com/advanced/providers/ethereum)。本项目使用 `showQrModal:false` 和 `display_uri` 自有弹窗，保持现有设计。
