# BEMine 低危清单复核（2026-09-28）

本记录以 `codex/v2-live-readiness` 当前源码及当日公开 HTTPS 响应为准。仓库提交不代表现有 BSC 主网实现或服务器进程已经升级；改合约后仍须按 Timelock、代码哈希和部署清单流程验收。

| 审计项 | 核对结果与处理 |
| --- | --- |
| 原官网卖家撤单即可放开灵活替代路线 | **属现行采购规则，但不是无价限的绕路。** `FlexiblePurchase._originalAvailable` 在原挂牌无效后允许同任务且纯验证、非最优的候选；`_requirePricedModel` 对替代机按参考机权重等比例限制价格，并受建池 `priceCap` 约束。原卖家仍能撤单，市场挂单在成交前仍可能变化。这项如要改变为“原目标撤单也不允许替代”，需另行确定业务规则和升级合约。 |
| `buy` 缺少买方最高价 | **对官网购机调用不成立。** `PoolVault` 存有建池固定 `priceCap`，`PurchaseValidation.prepareMarketPurchase` 先检查挂牌价，官网 `ICircuitMarket.buy(listingId, uint96(price))` 又传入当笔最大价。灵活池还要求 `priceCap <= referencePriceWei`，多筹的 10% 不会自动提高购机授权。此上限由建池方设定，执行者没有单笔另行下调的参数。 |
| 旧 Factory 改 treasury 导致预算子池无法购买 | 已在前一轮移除错误的“子池 treasury 必须等于项目旧 treasury”条件，仍要求子池属于项目指定 Factory。需待新版实现上链；旧实现不会因仓库改动自动修好。 |
| Firsto 报价反向代理把所有人合成一个限额 | 服务端只在 TCP 对端是回环 nginx 时信任 `X-Real-IP`，v2 nginx 片段把它设为 `$remote_addr`，不信任任意公网传来的转发头。已有单测覆盖伪造转发头与每客户端额度。生产仍要核验 nginx 实际配置；若前面还有可信 CDN，必须先审查 `real_ip` 信任链。 |
| 控制台与其他应用共源，削弱 CSRF 隔离 | **仍待部署层处理。** `/pinkuang-deploy-v2/` 与 `/bemine-v2/` 都在 `tapeout.cc.cd`，不同 URL 路径不构成浏览器安全边界。同源脚本可向控制台路径发请求。建议把控制台迁到独立 HTTPS 子域，重新绑定登录 Origin、cookie 范围、WalletConnect 允许域名和回调，再完成端到端验证；目前没有已核准的子域/DNS/证书，不能宣称已隔离。 |
| nginx 局部 `add_header` 丢安全头；静态产品缺 CSP | v2 生成片段已移除局部 `add_header`，保留站点继承头。2026-09-28 公开 HEAD 实测：部署台有 `Content-Security-Policy`、`X-Content-Type-Options`、`Referrer-Policy`；产品静态首页只有 `X-Content-Type-Options` 与缓存头，未见 CSP、HSTS、`X-Frame-Options`。**产品 CSP 仍需上线**，先对构建产物验证脚本、样式、钱包连接和 API 域名，再在真实 nginx server/location 配置；若在 location 添加 CSP，必须同时补齐所有需继承的安全头或使用服务器已支持的 `add_header_inherit merge`，不能仅加一行后声称修好。HSTS 影响同一域名全部应用，须由站点管理员统一决定。 |
| systemd 加固和环境私钥 | v2 控制台/索引 unit 已设置独立用户、`UMask=0077`、`NoNewPrivileges`、`PrivateTmp`、`ProtectHome`、`ProtectSystem=strict`，控制台通知关闭且不读取 keeper 钱包。四个 keeper 发送入口本次增加 `$CREDENTIALS_DIRECTORY/keeper-private-key` 支持，同时配置旧环境私钥与 systemd 凭据时拒绝发送；只读模式仍不读密钥。生产 keeper unit 尚未切换，见下方示例。 |
| Telegram 绑定链接可转发 | 转发令牌只能把 Telegram 账户置为“待确认”；钱包须完成已认证会话中的显式确认，其他钱包不能确认，原绑定不会被转发令牌直接替换。`binding.test.mjs` 覆盖此情形。仍需防用户被诱导确认错误账户，页面应展示待绑定用户名，用户须自行核对；用户名不是强身份凭证。 |

## 生产入口的可执行配置建议

先在 nginx `http` 级别定义共享内存区域，再在**现有** v2 API、公开 RPC 与 Firsto 报价 location 中分别加入 `limit_req`，不要另建重复 location 或直接把片段贴进 `server`。例如：

```nginx
# http context
limit_req_zone $binary_remote_addr zone=bemine_v2_public:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=bemine_v2_quotes:10m rate=2r/s;

# inside reviewed existing location blocks, with real client IP verified
limit_req zone=bemine_v2_public burst=30 nodelay;
limit_req_status 429;
# quote location may use bemine_v2_quotes instead
```

这是入口层示例，不是已安装配置。合并前要读取现网完整 nginx 配置，验证真实客户端 IP、现有请求频率与全站头部继承，运行 `nginx -t`，灰度观察 429 后再启用。keeper 应使用独立 RPC 额度，避免公开代理占满业务校验。

keeper 的 systemd 服务可在**已核验实际运行路径与钱包地址之后**设置以下指令；源私钥文件只存在于服务器受保护目录，不能进入仓库或 unit 的 `Environment=`：

```ini
[Service]
User=pinkuang-keeper
Group=pinkuang-keeper
UMask=0077
LoadCredential=keeper-private-key:/etc/pinkuang/keeper-private-key
Environment=PINKUANG_KEEPER_STATE_ROOT=/var/lib/pinkuang-keeper/state
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/pinkuang-keeper
```

`PINKUANG_KEEPER_STATE_ROOT` 让启用 `ProtectHome=true` 的服务仍能把锁存到受保护服务器目录；`ReadWritePaths` 还需覆盖实际 journal 与锁目录。先确认程序确实以该用户读取 systemd 凭据、绝对路径和 0700 数据目录，再切换运行单位。不能在未核对 nonce/journal 和服务身份时重启正在发送交易的 keeper。凭据文件方案依据 [systemd 官方凭据说明](https://systemd.io/CREDENTIALS/)；nginx 限流上下文与继承规则依据 [官方限流文档](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html) 和 [响应头文档](https://nginx.org/en/docs/http/ngx_http_headers_module.html)。

## 上线边界

这轮可随仓库交付的是 keeper 凭据读取支持、测试和运维说明。控制台独立源、静态产品 CSP、nginx 入口限流、systemd unit 实际切换都依赖现网 DNS/TLS、配置快照与运行服务核对；在真实响应和进程验收前保持“待部署”。现有主网合约无需因本清单前两条再改；此前预算子池修复仍须协调合约升级。

本地验证：keeper 凭据与锁目录专项 2/2 通过；部署台测试首轮 345 项中 344 项通过，唯一失败是工作区旧 `dist/deployment-artifacts.json` 与已核对源码的 `public` 产物不同。运行 `artifacts:check` 与生产构建后，该精确产物测试通过；其余失败未出现。生产构建没有发布到现网站点。
