import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SHARE_ARTWORKS } from '../lib/share-artwork.mjs';

const variants = [['.jpg', 220 * 1024], ['.webp', 130 * 1024], ['-mobile.webp', 60 * 1024]];
const report = [];
for (const art of SHARE_ARTWORKS) {
  const entry = { id: art.id };
  for (const [extension, budget] of variants) {
    const file = `${art.base}${extension}`;
    const bytes = await readFile(new URL(`../public/images/${file}`, import.meta.url));
    assert(bytes.length > 0 && bytes.length <= budget, `${file}: ${bytes.length} bytes exceeds ${budget} byte budget`);
    if (extension === '.jpg') assert(bytes[0] === 0xff && bytes[1] === 0xd8, `${file}: expected JPEG`);
    else assert(bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP', `${file}: expected WebP`);
    entry[extension] = bytes.length;
  }
  report.push(entry);
}
console.log(`Share artwork: ${report.length} posters / ${report.length * variants.length} files within mobile, desktop and download budgets.`);
