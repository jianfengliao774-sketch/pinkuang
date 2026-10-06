import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// Already a locked transitive dependency of @openzeppelin/upgrades-core.
const require = createRequire(import.meta.url);
const { keccak256 } = require('ethereum-cryptography/keccak');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sourceHash = content => `0x${Buffer.from(keccak256(Buffer.from(content, 'utf8'))).toString('hex')}`;

/**
 * Prepare a separate compiler-input copy for OpenZeppelin validation.
 *
 * Windows Foundry can emit both relative and absolute source names in solc
 * output, while build-info input includes only the absolute name. Every missing
 * input alias is recovered only from existing input content whose keccak256
 * matches the compiler-emitted metadata for that exact alias. Compiler output,
 * existing source contents, ASTs, bytecode, and storage layouts are never edited.
 * On platforms without the mismatch, each build-info file is copied byte for byte.
 */
export default function prepareUpgradeBuildInfo(root) {
  const projectRoot = path.resolve(root);
  const out = path.join(projectRoot, 'contracts', 'out');
  const sourceDirectory = path.join(out, 'build-info');
  const destination = path.join(out, 'upgrade-build-info');
  const files = readdirSync(sourceDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => entry.name)
    .sort();
  assert(files.length > 0, `No compiler build-info found in ${sourceDirectory}`);

  // Finish verification before publishing or removing any generated copies.
  const prepared = files.map(name => {
    const source = path.join(sourceDirectory, name);
    const original = readFileSync(source);
    const info = JSON.parse(original.toString('utf8'));
    assert(info.input?.sources && info.output?.sources && info.output?.contracts, `Invalid build-info: ${name}`);
    const originalOutput = JSON.stringify(info.output);
    const originalSources = Object.entries(info.input.sources);
    const originalInput = new Map(originalSources.map(([key, value]) => [key, JSON.stringify(value)]));
    const missing = Object.keys(info.output.sources).filter(key => !Object.hasOwn(info.input.sources, key));
    const repairs = [];

    if (missing.length > 0) {
      const metadataHashes = new Map();
      for (const contracts of Object.values(info.output.contracts)) {
        for (const contract of Object.values(contracts)) {
          if (contract.metadata === undefined) continue;
          const metadata = typeof contract.metadata === 'string' ? JSON.parse(contract.metadata) : contract.metadata;
          for (const [key, descriptor] of Object.entries(metadata.sources ?? {})) {
            if (!/^0x[0-9a-f]{64}$/i.test(descriptor.keccak256 ?? '')) continue;
            if (!metadataHashes.has(key)) metadataHashes.set(key, new Set());
            metadataHashes.get(key).add(descriptor.keccak256.toLowerCase());
          }
        }
      }
      const byHash = new Map();
      for (const [key, value] of originalSources) {
        if (typeof value.content !== 'string') continue;
        const hash = sourceHash(value.content);
        if (!byHash.has(hash)) byHash.set(hash, []);
        byHash.get(hash).push([key, value]);
      }
      for (const alias of missing) {
        const hashes = metadataHashes.get(alias);
        assert(hashes?.size === 1, `Missing or conflicting metadata keccak256 for ${name}: ${alias}`);
        const [expectedHash] = hashes;
        const candidates = byHash.get(expectedHash);
        assert(candidates?.length > 0, `No metadata-verified input content for ${name}: ${alias}`);
        const [copiedFrom, descriptor] = candidates[0];
        assert(candidates.every(([, value]) => value.content === descriptor.content), `Ambiguous content for ${alias}`);
        info.input.sources[alias] = { ...descriptor };
        repairs.push({ alias, copiedFrom, metadataKeccak256: expectedHash });
      }
    }

    assert.equal(JSON.stringify(info.output), originalOutput, `Compiler output changed: ${name}`);
    for (const [key, expected] of originalInput) {
      assert.equal(JSON.stringify(info.input.sources[key]), expected, `Existing input changed: ${key}`);
    }
    return {
      name,
      source,
      bytes: repairs.length === 0 ? original : Buffer.from(`${JSON.stringify(info)}\n`, 'utf8'),
      audit: {
        file: name,
        originalFileSha256: sha256(original),
        unchangedCompilerOutputSha256: sha256(originalOutput),
        originalInputSourceCount: originalSources.length,
        preparedInputSourceCount: Object.keys(info.input.sources).length,
        outputSourceCount: Object.keys(info.output.sources).length,
        repairs,
      },
    };
  });

  // This is an exclusively generated sibling of build-info. Remove only stale
  // regular JSON files, never compiler originals or arbitrary directory trees.
  assert.equal(path.dirname(destination), out);
  assert.notEqual(destination, sourceDirectory);
  mkdirSync(destination, { recursive: true });
  const current = new Set(files);
  for (const entry of readdirSync(destination, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json') && !current.has(entry.name)) {
      unlinkSync(path.join(destination, entry.name));
    }
  }
  for (const item of prepared) {
    assert.equal(sha256(readFileSync(item.source)), item.audit.originalFileSha256, `Source build-info changed during preparation: ${item.name}`);
    writeFileSync(path.join(destination, item.name), item.bytes);
  }
  // Keep audit outside the validation directory: it is not compiler build-info.
  const auditPath = path.join(out, 'upgrade-build-info-audit.json');
  writeFileSync(auditPath, `${JSON.stringify({ sourceDirectory, destination, files: prepared.map(item => item.audit) }, null, 2)}\n`);
  const repairedCount = prepared.reduce((count, item) => count + item.audit.repairs.length, 0);
  console.log(`Upgrade build-info prepared: ${files.length} file(s), ${repairedCount} metadata-verified input aliases; compiler output unchanged.`);
  console.log(`Preparation audit: ${auditPath}`);
  return destination;
}
