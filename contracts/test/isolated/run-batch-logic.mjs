/** TEST ONLY: exercises the candidate logic with a controlled mock runtime in a disposable copy.
 * This deliberately does NOT verify Firsto runtime provenance or enable the production route.
 * The original candidate retains the advertised protocol pin and is checked unchanged afterward.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const require=createRequire(join(root,'deploy/package.json'));
const {keccak256}=require('ethers');
const sourcePath=join(root,'contracts/src/libraries/FlexiblePurchase.sol');
const original=readFileSync(sourcePath,'utf8');
const advertised='0x0a44a1aa18057cf5345eea9e1c58e4d40b0ff9c3da52c0f6eb8032320e7f23fb';
assert.equal(original.split(advertised).length,2,'Candidate must retain exactly one advertised runtime pin.');
const sandbox=mkdtempSync(join(tmpdir(),'bemine-batch-isolated-logic-'));
const contracts=join(sandbox,'contracts');mkdirSync(contracts);
for(const item of ['src','test','script','foundry.toml','remappings.txt']) cpSync(join(root,'contracts',item),join(contracts,item),{recursive:true});
symlinkSync(realpathSync(join(root,'node_modules')),join(sandbox,'node_modules'),'dir');
const run=args=>{
  const result=spawnSync(process.execPath,[join(root,'scripts/run-forge.mjs'),...args,'--root',contracts],
    {cwd:sandbox,encoding:'utf8',maxBuffer:20*1024*1024});
  process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
  assert.equal(result.status,0,`Isolated Forge ${args[0]} failed; artifacts retained at ${sandbox}`);
};
console.log(`ISOLATED MOCK LOGIC ONLY. Candidate/runtime provenance is not verified. Sandbox: ${sandbox}`);
try {
  run(['build','--skip','script']);
  const artifact=JSON.parse(readFileSync(join(contracts,'out/FirstoBatchMocks.sol/FirstoBatchAskMock.json'),'utf8'));
  const mockHash=keccak256(artifact.deployedBytecode.object);
  writeFileSync(join(contracts,'src/libraries/FlexiblePurchase.sol'),original.replace(advertised,mockHash));
  writeFileSync(join(contracts,'test/unit/FirstoBatchIsolatedLogic.t.sol'),
    readFileSync(join(root,'contracts/test/isolated/FirstoBatchLogic.t.sol.template'),'utf8'));
  console.log(`ISOLATED pin replaced with controlled mock hash ${mockHash}; production source unchanged.`);
  run(['test','--match-path','test/unit/FirstoBatchIsolatedLogic.t.sol','-vv']);
  writeFileSync(join(sandbox,'isolation-summary.json'),JSON.stringify({scope:'isolated mock logic, not protocol provenance',
    advertisedPin:advertised,mockHash,productionSourceUnchanged:true},null,2));
} finally { assert.equal(readFileSync(sourcePath,'utf8'),original,'Production candidate changed during isolated tests.'); }
