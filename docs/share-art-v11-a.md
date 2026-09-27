# BEMine 分享海报 v11 · A 组

生成日期：2026-09-27。

## 输出与体积

全部素材由内置 `image_gen.imagegen` 逐张生成全新图像，没有使用 CLI 或 SVG 代替生成。生成前已查看现有 v10 品牌图，四张采用各自独立提示词。原始大 PNG 留在项目外；网页使用 Sharp 缩放、编码后的 JPEG/WebP，不额外绘制文字或编辑图像内容。

| 风格 | 文件（`web/public/images/`） | 尺寸 | 字节数 |
| --- | --- | --- | --- |
| 动漫 | `bemine-share-v11-anime.jpg` | 1200 × 630 | 203201 |
| 动漫 | `bemine-share-v11-anime.webp` | 1200 × 630 | 126354 |
| 动漫 | `bemine-share-v11-anime-mobile.webp` | 640 × 336 | 51240 |
| 真实生活 | `bemine-share-v11-real.jpg` | 1200 × 630 | 189857 |
| 真实生活 | `bemine-share-v11-real.webp` | 1200 × 630 | 101302 |
| 真实生活 | `bemine-share-v11-real-mobile.webp` | 640 × 336 | 41274 |
| 金融 | `bemine-share-v11-finance.jpg` | 1200 × 630 | 145458 |
| 金融 | `bemine-share-v11-finance.webp` | 1200 × 630 | 76234 |
| 金融 | `bemine-share-v11-finance-mobile.webp` | 640 × 336 | 28144 |
| 科技 | `bemine-share-v11-tech.jpg` | 1200 × 630 | 194202 |
| 科技 | `bemine-share-v11-tech.webp` | 1200 × 630 | 102782 |
| 科技 | `bemine-share-v11-tech-mobile.webp` | 640 × 336 | 38196 |

所有 JPEG 均小于 220 KiB，桌面 WebP 小于 130 KiB，手机版 WebP 小于 60 KiB。JPEG 使用 mozjpeg 和 4:4:4 色度采样，动漫 quality 82、其余 quality 88；WebP 均 quality 83、effort 6。尺寸通过 Sharp `resize(width,height,{fit:'cover'})` 统一，仅裁去原图比例与目标比例之间的极小差异。

## 验看记录

四种风格均逐一使用 `view_image` 查看 640 × 336 手机版；核对 `BEMine` 大小写、`拼矿` 与 `BEM`，品牌文字和主体清晰，无固定宣传标语。四种视觉语言明显不同。没有金额、收益承诺、涨势图、二维码、钱包地址、第三方官方背书。

动漫版最初生成的品牌左距约 5%，最终采用此版，完整比例显示不裁切且手机可读。之后另有加大品牌边距的探索图，仅保留项目外，未替换已验收素材。其余三张的主要品牌留白约 8–10%。图片应保持完整宽高比显示，不额外放大裁切品牌区。

## 动漫 · anime

原创动漫插画；屋顶夕阳中的成年矿友共同参与，手绘线条与暖色光影。

原始图：`/Users/chcken/.codex/generated_images/01a0e0b4-9aa6-7c93-88a6-afd290c53862/exec-c37bfe80-a8db-4fc8-b715-ccec8740a09e.png`。

调用：`transparent_background: false`，未提供 referenced_image_paths 或 num_last_images_to_include；全新生成。

完整提示词：

```text
Use case: ads-marketing. Create a NEW finished BEMine brand social-sharing illustration, landscape 1.9048:1 ratio, intended 1200x630 pixels. Style: richly crafted original anime movie key visual with clean hand-drawn ink lines, soft cel shading and luminous painterly background, unmistakably illustrated, NOT photorealistic or 3D. Four ordinary adult friends age 25-35, wearing casual dark-green and cream clothing, collaborate cheerfully around a small elegant emerald-and-gold microchip on a shared round worktable in a sunlit rooftop maker garden. Warm late-afternoon light, a subtle sense of discovery and community, no fantasy powers. Two small restrained BEM medallions beside the chip, fine gold circuit-like paths integrated into the table. Contemporary understated professional feeling, approachable not childish, deep emerald, warm ivory, restrained champagne-gold and sky-blue accents. Beautiful expressive adult faces and natural hands, clear silhouette groups readable at mobile size. Composition: generous visual breathing room, no clutter, brand at upper left in the clear sky/cream area, friends and chip toward center-right; retain simple quiet lower-left area, all important subjects and typography at least 8 percent inside image edges. Render only these words: exact brand BEMine in a sophisticated bold sans serif (B E M uppercase, i n e lowercase), immediately beneath or next to it smaller exact Chinese 拼矿; the coin engravings can say BEM only. Ensure impeccable spelling and crisp text. No slogan, no tagline, no extra text, no numbers, no financial charts, no piles of cash or coins, no profit promises, no QR codes, no addresses, no logos of other companies, no official endorsement, no watermark. A complete high-quality original community mining brand poster.
```

