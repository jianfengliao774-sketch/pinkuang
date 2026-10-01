import { build } from '../../deploy/node_modules/esbuild/lib/main.js';
import { readFile, writeFile, mkdir, copyFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(root, 'web-sandbox');
const out = path.join(source, 'dist');
await mkdir(out, { recursive: true });
const rawArtifact = await readFile(path.join(source, 'public/sale-sandbox-artifacts.json'), 'utf8');
const artifactDigest = `0x${createHash('sha256').update(rawArtifact).digest('hex')}`;
const bundled = await build({ entryPoints: [path.join(source, 'src/main.mjs')], bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: true, write: false, nodePaths: [path.join(root, 'deploy/node_modules')], legalComments: 'none', define: { __SANDBOX_ARTIFACT_DIGEST__: JSON.stringify(artifactDigest) } });
const js = bundled.outputFiles[0].text;
const css = await readFile(path.join(source, 'src/style.css'), 'utf8');
const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);
const jsName = `app-${hash(js)}.mjs`, cssName = `style-${hash(css)}.css`;
const html = (await readFile(path.join(source, 'index.html'), 'utf8')).replace('./app.mjs', `./${jsName}`).replace('./style.css', `./${cssName}`);
await writeFile(path.join(out, jsName), js);
await writeFile(path.join(out, cssName), css);
await writeFile(path.join(out, 'index.html'), html);
await copyFile(path.join(source, 'public/sale-sandbox-artifacts.json'), path.join(out, 'sale-sandbox-artifacts.json'));
for (const entry of await readdir(out, { withFileTypes: true })) {
  if (!entry.isFile() || !/^(?:app-[a-f0-9]{12}\.mjs|style-[a-f0-9]{12}\.css)$/.test(entry.name) || [jsName, cssName].includes(entry.name)) continue;
  const target = path.resolve(out, entry.name);
  if (path.dirname(target) !== path.resolve(out)) throw new Error('Build cleanup target escaped its managed directory');
  await unlink(target);
}
console.log(JSON.stringify({ output: out, js: jsName, css: cssName, bytes: Buffer.byteLength(js), artifact: 'sale-sandbox-artifacts.json', artifactDigest }));
