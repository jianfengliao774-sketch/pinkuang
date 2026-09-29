import test from 'node:test';
import assert from 'node:assert/strict';
import { addr, hash, fixture } from './fresh-cutover-fixture.mjs';
import { prepareFreshCutover } from './prepare-fresh-cutover.mjs';
import { ORIGINAL_GAS_WALLET } from '../../shared/original-gas-wallet.mjs';

test('offline v4 draft contains only new graph and remains disabled pending live proof',()=>{
  const result=prepareFreshCutover(fixture());
  assert.equal(result.activationAllowed,false);
  assert.deepEqual([result.oldSite,result.newSite],['/bemine-v2/','/bemine-v4/']);
  assert.equal(result.runtimeEnvironment.BEMINE_LEGACY_FACTORY,undefined);
  assert.equal(result.runtimeEnvironment.PORT,'4177');
  assert.equal(result.indexEnvironment.CHAIN_INDEX_PORT,'4184');
  assert.equal(result.indexEnvironment.CHAIN_INDEX_MODE,'fresh-v4');
  assert.equal(result.indexEnvironment.CHAIN_INDEX_FACTORY,undefined);
  assert.equal(result.indexEnvironment.CHAIN_INDEX_FRESH_MANIFEST_SHA256,result.indexManifestSha256);
  assert.equal(result.indexManifest.factory,fixture().record.addresses.factory);
  assert.equal(result.runtimeEnvironment.BEMINE_FRESH_CONSOLE_PRE_GENESIS,'1');
  assert.equal(result.runtimeEnvironment.BEMINE_FRESH_STAGE2_HOLD,'1');
  assert.equal(result.runtimeEnvironment.AUTHORITY_RELAY_PUBLIC_ENABLED,'0');
  assert.doesNotMatch(result.runtimeUnit,/LoadCredential|KEEPER_PRIVATE_KEY/);
  assert.equal(result.runtimeEnvironment.AUTHORITY_RELAY_JOURNAL,undefined);
  assert.equal(result.signerEnvironment.AUTHORITY_RELAY_JOURNAL,
    '/var/lib/pinkuang-v4-signer/authority/authority.json');
  assert.match(result.runtimeUnit,/StateDirectoryMode=0700/);
  assert.equal(result.runtimeEnvironment.AUTHORITY_RELAY_ENABLED,'0');
  assert.equal(result.runtimeEnvironment.PINKUANG_KEEPER_STATE_ROOT,undefined);
  assert.match(result.runtimeRelayDropIn,/LoadCredential=authority-ipc-hmac:/);
  assert.match(result.runtimeRelayDropIn,/Environment=AUTHORITY_RELAY_PUBLIC_ENABLED=0/);
  assert.doesNotMatch(result.runtimeRelayDropIn,/keeper-private-key/);
  assert.match(result.signerUnit,/User=pinkuang-v4-signer/);
  assert.match(result.signerUnit,/Group=pinkuang-v4-relay/);
  assert.match(result.signerUnit,/RuntimeDirectoryMode=0750/);
  assert.match(result.signerUnit,/LoadCredential=keeper-private-key:.*keeper\.key/);
  assert.match(result.signerUnit,/StartLimitIntervalSec=10min\nStartLimitBurst=3/);
  assert.equal(result.signerEnvironment.AUTHORITY_RELAY_ENABLED,'0');
  assert.equal(result.signerEnvironment.AUTHORITY_SIGNER_ATTEST_ONLY,'1');
  assert.match(result.signerUnit,/Environment=AUTHORITY_SIGNER_ATTEST_ONLY=1/);
  assert.match(result.signerUnit,/ExecStart=\/usr\/bin\/node \/srv\/pinkuang-v4-signer\/releases\/v4-test-runtime\/server\/authority-signer\.mjs/);
  assert.equal(result.purchaseEnvironment.FRESH_PURCHASE_ENABLED,'0');
  assert.match(result.purchaseUnit,/--fresh-graph --send/);
  assert.match(result.purchaseUnit,/LoadCredential=keeper-private-key:.*keeper\.key/);
  assert.match(result.purchaseUnit,/StartLimitIntervalSec=10min\nStartLimitBurst=3/);
  assert.match(result.purchaseUnit,/RestartPreventExitStatus=2/);
  assert.match(result.nginxSnippet,/location \^~ \/pinkuang-deploy-v4\/ \{\n    auth_basic "BEMine deployment";\n    auth_basic_user_file \/etc\/nginx\/pinkuang-deploy-v4\.htpasswd;\n    proxy_set_header Authorization "";/);
  assert.match(result.nginxSnippet,/location \^~ \/bemine-v4\/api\/journal\/deployment \{ return 404; \}/);
  assert.match(result.nginxSnippet,/location \^~ \/bemine-v4\/api\/journal\/fresh-activation \{ return 404; \}/);
  assert.match(result.nginxSnippet,/location \^~ \/bemine-v4\/api\/ \{[^}]*proxy_read_timeout 90s;/,
    'the product API proxy must outwait the 45-second authority IPC timeout');
  assert.match(result.nginxSnippet,/location \^~ \/pinkuang-deploy-v4\/ \{[^}]*proxy_read_timeout 90s;/,
    'the longer proxy wait remains scoped to the product API');
  assert.match(result.nginxSnippet,/location \^~ \/bemine-v4\/firsto-api\/ \{[^}]*proxy_set_header X-Real-IP \$remote_addr;/);
  assert.match(result.nginxSnippet,/location \^~ \/bemine-v4\/ \{[^}]*alias \/var\/www\/bemine-v4\/current\/public\//);
  assert.doesNotMatch(result.nginxSnippet,/root \/var\/www\/bemine-v4\/current\/public/);
  assert.match(result.purchaseUnit,/ReadWritePaths=\/var\/lib\/pinkuang-v4-signer/);
});

test('offline v4 draft accepts the selected original Gas address but keeps both senders disabled',()=>{
  const f=fixture();
  const activation={...f.activation,authority:{...f.activation.authority,gasWallet:ORIGINAL_GAS_WALLET}};
  const manifest={...f.manifest,gasWallet:ORIGINAL_GAS_WALLET,
    freshAuthority:{...f.manifest.freshAuthority,gasWallet:ORIGINAL_GAS_WALLET}};
  const result=prepareFreshCutover({...f,activation,manifest,expectedGasWallet:ORIGINAL_GAS_WALLET});
  assert.equal(result.activationAllowed,false);
  assert.equal(result.signerEnvironment.AUTHORITY_RELAY_ENABLED,'0');
  assert.equal(result.signerEnvironment.BEMINE_V2_GAS_SENDER_DRAINED,'0');
  assert.equal(result.purchaseEnvironment.FRESH_PURCHASE_ENABLED,'0');
  assert.equal(result.purchaseEnvironment.BEMINE_V2_GAS_SENDER_DRAINED,'0');
  assert.match(result.signerUnit,/LoadCredential=keeper-private-key:\/etc\/pinkuang\/keeper\.key/);
  assert.match(result.purchaseUnit,/LoadCredential=keeper-private-key:\/etc\/pinkuang\/keeper\.key/);
  assert.ok(result.missingLiveProofs.some(proof=>proof.includes('pending nonce')));
});

test('offline v4 draft rejects wrong graph, truncated Gas address and mismatched manifest',()=>{
  const f=fixture();
  assert.throws(()=>prepareFreshCutover({...f,expectedGasWallet:f.expectedGasWallet.slice(0,-1)}),/40-hex/);
  assert.throws(()=>prepareFreshCutover({...f,expectedGasWallet:addr(93)}),/reviewed deployment-console role/);
  assert.throws(()=>prepareFreshCutover({...f,keeperStateRoot:'/tmp/keeper'}),/dedicated private nonce state root/);
  assert.throws(()=>prepareFreshCutover({...f,manifest:{...f.manifest,factory:addr(94)}}),/Manifest factory/);
  assert.throws(()=>prepareFreshCutover({...f,manifest:{...f.manifest,verifiedBlockHash:hash(999)}}),/same fresh genesis/);
  assert.throws(()=>prepareFreshCutover({...f,record:{...f.record,addresses:{...f.record.addresses,
    factory:f.record.addresses.portfolioFactory}}}),/trusted code evidence|separate/);
});

test('offline v4 draft binds deployer and activated administrators to the deployment console',()=>{
  const f=fixture();
  const wrongDeployer=addr(90);
  assert.throws(()=>prepareFreshCutover({...f,activation:{...f.activation,deployer:wrongDeployer}}),
    /activation evidence deployer/);
  assert.throws(()=>prepareFreshCutover({...f,record:{...f.record,account:wrongDeployer,
    input:{...f.record.input,ownerMultisig:wrongDeployer,operator:wrongDeployer,treasury:wrongDeployer}}}),
  /fresh genesis deployer|trusted/);
  const wrongAdmin=addr(91);
  const authority={...f.activation.authority,administratorOne:wrongAdmin};
  assert.throws(()=>prepareFreshCutover({...f,
    activation:{...f.activation,authority},
    manifest:{...f.manifest,freshAuthority:{...f.manifest.freshAuthority,administratorOne:wrongAdmin}}}),
  /activated administrators|trusted/);
});
