# TapeOut 合伙拼矿机

当前任务：**T0.1 工程初始化**。业务合约尚未实现，协议行为尚未完成 M0 fork 验证。

目标仓库：[jianfengliao774-sketch/pinkuang](https://github.com/jianfengliao774-sketch/pinkuang)。

需求以 [开发文档 v0.4](docs/sources/development-spec-v0.4.docx) 为准，任务顺序按
[开工计划 v0.4](docs/sources/kickoff-plan-v0.4.md)。原文件校验值见
[sha256.json](docs/sources/sha256.json)。不使用 v0.2。

交付状态和原始检查输出见 [docs/T0.1.md](docs/T0.1.md)。

## 工程目录

```text
contracts/       Foundry 配置、地址常量、依赖编译入口
  src/           后续业务合约、interfaces/、libraries/
  test/          unit/、fork/、invariant/、utils/
  script/        Addresses.sol；后续部署脚本
indexer/         后续 Ponder 索引服务
api/             后续 API
keeper/          后续定时领取
web/             后续 Next.js 网站
bot/             后续 grammY 机器人
scripts/         本地检查、fork 前置检查、升级检查入口
docs/            原始需求、交付说明、原始日志
.github/         GitHub Actions 工作流
```

T0.1 不预写 PoolVault、PoolFactory、ShareMarket、ReinvestRouter、Deploy 或未核实的协议接口；
目录用 `.gitkeep` 保留，具体文件在对应任务卡实现。

## 安装和检查

工具版本：Node.js 24.19.0、npm 10.9.3、Foundry 1.7.1、Solidity 0.8.24。
安装 [Foundry](https://getfoundry.sh/introduction/installation/)，使 `forge` 在 PATH 中。

```sh
npm ci
npm run fmt:check
npm run build
npm test
npm run validate:upgrades
```

Windows 中文路径请使用：

```sh
node scripts/check-local.mjs
```

该命令在系统临时目录创建英文路径的源码副本，核对 Solidity/config 文件 SHA-256 后执行检查，
日志保存在原项目 `docs/logs/T0.1/`。临时目录记录于 `summary.json`，保留供复核。
在其他英文路径克隆项目时可以直接使用上述 npm 命令。

当前会得到空测试结果，Slither 和业务升级布局检查会明确输出 `NOT APPLICABLE`。
从 M1 出现业务 Solidity 源文件后 CI 执行 Slither 及升级验证；T1a 必须补齐实现合约的升级测试，
后续升级必须提供已部署版本的 referenceContract / `@custom:oz-upgrades-from`，不能把首版安全检查当作版本兼容证明。

依赖由 `package-lock.json` 锁定：OpenZeppelin Contracts / Contracts-Upgradeable 5.0.2、
openzeppelin-foundry-upgrades 0.4.2、升级验证引擎 1.46.0、forge-std v1.9.7 固定提交。
选择 OZ 5.0.2 保持两套合约同版本及 Solidity 0.8.24 / Shanghai 兼容；未引入其他业务合约库。
NPM 安装和 FFI 配置依据 [OpenZeppelin 官方 Foundry 指南](https://docs.openzeppelin.com/upgrades-plugins/foundry/foundry-upgrades)。

## 后续 fork 验证

T0.2 才实现 `contracts/test/fork/ProtocolProbe.t.sol` 并确定固定区块。
`.env.example` 提供变量说明，本卡不填未经选定的 `FORK_BLOCK`。
执行前将 BSC_RPC_URL 和 FORK_BLOCK 导出为进程环境变量，Windows 可另设置 OPENZEPPELIN_BASH_PATH。

```sh
npm run test:fork
```

缺少 RPC、固定区块或 ProtocolProbe 时退出码为 1，不能把空 fork 测试记作通过。
GitHub Actions 使用 secret `BSC_RPC_URL` 和 variable `FORK_BLOCK`；通过 workflow_dispatch 的
`run_fork` 开关手动触发，不在外部 PR 上暴露 RPC 凭据。

## 当前边界

`Addresses.sol` 中地址均标注「待人工复核」，工厂常量指现有协议注册表，不是本项目 PoolFactory。
地址来源和大小写校验不等于 BscScan 人工复核或链上行为验证。
本工程没有部署入口，不读取私钥，不发送链上交易。

按计划一次只交付一张任务卡：T0.1 验收后再开始 T0.2，M0 通过前不写业务合约。
