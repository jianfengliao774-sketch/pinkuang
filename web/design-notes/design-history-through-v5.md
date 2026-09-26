# 历史设计记录（截至 v5）

以下为历次原始记录；当前品牌、费率与发布说明以 `../README.md` 为准。

# 拼矿页面预览

独立的 Next.js 前端，位于主项目 `web/`。本版提供资产总览、项目大厅、矿机详情、份额/整机市场、收益中心、共同决策和公开记录。

所有资产、收益和记录均为演示数据。认购、领取、挂单、购买和投票仅在当前浏览器内模拟；不会调用钱包、请求签名、发送链上交易。刷新页面恢复初始数据。

## 运行

```sh
cd web
pnpm install
pnpm dev
```

本地地址：`http://127.0.0.1:3108`。`pnpm build` 生成静态目录 `out/`。

## 结构与后续对接

- `app/globals.css`：响应式布局、品牌色和共用样式。
- `components/Platform.jsx`：页面与演示交互，使用 hash 路由。
- `lib/demo-data.js`：演示数据边界，后续替换为索引服务和合约查询。
- 当前业务口径依据 `codex/t1e-voting-sale`：100个整数份额、BNB认购、24小时投票及执行窗口、矿币95%分配、本站整机出售约96%分配、市场1%成交费、按日收益批次。
- 真实接入时须增加官方部署清单、类型化ABI、金额bigint、钱包交易状态、错误码映射、索引同步与重组处理。演示浮点数不可用于链上金额计算。
- 融资只显示未开放说明；自动复投和真实Telegram功能尚未接入。

前端预览不修改业务合约。2026-09-25 按用户要求部署到已有服务器的独立静态目录，公开地址见下方发布记录。

## 品牌与视觉候选（2026-09-25）

- 方案评审：开发服务器 `/design`；当前静态预览 `/design.html`。
- 主品牌暂用「芯衡 CoreAxis」，备选「芯合 CoreUnion」「芯序 CoreLedger」；未定稿，未核验商标/域名。
- 完整页面方案：`/?theme=institutional`、`/?theme=heritage`、`/?theme=terminal`。三套共用业务组件，仅切换视觉变量和排版；不改变合约、分配比例或交易行为。
- 标志：`public/brand/coreaxis-mark.svg` 与 `components/BrandMark.jsx`；以电路 B 与芯片边框构成原创标识，参考 TapeOut 官网蓝金色系，不是官方授权标志。
- 字体：项目内 Inter（许可见 `public/fonts/OFL-Inter.txt`），中文优先系统苹方/微软雅黑；资管方案标题优先宋体。移除 Google Fonts 外部运行时依赖。
- `app/design/` 是独立设计评审入口；品牌解释、候选比较不出现在业务页面。
- “最优质保”仅预留未开放入口，业务定义未扩展为保险或本金保障。

### 第二轮视觉修订

- 对比页聚焦「墨绿香槟金」「石墨暖金」，加入暖金资产卡、柔和圆角和更舒展的排版。
- 新增 `lib/brand-options.js`：贝矿 BEMine、矿友 BEMates、拼矿 TapePool、芯衡 CoreAxis；评审页可独立选择品牌和主题，使用 `brand` 查询参数进入相应预览，未视为品牌定稿。
- 新字体：Manrope + Noto Sans SC，均本地托管，许可文件保存在 `public/fonts/`。中文字体根据现有公开页面文本生成 WOFF2 子集；新增中文文案后用 `scripts/subset-preview-font.py` 重建，未覆盖字符由系统中文字体接续。
- 本轮修改范围仅视觉、品牌候选和页面标题。资金流、份额、分配比例及交易逻辑不变。

### 已选定品牌与可读性调整

用户已选定「贝矿 BEMine＋墨绿香槟金」。首页默认品牌、页面标题及 favicon 已同步；旧候选仅保留在评审页用于对照。正文使用 500 字重，标题和主要数字使用 600 字重，加深辅助文字，标志下方说明改为 13px/600。业务逻辑保持不变。正式 SVG 标志为 `public/brand/bemine-mark.svg`。

## 贝矿总览与拼矿列表（2026-09-25）

