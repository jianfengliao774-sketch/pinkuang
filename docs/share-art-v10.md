# BEMine 专属分享海报 v10

生成日期：2026-09-27。

## 交付素材

| 用途 | 仓库路径 | 尺寸 | 文件字节数 |
| --- | --- | --- | --- |
| Telegram / X Open Graph 图片、下载海报 | `web/public/images/bemine-share-v10.jpg` | 1200 × 630 | 180152 |
| 网页分享卡预览 | `web/public/images/bemine-share-v10.webp` | 1200 × 630 | 81256 |

使用内置 `image_gen.imagegen` 生成全新完整海报。没有使用 CLI 或替代 SVG。原始 PNG 留在项目外：

`/Users/chcken/.codex/generated_images/01a0e0b4-9aa6-7c93-88a6-afd290c53862/exec-6cd70554-1cc0-4ae5-a1ff-7d348dc24b81.png`

原始 PNG 约 1.9 MB，不纳入仓库或网页下载。网页版本通过本地 Sharp 缩小至 1200 × 630 并编码压缩；没有重绘文字或替换图像内容。JPEG 使用 quality 88、mozjpeg、4:4:4 色度采样；WebP 使用 quality 82、effort 6。

## 视觉与文案检查

生成前已查看现有 `bemine-purpose.cc58a3b1926c.webp` 与 `bemine-mining-hero.png`，用于理解视觉风格；此次没有修改这两张图片。画面采用墨绿、香槟金与奶油白，四位矿友围绕金色线路与 BEM 芯片共同参与，兼顾品牌识别和亲切感。

成图逐项可视核对：

- 英文品牌 `BEMine`，BEM 大写、ine 小写。
- 中文品牌 `拼矿`。
- 主标语 `一起拼矿，一起发光。`，在逗号处分为两行。
- 英文副标 `Small shares. Shared adventures.`。
- 金币和芯片上的 `BEM`。
- 不含收益承诺、金额、募集数字、二维码或钱包地址。

这些素材是品牌海报，不代表某一具体项目的募集状态或用户付款证明。演示标识和项目详情由分享页面及文案提供。

## 内置工具调用

调用模式：新图生成，`transparent_background: false`；未提供编辑目标、引用路径或 recent-image 参数。

完整 prompt：

```text
Use case: ads-marketing. Create a completely new finished social-sharing poster for BEMine, the friendly community co-ownership platform for TapeOut mining machines. This is a new composition, not an edit of earlier images. Landscape aspect ratio exactly 1.9048:1, intended final size 1200 by 630 pixels. Professionally designed premium financial technology campaign, trustworthy, approachable, polished, restrained, not casino-like. Palette: deep forest green #173d30, champagne gold #d9c18c, warm ivory #f8f5ec. Use highly refined realistic 3D miniature product rendering: one emerald microchip with intricate fine gold circuit traces as a shared central table, two tastefully placed brushed champagne-gold coins engraved BEM, and a small diverse group of four ordinary adult friends participating together around the chip. Tiny, warm, natural human gestures of collaboration, not stock-photo handshakes. Deep green architectural stage with a subtle circular gold circuit network and gentle warm glow. References for visual style only: an emerald-and-gold 3D mining chip with BEM coins; a warm miniature community scene of four people around a shared chip. Create an original refined scene following that visual family. The render occupies the right 45 percent, leaving the left 55 percent dark and uncluttered for legible typography. Background is smooth dark green, subtle depth and gold light, no noisy particles. Typography is part of the finished poster, crisp and impeccably accurate, using elegant modern medium-bold sans serif. At upper left show exact brand text BEMine, with B E M uppercase and i n e lowercase, next to smaller exact Chinese brand text 拼矿. Main headline at middle left in warm ivory: 一起拼矿，一起发光。 Set the headline on two balanced lines at the comma, meaning line 1 一起拼矿， line 2 一起发光。 Large, highly readable, confident but warm. Under the headline put exactly: Small shares. Shared adventures. In small refined champagne-gold sans serif, can wrap after first sentence if needed. Keep all text and people comfortably inside a 6 percent safe inset, with no content touching edges. Gold coins should say only BEM. These are the only words in the image: BEMine, 拼矿, 一起拼矿，一起发光。, Small shares. Shared adventures., BEM. No QR code, no address, no money amounts, no numbers, no progress meter, no financial return promises, no extra slogan, no watermark. Cohesive professional graphic design ready for Telegram and X link cards.
```
