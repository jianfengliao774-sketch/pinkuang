import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareStage2Attestation } from './prepare-stage2-attestation.mjs';
import { ORIGINAL_GAS_WALLET } from '../../shared/original-gas-wallet.mjs';
import { authorityIpcConfiguration } from '../../server/authority-ipc.mjs';

test('pre-activation Gas signer draft can only attest; neither process can broadcast',()=>{
  const draft=prepareStage2Attestation({signerReleaseId:'v4-reviewed-123',
    expectedGasWallet:ORIGINAL_GAS_WALLET});
  assert.equal(draft.activationAllowed,false);
  assert.equal(draft.signerEnvironment.AUTHORITY_SIGNER_ATTEST_ONLY,'1');
  assert.equal(draft.signerEnvironment.AUTHORITY_RELAY_ENABLED,'0');
  assert.match(draft.signerUnit,/Environment=AUTHORITY_SIGNER_ATTEST_ONLY=1/);
  assert.match(draft.signerUnit,/LoadCredential=keeper-private-key:\/etc\/pinkuang\/keeper\.key/);
  assert.match(draft.signerUnit,/ExecStart=\/usr\/bin\/node \/srv\/pinkuang-v4-signer\/releases\/v4-reviewed-123\/server\/authority-signer\.mjs/);
  assert.match(draft.publicDropIn,/Environment=AUTHORITY_RELAY_PUBLIC_ENABLED=0/);
  assert.match(draft.publicDropIn,/Environment=BEMINE_FRESH_STAGE2_HOLD=1/);
  assert.match(draft.publicDropIn,/SupplementaryGroups=pinkuang-v4-relay/);
  assert.doesNotMatch(draft.publicDropIn,/keeper-private-key|KEEPER_PRIVATE_KEY/);
  assert.equal(draft.signerReleaseRequiresIndependentPackage,true);
  const credentials=mkdtempSync(join(tmpdir(),'stage2-public-hmac-'));
  try{
    writeFileSync(join(credentials,'authority-ipc-hmac'),randomBytes(32));
    const dropIn=Object.fromEntries(draft.publicDropIn.split('\n')
      .filter(line=>line.startsWith('Environment='))
      .map(line=>line.slice('Environment='.length).split(/=(.*)/s).slice(0,2)));
    const configured=authorityIpcConfiguration({...dropIn,
      DEPLOYMENT_JOURNAL_ORIGIN:'https://tapeout.cc.cd',
      DEPLOYMENT_JOURNAL_DB:join(credentials,'journal.sqlite'),
      DEPLOYMENT_JOURNAL_RPC_URL:'https://example.test/rpc',
      CREDENTIALS_DIRECTORY:credentials});
    assert.equal(configured.expectedGasWallet,ORIGINAL_GAS_WALLET);
    assert.equal(configured.recordPath,undefined,
      'the Stage 2 proof does not require an Authority activation graph');
  }finally{rmSync(credentials,{recursive:true,force:true});}
});

test('Stage 2 attestation refuses an unreviewed address or path-like release id',()=>{
  const good={signerReleaseId:'v4-reviewed-123',expectedGasWallet:ORIGINAL_GAS_WALLET};
  assert.throws(()=>prepareStage2Attestation({...good,signerReleaseId:'../evil'}),/release id/);
  assert.throws(()=>prepareStage2Attestation({...good,expectedGasWallet:'0x0000000000000000000000000000000000000001'}),
    /reviewed original Gas public address/);
});