- 默认入口 `/#home` 是公开的贝矿总览；`/#overview` 是进入演示账户后展示的个人资产总览。英文统一为 `BEMine`。
- `components/SiteOverview.jsx`、`app/home.css` 提供宣传图、平台五项统计和各阶段参与入口。`lib/platform-stats.js` 仅使用演示数据：参与数按模拟钱包标识去重；管理矿机及当前日产只统计挖矿中和整机出售中的矿机，排除募集中与待购机项目。销毁累计为演示记录口径。
- `components/PoolCatalog.jsx`、`app/catalog.css` 提供项目总览及三类行式列表。支持编号搜索、来源/系列/日产出范围/价格范围筛选，以及编号、价格、募集份额、日产出、日产能价排序。手机端数据表横向滚动。
- 日产能价为整机价格除以全机日 BEM 产出，单位 `BNB/(BEM/天)`；整机出售使用当前卖价，挖矿中展示历史认购价格。未知或零产出不生成有效日产能价。
- 页面参考 TapeOut 官方 `https://tapeout.net/#circuits` 与 Firsto `https://tapeout.firsto.ai/circuits`。目前来源标识也是演示数据，尚未抓取或接入实时市场；同一演示矿机只显示一行并可带两个来源。`lib/catalog.js` 预留链 ID、矿机合约和 token ID 的身份键；未来真实合并须基于该身份及各市场挂牌记录，不能只按编号去重。
- “查看矿机”沿用原详情与演示操作。`scripts/catalog-check.mjs` 可用 Node 运行以验证列表筛选、排序、价格和身份键逻辑。新增中文后仍需重建字体子集。

## 动态首页与手机预览发布（2026-09-25）

- 首页文案增加「十分热爱」；全站已有固定像素字号增加 2px，保持原字重与操作逻辑。
- `app/motion.css` 为原宣传图加入微动、金色流光及光点，支持暂停和系统减少动态效果设置。未引入视频下载或动画运行库。
- 公开演示地址：`https://tapeout.cc.cd/bemine/`，服务器 `144.126.242.139`，仅演示数据与浏览器内模拟交互。
- 部署构建：`NEXT_PUBLIC_BASE_PATH=/bemine pnpm build`；本地根路径构建则不设该变量。字体由构建器打包，宣传图跟随 basePath。发布只包含静态导出，不包含仓库、凭据或设计评审页。
- 初次发布目录：`/var/www/bemine-preview/releases/20260925-motion-v1`；当前版本见下方更新记录。Nginx 在 `/etc/nginx/sites-available/bem2075` 中为 `/bemine/` 单独提供静态文件；原业务入口及后端未修改。
- Nginx 原配置备份：`/etc/nginx/sites-available/bem2075.before-bemine-20260925`。更新发布时先上传完整新目录，再切换 current；回滚可切回旧发布目录。首次接入的配置恢复须先核对之后是否有其他修改，不能盲目覆盖。
- 已验证生产构建、资源路径、动态暂停、390px手机列表、1440px桌面、线上图片和字体、浏览器错误日志，以及原站首页和标志的 SHA256 不变。演示入口设置 `X-Robots-Tag: noindex, nofollow`。

## 双语、愿景与独立前景动效（2026-09-25）

- 当前发布目录：`/var/www/bemine-preview/releases/20260925-bilingual-v2`，`current` 已切换到本版；旧版目录保留，可回滚。公开地址仍为 `https://tapeout.cc.cd/bemine/`，未修改 Nginx 或原站服务。
- `HeroScene.jsx` 使用独立的背景、透明芯片及透明金币素材。只有四个前景对象使用 transform 动画，背景完全静止。保留暂停与减少动态效果支持；手机上文案与画面分开排列，避免长英文遮挡主体。
- 首页新增「初衷愿景」，强调通过共持降低独自购机的资金门槛，让每位 Tapeouter 参与生态并体验挖矿。中文品牌暂保留贝矿，候选尚未定稿；英文固定 BEMine。英文单数 Tapeouter，复数 Tapeouters。
- `lib/i18n.jsx` 提供 zh/en 上下文和插值；`platform-en.js`、`catalog-en.js`、`home-en.js` 分域保存文案。语言选择存于本地浏览器，修改 document.lang；只翻译显示文本，业务状态、份额数值、路由及筛选值不随语言变化。
- 中英文覆盖公开首页、个人工作台、筛选排序、矿机详情、市场、收益、共同决策、公开记录、参与规则及演示操作弹窗。新增语言时扩充词典及选择器，不要改业务枚举值。
- 验收：生产构建和原列表逻辑检查通过；英文全部业务主页面无残留中文正文；366px 手机无整页溢出；1440px 桌面已检查。线上已验证图片加载、背景无动画、语言切换后保留募集中分类及 funded-desc 排序，原站首页 SHA256 不变。

