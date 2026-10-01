import assert from 'node:assert/strict';
import test from 'node:test';
import { proveBootstrapReuse } from './prove-bootstrap-reuse.mjs';
const old=()=>({metadata:{profile:'full-test'},originalSourceHashes:{one:'original'},
  sourceHashes:{'src/PlatformAuthority.sol':'old'},artifacts:{
    PoolVault:{abi:[],bytecode:'0x12',deployedBytecode:'0x34',immutableReferences:{7:[{start:1,length:32}]}},
    PlatformAuthority:{abi:[],bytecode:'0x56',deployedBytecode:'0x78'}}});
const updated=()=>{const n=old();n.metadata.administratorMode='single';n.sourceHashes['src/PlatformAuthority.sol']='new';
  n.artifacts.PlatformAuthority.bytecode='0x9a';n.artifacts.PoolVault.immutableReferences={8:[{start:1,length:32}]};return n;};
test('single-admin Authority change preserves bootstrap bytecode despite shifted compiler AST IDs',()=>{
  assert.equal(proveBootstrapReuse(old(),updated()).preservedRuntimeCount,1);
});
test('bootstrap reuse rejects code, ABI, immutable-offset and unrelated source changes',()=>{
  for(const modify of [n=>{n.artifacts.PoolVault.bytecode='0xff';},n=>{n.artifacts.PoolVault.abi=['changed'];},
    n=>{n.artifacts.PoolVault.immutableReferences[8][0].start=2;},n=>{n.sourceHashes.other='new';}]){
    const n=updated();modify(n);assert.throws(()=>proveBootstrapReuse(old(),n));
  }
});
