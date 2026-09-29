# BEMine 分享海报 v11 · 设计组 B

生成日期：2026-09-27。使用内置 `image_gen`，每款独立一次生成，共四次；未使用 CLI、代码绘图、额外文字叠加或图像合成。原图保留在 Codex 生成目录。

四张均为全新作品，未传入 `referenced_image_paths` 或 `num_last_images_to_include`。先查看 v10 JPEG 理解品牌，随后各款独立生成；图内仅保留 BEMine、拼矿和 BEM，不烙固定宣传标语。

## 交付文件

JPEG 和桌面 WebP 为 1200×630，手机 WebP 为 640×336。Sharp 仅用于等比例 cover 缩放和压缩；JPEG 开启 mozjpeg、WebP effort=6。质量从 94 开始以 2 递减，取首个符合各自上限的结果。

| 设计 | JPEG 字节 / 质量 | 桌面 WebP 字节 / 质量 | 手机 WebP 字节 / 质量 |
| --- | ---: | ---: | ---: |
| 未来城市 (future) | 221574 / 86 | 131234 / 64 | 60538 / 78 |
| 纸艺微缩 (papercraft) | 217040 / 94 | 130176 / 88 | 59522 / 90 |
| 太空探索 (space) | 218170 / 90 | 127442 / 78 | 59754 / 84 |
| 东方水墨 (ink) | 221499 / 90 | 123016 / 76 | 57636 / 84 |

限制：JPEG ≤225280 字节（220 KiB），桌面 WebP ≤133120 字节（130 KiB），手机 WebP ≤61440 字节（60 KiB）。全部满足。

## 未来城市 · future

原图：`/Users/chcken/.codex/generated_images/01a0e128-a415-7742-a386-09c2cb972697/exec-d9284f33-c695-4834-bdfe-c774ec6911f4.png`

成品：

- `web/public/images/bemine-share-v11-future.jpg`
- `web/public/images/bemine-share-v11-future.webp`
- `web/public/images/bemine-share-v11-future-mobile.webp`

完整生成 prompt：

```text
Use case: ads-marketing.
Asset type: A brand-new landscape social sharing poster for BEMine, a friendly pooled BEM mining community. Final aspect ratio 1200:630, 1.905:1. Compose for exactly that wide crop, with generous safe margins and no important content near edges.
Primary request: FUTURE CITY edition, visually distinctive sophisticated optimistic sci-fi architectural concept art, not a photograph of a meeting room.
Scene: At blue hour, an elegant walkable futuristic city built around a glowing emerald-and-champagne-gold BEM microchip plaza. Four adult friends seen from behind in contemporary everyday clothing on a terrace, small human silhouettes at lower left, looking together toward the city; warm lamps and indoor gardens convey ordinary people participating in a shared future. The central plaza contains a clearly recognizable raised emerald computer microchip with fine gold pins and a tasteful BEM inscription. Graceful mid-rise towers, flowing elevated paths and tiny warm lights, distant lavender sky, subtle teal reflections. No piles of coins.
Style: premium cinematic architectural illustration with crisp 3D details, warm approachable humanity, professional fintech brand quality. Emerald and champagne gold primary, midnight blue and dusty violet secondary. Balanced generous negative space.
Text (verbatim): only "BEMine" and "拼矿", as a refined legible brand lockup in the upper left safe margin; BEM uppercase, ine lowercase. The chip may read "BEM". No tagline or any other text.
Constraints: no price, no currency amount, no performance chart, no rising arrows, no investment or yield promises, no casino, no QR code, no watermark, no interface, no split panels, no imitation official logo. Professional but welcoming.
```

## 纸艺微缩 · papercraft

原图：`/Users/chcken/.codex/generated_images/01a0e128-a415-7742-a386-09c2cb972697/exec-c0753397-c8d8-47b7-9f40-32121f6af49f.png`

成品：

- `web/public/images/bemine-share-v11-papercraft.jpg`
- `web/public/images/bemine-share-v11-papercraft.webp`
- `web/public/images/bemine-share-v11-papercraft-mobile.webp`

完整生成 prompt：

```text
Use case: ads-marketing.
Asset type: Brand-new landscape social sharing art for BEMine pooled BEM mining. Output composition 1200:630 aspect ratio, all lettering and main objects inside generous 7 percent safe margins.
Primary request: PAPERCRAFT MINIATURE edition. A finely handcrafted cut-paper and folded-card diorama, photographed with a macro tilt-shift lens and gentle studio shadows. Make it unmistakably tactile handmade paper, not plastic, not metal, not a flat vector drawing.
Scene: On a warm ivory paper stage, a large raised emerald-green microchip with champagne-gold paper pins is being assembled cooperatively by six tiny adult paper figures in moss, sage, terracotta and cream outfits. Each figure carries or places one little gold-edged tile on the shared chip. Tiny folded-paper trees and rolling layered paper hills create an inviting community landscape. A few circular embossed paper tokens marked BEM sit beside the chip. Constructive, cheerful, accessible to ordinary friends; polished enough for a trusted fintech brand.
Composition: Chip diorama fills center and right two-thirds, with six figures distributed around it. Upper left holds simple large brand text; ample cream breathing room around typography. Subtle perspective gives delightful depth.
Color palette: forest emerald, sage, champagne gold, warm ivory, small terracotta accents. Visible paper fibers, precise folds, soft dimensional shadows, premium editorial craft photography.
Text (verbatim): only "BEMine" and "拼矿" in the upper-left brand lockup, dark emerald lettering. Exact mixed case B E M i n e. Chip or paper tokens may show "BEM". No tagline and no additional text.
Avoid: investment promises, price, numbers, currency amounts, performance charts, upward arrows, casinos, QR codes, watermark, UI screens, confusing extra letters, split panels. No realistic people or glossy sci-fi architecture.
```