## 紧凑愿景与日常／深色外观（2026-09-25）

- 愿景区保留原文，取消固定换行，左栏改为 140px，减少上下内边距和段落间距。宽屏标题自然单行，手机按可用宽度自然换行。
- 顶栏新增日常／深色切换，使用 `bemine-appearance` 保存偏好。外观独立于原 `theme` 设计候选与语言，不重置当前页面、筛选或演示状态。
- `appearance.css` 提供切换按钮和移动端顶栏；`dark.css` 以 `data-appearance=dark` 限定石墨黑、香槟金及可读的文字/状态/输入框配色。页面照片及其动画不做反色处理。
- 已发布：`/var/www/bemine-preview/releases/20260925-appearance-v3`，`current` 指向本版。公网地址不变，旧版保留可回滚；原站首页校验不变。
- 验证：生产构建通过；1440px 中文愿景区高度由约 308px 缩至 179px，标题为一行；已检查深色首页、筛选、规则弹窗、认购输入与收益警告；390px 中英文无整页溢出，刷新后恢复外观和语言；线上主题按钮可切换。

## T 芯片与图片传输优化（2026-09-25）

- 发布目录：`/var/www/bemine-preview/releases/20260925-webp-v4`，`current` 已切换。芯片中心加入金色 T；愿景左侧标题区水平、垂直居中，手机标题组水平居中。
- `scripts/optimize-hero.mjs` 用现有 Sharp 将原素材编码为两档 WebP，保留前景 alpha，输出 12 位 SHA256 内容哈希文件名及 `lib/hero-assets.json`。`HeroScene.jsx` 用 picture/source 在 600px 断点选图，无原 PNG 或桌面图额外预加载。
- 三张独立图片总量：旧版 5,636,994 B；手机 142,210 B（约 142 KB，减少 97.5%）；桌面 265,688 B（约 266 KB）。三个金币复用同一 URL。以上仅为动效图片压缩体积，不含 HTML、JS、字体及运行时解码内存。
- 动画仍由 CSS 驱动，不是 GIF/视频，不产生持续网络下载。媒体文件变化生成新哈希 URL；浏览器缓存保留且有效时可复用图片。
- 在现有 Nginx `/bemine/` location 内新增仅匹配 12 位哈希 WebP 的嵌套规则，返回 `public, max-age=31536000, immutable`；HTML 及旧 PNG 保持 no-cache，404 不带 immutable。修改前备份：`/etc/nginx/sites-available/bem2075.before-webp-20260925`。
- 已检查手机实际选择 mobile 文件、桌面选择 desktop 文件，三张金币共享同一文件；构建通过。线上六个 WebP 的字节数/MIME/cache header 已核验，HTML 仍可更新、缺失图片 404 不长期缓存，原站首页 SHA256 不变。

### 2026-09-25 愿景图文与宣传语 v5

- 用户确认保留中文名「贝矿」，英文名 BEMine。
- 已发布至 `/var/www/bemine-preview/releases/20260925-purpose-v5`，`current` 指向本版；旧版 v4 保留可回滚。
- OUR PURPOSE／初衷愿景移至卡片上方；卡片新增社区共建插画，WebP 31,714 字节，延迟加载、内容哈希缓存。
- 底部宣传语确定为「共持BEM矿机，共享BEM人生」，增加轻量芯片与电路图案，并同步英文。
- 构建及线上页面、脚本、样式、新配图检查通过；原站首页 SHA256 不变。本次未修改 Nginx 配置或后端。

### 2026-09-26 独立全页面审查册

- 审查入口：`https://tapeout.cc.cd/bemine/review-20260926/review.html`。
- 静态目录：`/var/www/bemine-preview/reviews/20260926-v5`；通过 `current/review-20260926` 符号链接提供访问。后续切换主站release时需保留同名符号链接。
- 87项覆盖现有页面、详情页签、弹窗及关键演示状态；桌面/手机、中英文、深浅色可切换。
- 用户意见仅保存在浏览器独立键 `bemine-review-v5`，支持Markdown/JSON导出，不上传服务器。
- 主站v5首页和原业务组件未修改；审查册使用独立的自动生成组件快照。详见 `design-notes/review-book-v5.md`。