## 真实生活 · real

自然光咖啡馆生活摄影；普通成年朋友、小型芯片实物与一枚 BEM 纪念币。

原始图：`/Users/chcken/.codex/generated_images/01a0e0b4-9aa6-7c93-88a6-afd290c53862/exec-ffac39de-9820-4c22-96ea-2c76e8bae65b.png`。

调用：`transparent_background: false`，未提供 referenced_image_paths 或 num_last_images_to_include；全新生成。

完整提示词：

```text
Use case: ads-marketing, photorealistic-natural. Generate a completely NEW finished BEMine social-sharing brand poster in landscape ratio exactly 1.9048:1, intended 1200x630 pixels. A convincing candid editorial lifestyle photograph, NOT anime, NOT a 3D miniature, NOT CGI glossy fantasy. Scene: an airy modest neighborhood cafe co-working space in the morning, oak table, cream plaster, leafy plants, gentle soft natural window light. Three ordinary adults around age 30, two women and one man with diverse backgrounds, wearing relaxed unbranded clothes in forest green, oatmeal and blue-gray, sharing a curious friendly conversation while looking at a small physical emerald-and-gold microchip demonstration model on the table. One friend holds a phone with the screen facing inward and unreadable, another points naturally at the little chip; their hands and poses are realistic and relaxed. Exactly one small tasteful brass BEM token beside the microchip. They look like peers learning together, not bankers, influencers, celebrities, wealthy models, or a staged handshake. Shoot with refined documentary advertising photography, realistic skin texture, premium but approachable mood, moderate depth of field. Color story is warm cream with deep forest-green and subtle champagne gold accents. Composition: medium-wide scene with people grouped in right two-thirds, clean cream wall negative space in upper left, natural breathing room, main faces and chip fully inside the central safe zone. Add only the exact brand text BEMine, letters B E M uppercase and i n e lowercase, in restrained elegant dark green medium-bold sans serif; place smaller exact Chinese 拼矿 underneath. IMPORTANT: typography starts at least TEN PERCENT from the LEFT edge and TEN PERCENT from the TOP edge and is comfortably readable on mobile. Text appears as tasteful graphic typography, not wall signage or screen content. Coin can say only BEM. No other words, no slogans, no tagline, no numbers, no QR code, no visible application text, no returns claims, no line charts, no cash piles, no endorsement, no watermark. This should feel like real everyday participation in a trusted friendly technology community.
```

## 金融 · finance

奶油白石材、墨绿芯片和香槟金拼合圆环；克制的金融品牌静物。

原始图：`/Users/chcken/.codex/generated_images/01a0e0b4-9aa6-7c93-88a6-afd290c53862/exec-69a71fde-2e6c-4953-96eb-bb318e3827dc.png`。

调用：`transparent_background: false`，未提供 referenced_image_paths 或 num_last_images_to_include；全新生成。

完整提示词：