## 太空探索 · space

原图：`/Users/chcken/.codex/generated_images/01a0e128-a415-7742-a386-09c2cb972697/exec-ae198b83-6ee7-4b76-95cc-88de998fdfbd.png`

成品：

- `web/public/images/bemine-share-v11-space.jpg`
- `web/public/images/bemine-share-v11-space.webp`
- `web/public/images/bemine-share-v11-space-mobile.webp`

完整生成 prompt：

```text
Use case: ads-marketing.
Asset type: Brand-new BEMine social sharing poster, landscape 1200:630 aspect ratio, generous 7 percent safe margins.
Primary request: SPACE EXPLORATION edition. A beautiful sophisticated illustrated science-fiction expedition, cinematic but approachable and cooperative.
Scene: Three adult explorers in cream and emerald space suits work together beside a compact freestanding BEM mining microchip on an observation platform of a small lunar research outpost. One kneels to fit a small component, one steadies the unit, one looks through a transparent dome toward a spectacular blue-green Earth and distant stars. Their poses are naturally collaborative, no hero worship. The centerpiece is a tangible emerald microchip apparatus with champagne-gold pins and a clearly engraved BEM label; elegant, not industrial pollution. A warm-lit greenhouse dome sits at the side. Cool moon rock textures, gentle dust, quiet long shadows, one sweeping planetary horizon.
Composition: Broad open dark indigo star field in upper-left half supports a clean brand lockup. Explorers and chip live in lower-right half. Earth appears in the upper right; visually calm professional poster with a sense of shared discovery.
Style: premium cinematic digital matte-painting / realistic concept illustration, precise hardware details, soft warm light on explorers, restrained emerald/champagne accents against blue-indigo cosmos. Distinct from a city or craft miniature.
Text (verbatim): "BEMine" and "拼矿" only as a large clean upper-left brand lockup, ivory and champagne. B E M uppercase, i n e lowercase. The microchip may read "BEM". No fixed slogan, no other text.
Constraints: no price, currency amounts, charts, rising arrows, speculative profits, investment promises, casino, QR, watermark, flags, weapons, astronauts carrying coins, copied official mission logos, panels or UI. Welcoming teamwork rather than conquest.
```

## 东方水墨 · ink

原图：`/Users/chcken/.codex/generated_images/01a0e128-a415-7742-a386-09c2cb972697/exec-169c05ed-9cbf-46b4-a8ff-7dc6e504787e.png`

成品：

- `web/public/images/bemine-share-v11-ink.jpg`
- `web/public/images/bemine-share-v11-ink.webp`
- `web/public/images/bemine-share-v11-ink-mobile.webp`

完整生成 prompt：

```text
Use case: ads-marketing.
Asset type: Brand-new landscape social sharing poster for BEMine pooled BEM mining, 1200:630 aspect ratio. Main subjects and lettering within generous safe margins.
Primary request: EASTERN INK LANDSCAPE edition, a sophisticated contemporary Chinese ink-wash painting on warm ivory xuan paper, visible flowing brush texture, restrained metallic champagne-gold accents. This must look like fine painted paper art, not a photograph, not 3D render, not futuristic architecture.
Scene: Layers of misty dark-emerald mountains and gentle pale-sage rivers. In the lower right, a carefully drawn low emerald-and-gold computer microchip shaped like a serene courtyard platform bridges technology and landscape; a few elegant gold circuit traces flow into paths, deliberately sparse. Three tiny adult friends in simple contemporary outdoor clothes stand together by the platform and look across a shared landscape; warm ordinary companionship, not ancient emperors or worshippers. Small pine trees and a distant arched bridge add balance. Plenty of clean paper breathing room, no clutter.
Composition: wide contemplative panorama. Upper-left safe area has clean dark-emerald brand typography, art unfolds across center/right with the chip readable near lower center-right. Ink brush strokes and elegant empty space should feel calm, trustworthy, inclusive and quietly adventurous.
Color palette: ivory paper, dark emerald ink, pale sage wash, champagne-gold circuit accents, a very subtle warm apricot sun.
Text (verbatim): only "BEMine" and "拼矿", a clean legible upper-left brand lockup. Exact capitalization B E M i n e. Optional single "BEM" on the chip. No poem, no fixed slogan, no other Chinese or English writing, no red seals.
Avoid: price, currency amounts, financial charts, arrows, investment or profit promises, casinos, QR codes, watermark, official logos, painted imitation UI, split panels, realistic portraits, ornate imperial symbols.
```

## 验看记录

每张原图均使用 view_image 查看；另验看 future 桌面 WebP 和 papercraft、space、ink 的手机 WebP。确认品牌大小写为 BEMine，中文拼矿可辨识；四款场景分别为城市共享芯片广场、六人纸艺协作、探索者维护 BEM 设备、山水中的朋友与芯片台。未出现固定宣传语、金额、收益保证、二维码、赌场或涨势图。太空款为想象性探索题材，不作为航天科学示意图。

尺寸及字节通过 Sharp metadata 和文件 stat 逐个核验。此次只新增指定的十二个图片文件和本文档，未修改页面代码、未提交、未推送、未部署。
