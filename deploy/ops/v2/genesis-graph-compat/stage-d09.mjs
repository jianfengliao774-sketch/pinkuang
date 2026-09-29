import { createHash } from 'node:crypto';
import { constants, readFileSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The running v2 service was independently observed to contain these exact
// d09b25c bytes. Refuse any other release instead of applying a fuzzy patch.
export const D09_JOURNAL_SHA256 = '68194b6785598cc35bca475f036f9b89f4fb3dab6dfb2114d890dfda6a1466dd';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const replaceOnce = (source, oldText, newText) => {
  if (source.split(oldText).length !== 2) throw new Error('The reviewed d09b25c patch anchor changed.');
  return source.replace(oldText, newText);
};

export function patchD09Journal(bytes) {
  if (sha256(bytes) !== D09_JOURNAL_SHA256) throw new Error('Not the reviewed d09b25c journal source.');
  let source = bytes.toString('utf8');
  source = replaceOnce(source,
    "import { productGraphConfiguration, verifyProductGraph } from './product-graph.mjs';",
    "import { productGraphConfiguration, verifyProductGraph } from './product-graph.mjs';\n"
      + "import { createV2GenesisGraphReader } from './v2-genesis-public-graph.mjs';");
  source = replaceOnce(source,
    "  if (decoded.name === 'propose' && decoded.args[0] === 0n) fail(400, 'Whole miner sale price must be positive.');",
    "  if (decoded.name === 'list' && decoded.args[2] === 0n) fail(400, 'Share listing price must be positive.');\n"
      + "  if (decoded.name === 'propose' && decoded.args[0] === 0n) fail(400, 'Whole miner sale price must be positive.');");
  source = replaceOnce(source,
    "  const productMode = Boolean(trustedProduct) || typeof productGraphVerifier === 'function' && productFactories.size > 0;",
    "  const productMode = Boolean(trustedProduct) || typeof productGraphVerifier === 'function' && productFactories.size > 0;\n"
      + "  const publicGenesisGraph = createV2GenesisGraphReader({ provider: officialProvider, trustedProduct, graphVerifier, now });");
  source = replaceOnce(source,
    "      if (method === 'GET' && ['/api/journal/official-candidates','/api/journal/budget-candidates'].includes(path)){",
    "      if (method === 'GET' && path === '/api/journal/product-graph') {\n"
      + "        if (url.search) fail(400, 'Product graph does not accept caller-selected parameters.');\n"
      + "        try { return send(200, await publicGenesisGraph()); }\n"
      + "        catch { fail(503, 'Reviewed original v2 graph is unavailable.'); }\n"
      + "      }\n"
      + "      if (method === 'GET' && ['/api/journal/official-candidates','/api/journal/budget-candidates'].includes(path)){");
  return Buffer.from(source);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) {
    process.stderr.write('Usage: node stage-d09.mjs <exact-d09-journal-api.mjs> <empty-local-output-dir>\n');
    process.exitCode = 2;
  } else {
    const [input, output] = process.argv.slice(2);
    const patched = patchD09Journal(readFileSync(input));
    const server = join(resolve(output), 'server');
    mkdirSync(server, { recursive: true, mode: 0o700 });
    writeFileSync(join(server, 'journal-api.mjs'), patched, { flag: 'wx', mode: 0o600 });
    copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'v2-genesis-public-graph.mjs'),
      join(server, 'v2-genesis-public-graph.mjs'), constants.COPYFILE_EXCL);
    process.stdout.write(JSON.stringify({ sourceSha256: D09_JOURNAL_SHA256,
      stagedJournalSha256: sha256(patched), files: ['server/journal-api.mjs', 'server/v2-genesis-public-graph.mjs'] }) + '\n');
  }
}