```text
Use case: ads-marketing, premium product-mockup. Generate a completely NEW BEMine brand social-sharing poster, landscape aspect ratio exactly 1.9048:1, intended 1200x630 pixels. Style: exceptionally restrained premium financial brand editorial still life, sculptural and tactile, calm trustworthy contemporary wealth-management aesthetic made accessible. No people. A single beautiful brushed dark-emerald microchip with champagne-gold pins rests on an elegant warm-ivory stone podium. Surround it with four interlocking quarter-ring pieces of matte deep green ceramic and softly brushed gold, suggesting shared ownership and coming together; rings are structural design objects, NOT pie charts or graphs. Exactly one simple embossed BEM coin leans against the base, modest scale. Gallery-quality materials, pale travertine, subtle paper grain, softly brushed champagne metal, precise machined circuitry, no glitter. Broad cream negative space at left, strong simple sculptural composition at right with generous breathing room. Studio photography with soft architectural shadows, warm neutral daylight and muted emerald contrast. Main chip and coin stay fully inside the inner 8 percent safe border. Brand is the only graphic typography: exact BEMine, with uppercase B E M and lowercase i n e, in refined substantial dark-green sans serif, followed by smaller Chinese 拼矿. Position this typography in upper-left cream space starting at TEN PERCENT from the left and TEN PERCENT from the top, keep it large enough to read on mobile. Coin has BEM engraving only. No other text, no tagline or slogan, no numbers, no performance lines, no candlesticks or upward arrows, no amount of money, no stacks of cash, no vault or bank emblem, no endorsement, no QR code, no crypto exchange logos, no watermark. The finished poster communicates stability, shared participation, precision and trust through materials and form rather than promises.
```

## 科技 · tech

深色精密透明芯片、冷色边缘光与四个共同参与节点；科技产品特写。

原始图：`/Users/chcken/.codex/generated_images/01a0e0b4-9aa6-7c93-88a6-afd290c53862/exec-0f9a9b0a-f6e9-46a0-8d4d-e736318f022a.png`。

调用：`transparent_background: false`，未提供 referenced_image_paths 或 num_last_images_to_include；全新生成。

完整提示词：

```text
Use case: ads-marketing, stylized-concept. Create a completely NEW premium technology brand poster for BEMine. Landscape aspect ratio exactly 1.9048:1, intended 1200 by 630 pixels. Visually unmistakable cutting-edge precision technology style, NOT lifestyle photography, NOT anime, NOT a cream financial still life. Deep midnight emerald and graphite environment with crystalline teal edge lighting, subtle champagne-gold conductors and refined optical glass. Subject: one large beautifully engineered dark-green microchip, seen at a dramatic three-quarter macro angle on the right two-thirds, a translucent glass top revealing luminous ordered internal circuitry. The chip connects via four elegant fine glowing circuit pathways to four small distinct glass nodes, suggesting shared participation in one mining machine, no numbers or charts. One small restrained gold BEM medallion in foreground, no piles. Chip top may carry BEM only. Precise manufacturing detail, clean architecture, sophisticated ray-traced reflections, restrained volumetric teal light, no noisy particles, no chaotic cyberpunk. Sharp macro product-shot focal clarity with cinematic dark gradients. Keep all key chip edges, nodes and token inside central safe zone; lots of calm breathing room in left third. Graphic typography at upper-left: EXACT brand BEMine, with capital B E M and lowercase i n e, in elegant substantial warm-ivory sans serif; smaller exact Chinese 拼矿 beneath it. Typography MUST begin at least TEN PERCENT from LEFT and TEN PERCENT from TOP, with comfortable outer margins, clearly readable on a mobile card. Only allowed text is BEMine, 拼矿 and BEM. No slogans, no taglines, no digits, no UI panels, no code snippets, no financial charts, no upward arrows, no prices, no dollar symbols, no piles of cash, no promise of returns, no third-party logos, no official endorsement, no QR, no watermark. A focused sophisticated community computing brand hero.
```

## 未采用的动漫边距探索

原始图：`/Users/chcken/.codex/generated_images/01a0e0b4-9aa6-7c93-88a6-afd290c53862/exec-8e5e8244-16ed-46ac-9b96-577f31d39112.png`。未复制到仓库、不用于当前页面。

提示词为动漫原稿完整提示词加上以下定位约束；仍为独立的新图生成，并非编辑现有成品：

```text
IMPORTANT final typography placement constraint: brand BEMine and 拼矿 must have a clear TEN PERCENT full-canvas-width empty margin on their LEFT (at least 173 pixels on a 1730px-wide image), and at least TEN PERCENT image-height empty margin on TOP. Position brand around x=13% and y=15%, use a moderately sized wordmark occupying about 25% image width, not a giant edge-to-edge heading. All important faces and the mining chip must remain inside 8% safe margins. Create a fresh complete composition satisfying these placement constraints.
```
