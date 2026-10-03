import test from 'node:test';
import assert from 'node:assert/strict';
import { freshRuntimeLayout } from './fresh-runtime-identity.mjs';

test('v5 API, index, journals and readiness cannot overlap the v4 layout',()=>{
 const old=freshRuntimeLayout({}),current=freshRuntimeLayout({BEMINE_FRESH_RUNTIME_VERSION:'5'});
 assert.equal(old.apiPort,'4187');assert.equal(current.apiPort,'4227');
 assert.equal(current.indexPort,'4224');
 for(const name of ['signerRoot','keeperRoot','authorityJournal','workerRoot','drainPath'])
  assert.notEqual(current[name],old[name]);
 assert.equal(current.workerUnits.purchase,'pinkuang-v5-purchase.service');
 assert.equal(current.workerUnits.mining,'pinkuang-v5-mining.service');
 assert.throws(()=>freshRuntimeLayout({BEMINE_FRESH_RUNTIME_VERSION:'../4'}),/Unsupported/);
});
