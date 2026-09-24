# 部署与本地模拟

部署入口是 [`Deploy.s.sol`](../contracts/script/Deploy.s.sol)，配置地址来自环境变量。当前交付只运行了本地 VM 验证，没有主网部署地址。不要把测试日志中的模拟地址登记为生产地址。

## 公开配置

| 变量 | 约束 |
|---|---|
| `DEPLOYER` | 非零部署账户地址，只用于模拟交易发送者；不是私钥 |
| `OWNER_MULTISIG` | 已部署的 2/3 多签，三名非零且互不相同的成员 |
| `OPERATOR` | 非零运营地址，与 owner 多签和 treasury 分离 |
| `TREASURY` | 已部署且成员/阈值有效的多签，可与 OWNER_MULTISIG 相同；独立 treasury 不强制使用相同阈值 |
| `BSC_RPC_URL` | BSC 归档 RPC，脚本要求 chainId 56 |

`getOwners/getThreshold` 仅校验配置，任何恶意合约都能伪造这些返回值；正式部署者必须自行核对真实多签地址及代码。协议地址仍按 `Addresses.sol` 标注待人工复核。

在 ASCII 路径的工作区运行，已设置以上公开地址后：

```powershell
forge script --root contracts script/Deploy.s.sol:Deploy --rpc-url $env:BSC_RPC_URL -vvvv
```

该命令不带 `--broadcast`，仅本地模拟。脚本不读取、打印或保存私钥。真实广播和签名配置须在明确的部署操作中另外提供；本次修复没有执行它们。

Windows 中文工作区先运行 `node scripts/check-local.mjs T1e`，根据该次 `summary.json` 的 `buildRoot` 进入经过哈希核对的 ASCII 副本执行模拟。不要在改过源码后复用旧副本。

## 原子创建顺序

1. 部署单次 `AtomicDeployment` 协调器，部署者地址在构造时固定；其他地址不能使用它。
2. 读取协调器预测的 Factory 地址；部署绑定此地址的 Vault 实现，以及锁定初始化的 Factory、Market 实现。Vault 静态链接的八库由 Foundry 处理，必须保存实际链接地址及部署产物。
3. 调用协调器 `deploy(config)`，在同一笔交易内部创建 Timelock、Beacon、Factory 代理，再初始化 Factory 并创建已初始化的 Market 代理。任何一步失败，整个关联图回滚；不存在跨交易暴露的未初始化 Factory 代理。
4. 初始化时只登记一次 Market，后续调用仍受原来的时间锁/不可替换规则限制。协调器核对角色、48 小时延迟、双向 Factory/Market 关系、Beacon 的实现和治理地址。

Factory 预测地址来自协调器的第 3 次 CREATE。协调器的部署流程不可插入新的 CREATE 后继续复用原预测公式；回归测试检查预测、失败回滚及原地址重试。

Vault 实现的 `OFFICIAL_FACTORY` 是 immutable，所有官方 Beacon 池的初始化都受此约束。Beacon 同时固定该绑定，升级候选必须返回相同 Factory，仍须经 48 小时时间锁。这个检查防止配置错误，不是对候选全部逻辑的安全证明；升级仍要检查实际代码与布局。

## 验证与留档

本地测试直接执行实际脚本的 `run()`，只注入公开配置和测试多签接口，没有密钥或外部广播；另有协调器全图、初始化抢占、失败回滚、真实延迟升级、错误 Factory 绑定与代码大小检查。结果见 [审计处理记录](audits/2026-09-24/remediation.md)。

正式部署记录应保存 chainId、协调器/实现/库/代理/治理地址、交易哈希、实际 codehash、构造参数、链接字节码和编译输入。脚本输出公开角色地址与实现 codehash，协调器发出关联图和实现哈希事件；Foundry 产物用于补充八库链接记录。编译模板哈希没有应用链接地址、库自身地址或 immutable 修补，不能替代实际部署核验。

官网和索引始终以配置的官方 Factory 的 `isPool(pool)` 为准。能读取官方 Beacon 或复制合约名称并不代表池子属于本项目。
