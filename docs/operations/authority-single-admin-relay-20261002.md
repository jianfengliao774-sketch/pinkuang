# Authority 单管理员交易准备修复（2026-10-02）

## 问题与修复

测试运营工作台返回 `Current Authority administrators are invalid.`。链上测试 Authority 的两个 ABI 管理员槽均为 155E，这是已批准、已部署的单管理员配置。服务器的短期角色过滤器及独立签名服务仍无条件拒绝相同管理员地址。

新增 `reviewedSingleAdministrator(trusted)`，只从服务器已验证的部署证据识别此模式。浏览器命令不能启用它。两处检查允许已批准的单管理员；零地址、无权限钱包、Gas 钱包担任管理员、错误运行时代码、错误 Factory 或 Gas 绑定仍被拒绝。原有双管理员部署仍拒绝两个角色变成相同地址。

仅修改 `authority-ipc.mjs` 和 `authority-role.mjs` 的线上运行代码；保留测试、正式运行时的独立路由及 Cookie 变体。更新对应文件清单哈希，保留原部署 sourceHead 和 artifactDigest。没有修改合约、管理员、Gas 钱包或前端产物，也没有发链上交易。

## 验证

- `node --test deploy/server/authority-ipc.test.mjs deploy/server/authority-relay-api.test.mjs`：23 项通过。覆盖单管理员状态读取及签名请求、无权限拒绝、零地址、Gas 与管理员分离、双管理员、轮换、区块变化及请求缓存。
- 服务器加载实际部署证据及当前链上状态：测试 Authority `0x3D32Cdb5BC55b2E4B79256Bd11af01ff536D2c52`，两槽均为 `0x6F4d78fB59eC938cBAF65b9fc822aD04d00c155E`；区块 125134551，角色过滤和签名服务角色证明均通过，无权限钱包返回 403。
- 正式 Authority `0xE145e352889Fa14BF59205843044B0744F123f39`，保持原两个管理员；区块 125134554，同两层证明通过，无权限钱包拒绝。
- 测试 API、签名、索引、采购、挖矿服务及正式版对应服务均 active。
- 以实际签名服务用户 `bemine-full-test-signer` 执行完整只读机器就绪证明，`machineReadiness=true`；采购和挖矿 readiness 均为 true。root 直接调用相同函数会因预期文件所有者不同返回错误，不能以 root 调用结果认定服务故障。
- 浏览器连接未提供可控制的现有标签，未执行真实交易。真实钱包签名和广播由用户继续测试，不能将只读证明或单元测试表述为已成功创建真实项目。

## 部署与回退

测试修复提交：`5fc6d1611eff4952968ddbcfa788d6ae3697d58e`。
正式同步提交：`f56b8d2c4077608daad2803f9715a7d2a020a46a`。

服务器原文件及清单备份：

- `/srv/bemine-full-test/operations/authority-roles-5fc6d1611eff/`
- `/srv/pinkuang-deploy-v4/operations/authority-roles-f56b8d2c4077/`

`paths.json` 按序映射数字命名备份文件。回退恢复对应文件和清单后，仅重启受影响 API/签名服务；不变更链上配置、业务账本或部署图。
