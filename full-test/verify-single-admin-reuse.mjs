import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadFullTestRuntime } from './server.mjs';
import { proveBootstrapReuse } from './prove-bootstrap-reuse.mjs';

// Read-only chain proof; this module has no wallet or transaction-sending code.
const previous = JSON.parse(readFileSync(process.argv[2]+'/public/deployment-artifacts.json'));
const next = JSON.parse(readFileSync(new URL('./public/deployment-artifacts.json',import.meta.url)));
const proof = proveBootstrapReuse(previous,next);
const db = new DatabaseSync('/var/lib/bemine-full-test/journal.sqlite',{readOnly:true});
const entries = db.prepare('select account,revision,record from deployment').all();
assert.equal(entries.length,1);
assert.equal(db.prepare('select count(*) as count from fresh_activation').get().count,0);
const entry=entries[0], record=JSON.parse(entry.record);
assert.equal(record.status,'complete');assert.equal(record.steps.length,16);
assert.equal(record.artifactDigest,proof.previousArtifactDigest);
assert(!record.steps.some(s=>s.id==='PlatformAuthority'));
const candidate={...record,artifactDigest:proof.artifactDigest,sourceCommit:next.sourceCommit};
const runtime=await loadFullTestRuntime();
const provider=runtime.createProductVerifierProvider(process.env.FULL_TEST_RPC_URL);
try {
  await runtime.verifyCompletedDeployment(provider,candidate,{trustedArtifactBundle:next});
  const trusted=runtime.productGraphConfiguration({record:candidate,bundle:next});
  const block=await provider.getBlock('latest');
  await runtime.verifyProductGraph(provider,candidate.addresses.factory,trusted,block);
  assert.equal((await provider.getBlock(block.number)).hash,block.hash);
  writeFileSync(process.argv[3],JSON.stringify({account:entry.account,revision:entry.revision,
    previousRecord:record,record:candidate,proof,verifiedBlockNumber:block.number,verifiedBlockHash:block.hash}),
    {flag:'wx',mode:0o600});
  console.log('All sixteen canonical receipts and the unchanged bootstrap graph verified. No chain transactions sent.');
} finally {db.close();provider.destroy();}
