import assert from 'node:assert/strict';
import { keccak256, toUtf8Bytes } from 'ethers';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value==='object'
  ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
const artifactContentDigest = ({sourceCommit:_commit,...content}) => keccak256(toUtf8Bytes(JSON.stringify(canonical(content))));

// Solidity AST IDs can shift when a different source is edited. Runtime
// verification uses the byte offsets, not those compiler-internal IDs.
const immutableSpans = artifact => Object.values(artifact.immutableReferences ?? {}).flat()
  .map(({start,length})=>({start,length})).sort((a,b)=>a.start-b.start || a.length-b.length);

export function proveBootstrapReuse(previous, next) {
  assert.equal(previous.metadata?.profile, 'full-test');
  assert.equal(next.metadata?.profile, 'full-test');
  assert.equal(next.metadata.administratorMode, 'single');
  assert.deepEqual(next.originalSourceHashes, previous.originalSourceHashes);
  assert.deepEqual(Object.keys(next.artifacts), Object.keys(previous.artifacts));
  assert.deepEqual(Object.keys(next.sourceHashes).filter(name=>next.sourceHashes[name]!==previous.sourceHashes[name]),
    ['src/PlatformAuthority.sol']);
  for (const name of Object.keys(previous.artifacts)) {
    assert.deepEqual(next.artifacts[name].abi, previous.artifacts[name].abi, name+' ABI changed');
    if (name==='PlatformAuthority') continue;
    const {immutableReferences:_old,...oldCode}=previous.artifacts[name];
    const {immutableReferences:_next,...nextCode}=next.artifacts[name];
    assert.deepEqual(nextCode,oldCode,name+' bootstrap artifact changed');
    assert.deepEqual(immutableSpans(next.artifacts[name]),immutableSpans(previous.artifacts[name]),name+' immutable offsets changed');
  }
  return {previousArtifactDigest:artifactContentDigest(previous),artifactDigest:artifactContentDigest(next),
    changedRuntime:'PlatformAuthority',preservedRuntimeCount:Object.keys(next.artifacts).length-1};
}
