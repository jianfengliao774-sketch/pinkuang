# TapeOut 合伙拼矿机

当前任务：**一键部署与份额市场的审计整改**。保留单钱包部署，取消所有业务销毁，增加按权重购机限价、折价出售 60% 份额门槛和表决期间交易冻结。最新规则、保留风险和验证记录见 [2026-09-26 整改报告](docs/audits/2026-09-26/remediation.md)。尚未合并或部署主网；较早 T1e/M1 报告只代表其对应历史版本。

后续已确认取消 BEM 领取的 24 小时限制，允许任何人为一个收益钱包代领，资金只能转到该收益钱包。规则与本轮验证见 [无冷却代领说明](docs/audits/2026-09-26/permissionless-claims.md)。

目标仓库：[jianfengliao774-sketch/pinkuang](https://github.com/jianfengliao774-sketch/pinkuang)。

需求以 [开发文档 v0.4](docs/sources/development-spec-v0.4.docx) 为准，任务顺序按
[开工计划 v0.4](docs/sources/kickoff-plan-v0.4.md)。原文件校验值见
[sha256.json](docs/sources/sha256.json)。已批准的协议事实与渠道补充见 [v0.4 勘误](docs/spec-v0.4-corrections.md)。不使用 v0.2。

交付状态和原始检查输出见 [docs/T0.1.md](docs/T0.1.md)。
项目方指定后续页面风格参照“芯火夺宝”，参考版本与候选信息见 [视觉参考记录](docs/design-reference.md)。

## 工程目录

```text
contracts/       Foundry 配置、地址常量、依赖编译入口
  src/           Factory/Vault/ShareMarket/Timelock/Beacon、接口与库
  test/          unit/、fork/、invariant/、utils/
  script/        Addresses.sol、Deploy.s.sol 部署模拟入口
indexer/         后续 Ponder 索引服务
api/             后续 API
keeper/          后续定时领取
web/             后续 Next.js 网站
bot/             后续 grammY 机器人
scripts/         本地检查、fork 前置检查、升级检查入口
docs/            原始需求、交付说明、原始日志
.github/         GitHub Actions 工作流
```

已实现认购退款、原子购机、收益分账、份额转让、份额市场、投票挂牌、整机受控成交、出售款分配。销毁按最新指示取消。当前加入审计修复与部署模拟入口；复投、最终覆盖率及后续应用尚未交付。

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
node scripts/check-local.mjs T1e
```

该命令在系统临时目录创建英文路径的源码副本，核对 Solidity/config 文件 SHA-256 后执行检查，
日志保存在原项目 `docs/logs/T1e/contracts/`。临时目录记录于 `summary.json`，保留供复核。
在其他英文路径克隆项目时可以直接使用上述 npm 命令。

`npm test` 运行认购退款、购机、挖矿权限、收益、转让、份额市场、出售投票、治理和状态不变量；协议测试另运行 `npm run test:fork`。
CI 执行 Slither 及明确指定 Factory/Vault/ShareMarket 的升级验证，对照已交付 T1a 至完整 T1e 的真实布局，并检查实际抽取的命名空间和八个固定库链接，兼容/不兼容 fixture 均有验证。CI 证据使用当前 run 的独立临时目录，避免混入仓库已有日志。
后续正式升级还必须提供已部署版本的 referenceContract / `@custom:oz-upgrades-from`，不能把本卡 V2 fixture 当作任意未来版本兼容证明。

依赖由 `package-lock.json` 锁定：OpenZeppelin Contracts / Contracts-Upgradeable 5.0.2、
openzeppelin-foundry-upgrades 0.4.2、升级验证引擎 1.46.0、forge-std v1.9.7 固定提交。
选择 OZ 5.0.2 保持两套合约同版本及 Solidity 0.8.24 / Shanghai 兼容；未引入其他业务合约库。
NPM 安装和 FFI 配置依据 [OpenZeppelin 官方 Foundry 指南](https://docs.openzeppelin.com/upgrades-plugins/foundry/foundry-upgrades)。

## 固定区块 fork 验证

固定 BSC 主网区块 `123728000`；测试覆盖开挖、转移与收益、市场成交、BEM 权限、双向换币，以及实际 PoolVault 的市场购机、卖家直卖、收益领取、开挖及份额转让成交。
执行前将 `.env.example` 的 BSC_RPC_URL 和 FORK_BLOCK 导出为进程环境变量（脚本不会自动读取 .env）。
Windows 中文目录会自动拷贝到 ASCII 临时目录并核对源码哈希。

```sh
npm run test:fork
```

缺少 RPC 或区块不同均退出码 1。当前原始输出和源码哈希保存在 `docs/logs/T1e/fork/`；M0 原始证据继续保留在 `docs/logs/T0.2/`。可设置 `VALIDATION_TASK` 按任务保存日志。
GitHub Actions 在 main push / PR 上通过公开归档 RPC 运行同一固定区块测试；功能分支只触发 PR，fork 排队并使用有界 RPC 重试，不向 PR 提供 RPC 凭据。
也可通过 workflow_dispatch 的 `run_fork` 开关重跑。节点失效会失败，不会跳过后标成通过。

## 当前边界

`Addresses.sol` 中地址均标注「待人工复核」，工厂常量指现有协议注册表，不是本项目 PoolFactory。
地址来源和大小写校验不等于 BscScan 人工复核或链上行为验证。
部署入口支持读取公开配置地址进行本地模拟，配置、原子创建过程与核验说明见 [部署文档](docs/deployment.md)；本轮未读取私钥，未发送主网交易。

项目方已确认按 M0 实测事实纠正并继续 M1；页面风格继续遵循“芯火夺宝”要求。
