# BSC v4 公开部署证据

此目录保存 2026-09-30 从部署台原始记录和实际导出函数取得的公开证据。Stage 1 为 16 笔交易，Stage 2 为 7 笔 Authority 激活交易；两个阶段均已通过最终区块和权限核验。记录不包含私钥、RPC 凭据、登录凭据或服务器路径。

- 单机 Factory：`0xd81dBD0E622447D26405B3576F0C3Fd698AF01B8`
- 多机 Factory：`0xc72016011AA2E16Ff48f864f35BAd34CB0Bb21Dc`
- Authority：`0xE145e352889Fa14BF59205843044B0744F123f39`
- 时间锁：`0x44e4a0aF0eFa499B17b9f04cD725970eB757c20e`
- 合约源码：`23770972ce961f7da45848d4e5fddc0c4023bbfc`
- 产物摘要：`0x6007118ac4568be4743a99b44b5259518fcf5a73e091469bfdc4d05a7dc4dd75`

`stage1-record.original.json` 保留原始部署记录；`fresh-activation.json` 为实际七笔激活导出；`frontend-manifest.v4.json` 为实际前端导出，最后激活区块为 `124823386`。网页生产域名为 `https://bemine.cc.cd`，路径为 `/bemine-v4/`；部署后台继续在原域名受保护入口。

记录证明部署状态，不证明后台已就绪。正式产品还须核验独立索引、管理员签名、Gas 发送端排空和运行服务。CI 只构建候选文件并出具可验签来源证明，不签名、不广播、不启用交易。
