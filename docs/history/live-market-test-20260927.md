# 独立主网测试页与演示页

2026-09-27。正式测试入口为 <https://tapeout.cc.cd/bemine-live-test/#market>，使用 BSC 主网已部署的 Factory、份额市场与只读索引。原演示入口 <https://tapeout.cc.cd/bemine-test/preview.html#pools> 和样例数据继续保留；新测试路径中的 `preview.html` 重定向回该演示入口。两个静态发布目录独立，测试发布不切换 `/bemine/` 或 `/bemine-test/`。

真实市场页的份额挂单只从经确认的链上索引读取。每份售价来自实际挂单；“日产能价”按 `每份售价 × 100 × 10^8 ÷ 当前矿机预计日产出（BEM 最小单位）` 计算，向上取整到 wei。它是按整台矿机折算的毛产能估算，不代表净收益或成交价。当前矿机身份从 Vault 的现行 NFT 参数、Factory 注册、链上 NFT 持有人和 Firsto 官方详情交叉核对；来源超时、身份不符或估计日产出缺失时显示不可用，不改变买卖交易。自动读取有限数量的矿机，其他挂单可点选查询，以免耗尽共用 Firsto 报价额度。

页面下方的 Firsto 报价板逐台区分卖家挂牌价与买方总价，分别显示每单位预计日产出价格，并显示市场参考价、来源时间和区块。此板仅作只读行情，不发送签名或交易。前端不以样例订单补链上空表；测试时若尚无真实矿池或挂单，应显示“暂无挂单”。

部署产物与链上旧版合约摘要 `0xf48637de6a1c988b92d21347662b724b1ee7d59b09f66aaca9c7fe81b9a3b9ce` 绑定。本次未升级或重新部署合约、未使用钱包签名。正式买卖和采购仍需持有人在页面确认后自行用钱包签名；不能以只读行情验收代替真实成交验收。

验证：`web/pnpm check` 为 193/193 通过；`NEXT_PUBLIC_BASE_PATH=/bemine-live-test NEXT_PUBLIC_BEMINE_PUBLIC_URL=https://tapeout.cc.cd/bemine/ pnpm build` 通过。静态产物发布到 `/var/www/bemine-preview/releases/bemine-real-test-20260927T132036Z`，仅切换 `current-live-test`，未切换正式站或演示站。线上 HTML SHA-256 为 `957169c8cbd26050d016e271a5ed66c42d1953f2403d88fd09a5dc870d236dc0`；演示 HTML 发布前后均为 `9523a089aaa6dd2c89d4b262489052918554b270af23fa9db385245109747f4f`。浏览器验证新入口显示“暂无挂单”、Firsto 30 条真实报价和日产能参考价，没有样例挂单；只读索引在完整状态下显示已注册矿池 0。索引每次追块核验时短暂返回 503，页面对这类可恢复读取最多做 5 轮完整重试，仍不展示未核验的部分历史。

旧测试首页修复：`/bemine-test/` 的静态 JS 嵌入摘要 `0xfb3eec9d259a1e12e5431af1642e8018e36661c737ce53c70aaf124d49707d10`，而它拿到的主网部署清单是上述 `0xf486…`，因此原先正确触发版本不一致拦截。该新版合约并未部署到现有主网地址，不能仅把清单改成 `0xfb3e…` 来解除拦截。Nginx 为 `/bemine-test/`、`/bemine-test/index.html` 和旧版链上工作台 `/bemine-test/live.html` 加了精确的临时 302，转到 `/bemine-live-test/`；浏览器访问 `/bemine-test/#records` 会保留 `#records` 并显示真实空记录页。`/bemine-test/preview.html` 仍由原目录提供，SHA-256 未变。配置备份：`/etc/nginx/sites-available/bem2075.backup-test-entry-20260927T132807Z` 和后续 `bem2075.backup-test-live-20260927T132807Z`；两次 `nginx -t` 和重载均通过。
