/** Reproducible raster export of the authored vector poster; no remote images or runtime keys. */
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),sharp=require(require.resolve('sharp',{paths:[dirname(require.resolve('next/package.json'))]}));
const image=resolve(dirname(fileURLToPath(import.meta.url)),'../public/images/bemine-budget-share');
await sharp(`${image}.svg`).png({compressionLevel:9}).toFile(`${image}.png`);
console.log('Portfolio poster rendered from the committed SVG.');
