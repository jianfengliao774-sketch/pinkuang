import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getAddress } from 'ethers';
import { productGraphConfiguration } from '../../server/product-graph.mjs';
import { createFreshIndexManifest, freshIndexManifestSha256 } from '../../server/chain-index/fresh-manifest.mjs';
import { ORIGINAL_GAS_WALLET } from '../../shared/original-gas-wallet.mjs';
import { FRESH_ADMIN_ONE, FRESH_ADMIN_TWO, FRESH_DEPLOYER, FRESH_GAS_WALLET } from '../../shared/fresh-roles.mjs';

const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const check = (ok,message) => { if (!ok) throw new Error(message); };
const publicAddress = value => {
  check(typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value), 'A complete 40-hex public address is required.');
  return getAddress(value);
};
const release = (value,prefix) => {
  check(typeof value === 'string' && /^v4-[a-z0-9][a-z0-9-]{1,70}$/.test(value),
    `Invalid ${prefix} release id.`);
  return value;
};
const https = value => {
  check(typeof value === 'string' && /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?\/?$/i.test(value),
    'RPC URL must be a reviewed public HTTPS origin without credentials or query string.');
  return value;
};

/** Pure offline draft. It never reads secrets, connects to RPC, changes a symlink or starts a service. */
export function prepareFreshCutover({record,bundle,activation,manifest,expectedGasWallet,
  runtimeReleaseId,productReleaseId,rpcUrl,logsRpcUrl,keeperStateRoot}) {
  const gasWallet=publicAddress(expectedGasWallet);
  check(same(gasWallet,FRESH_GAS_WALLET),
    'The fresh Gas wallet must match the reviewed deployment-console role.');
  check(same(record?.account,FRESH_DEPLOYER),
    'The fresh genesis deployer must match the reviewed deployment-console role.');
  check(same(activation?.deployer,FRESH_DEPLOYER),
    'The activation evidence deployer must match the reviewed deployment-console role.');
  check(same(activation?.authority?.administratorOne,FRESH_ADMIN_ONE)
    && same(activation?.authority?.administratorTwo,FRESH_ADMIN_TWO),
  'The activated administrators must match the reviewed deployment-console roles.');
  const reusesV2GasWallet=same(gasWallet,ORIGINAL_GAS_WALLET);
  const trusted=productGraphConfiguration({record,bundle,productActivation:activation,expectedGasWallet:gasWallet});
  const proof=trusted.freshAuthority, genesis=trusted.record, a=genesis.addresses;
  check(proof && a.FreshPoolFactory && same(a.PoolFactory,a.FreshPoolFactory),
    'A completed fresh integrated deployment and seven Authority actions are required.');
  check(!same(a.factory,a.portfolioFactory), 'Fresh Factories must be separate from each other.');
  check(same(genesis.account,genesis.input.ownerMultisig)
    && same(genesis.account,genesis.input.operator) && same(genesis.account,genesis.input.treasury),
  'Fresh Stage1 must use the hardware wallet for all initial privileged roles.');
  const initialize=genesis.steps.find(step=>step.id==='initialize');
  check(manifest?.schemaVersion===1 && manifest?.kind==='integrated-v2' && manifest.chainId===56
    && same(manifest.artifactDigest,genesis.artifactDigest)
    && same(manifest.deployment?.txHash,initialize.txHash)
    && manifest.deployment?.blockNumber===initialize.receipt.blockNumber
    && same(manifest.deployment?.blockHash,initialize.receipt.blockHash)
    && manifest.verifiedBlockNumber===proof.steps.at(-1).blockNumber
    && same(manifest.verifiedBlockHash,proof.steps.at(-1).blockHash),
  'The v4 static manifest must be from the same fresh genesis deployment.');
  for (const [manifestKey,recordKey] of Object.entries({factory:'factory',shareMarket:'shareMarket',lens:'lens',
    beacon:'beacon',timelock:'timelock',portfolioFactory:'portfolioFactory',portfolioMarket:'portfolioShareMarket',
    portfolioBeacon:'portfolioBeacon',portfolioImplementation:'BudgetPortfolioVault',
    portfolioFactoryImplementation:'BudgetPortfolioFactory'})) {
    check(same(manifest[manifestKey],a[recordKey])
      && same(manifest.codehash?.[manifestKey],genesis.verification.code[recordKey]?.codehash),
    `Manifest ${manifestKey} differs from the reviewed genesis.`);
  }
  const pinnedAuthority=manifest.freshAuthority;
  check(pinnedAuthority && same(manifest.authority,proof.authority.address)
    && same(manifest.gasWallet,gasWallet)
    && same(pinnedAuthority.address,proof.authority.address)
    && same(pinnedAuthority.gasWallet,gasWallet)
    && same(pinnedAuthority.administratorOne,proof.authority.administratorOne)
    && same(pinnedAuthority.administratorTwo,proof.authority.administratorTwo)
    && same(pinnedAuthority.deploymentTxHash,proof.authority.deploymentTxHash)
    && /^0x[\da-f]{64}$/i.test(pinnedAuthority.codehash),
  'The v4 static manifest must pin the exact activated Authority, administrators and Gas wallet.');
  const indexManifest=createFreshIndexManifest(manifest);
  const indexManifestSha256=freshIndexManifestSha256(indexManifest);
  runtimeReleaseId=release(runtimeReleaseId,'runtime');
  productReleaseId=release(productReleaseId,'product');
  check(keeperStateRoot==='/var/lib/pinkuang-v4-signer/keeper',
    'Fresh v4 signer and purchaser require the same dedicated private nonce state root.');
  const rpc=https(rpcUrl), logs=https(logsRpcUrl);
  const runtimeRoot=`/srv/pinkuang-deploy-v4/releases/${runtimeReleaseId}`;
  const signerRoot=`/srv/pinkuang-v4-signer/releases/${runtimeReleaseId}`;
  const productRoot=`/var/www/bemine-v4/releases/${productReleaseId}`;
  const recordPath='/var/lib/pinkuang-deploy-v4/trusted-product-deployment.json';
  const activationPath='/etc/pinkuang-deploy-v4/fresh-activation.json';
  const runtimeEnvironment={NODE_ENV:'production',HOST:'127.0.0.1',PORT:'4177',
    BEMINE_FRESH_CONSOLE_PRE_GENESIS:'1',BEMINE_FRESH_STAGE2_HOLD:'1',
    DEPLOYMENT_JOURNAL_ORIGIN:'https://tapeout.cc.cd',
    DEPLOYMENT_JOURNAL_DB:'/var/lib/pinkuang-deploy-v4/journal.sqlite',
    DEPLOYMENT_JOURNAL_RPC_URL:rpc,BEMINE_READ_RPC_URL:rpc,
    BEMINE_INDEX_URL:'http://127.0.0.1:4184',BEMINE_NOTIFICATIONS_ENABLED:'0',
    BEMINE_JOURNAL_FACTORIES:`${indexManifest.factory},${indexManifest.portfolioFactory}`,
    BEMINE_DEPLOYMENT_RECORD_PATH:recordPath,
    BEMINE_PRODUCT_GENESIS_ARTIFACT_PATH:`${runtimeRoot}/public/deployment-artifacts.json`,
    BEMINE_PRODUCT_ACTIVATION_PATH:activationPath,
    BEMINE_EXPECTED_GAS_WALLET:gasWallet,
    AUTHORITY_RELAY_ENABLED:'0',AUTHORITY_RELAY_PUBLIC_ENABLED:'0'};
  const indexEnvironment={NODE_ENV:'production',CHAIN_INDEX_HOST:'127.0.0.1',CHAIN_INDEX_PORT:'4184',
    CHAIN_INDEX_DB:'/var/lib/pinkuang-index-v4/index.sqlite',CHAIN_INDEX_CONFIRMATIONS:'12',
    CHAIN_INDEX_SCAN_RANGE:'100',CHAIN_INDEX_RPC_URL:rpc,CHAIN_INDEX_LOGS_RPC_URL:logs,
    CHAIN_INDEX_MODE:'fresh-v4',
    CHAIN_INDEX_FRESH_MANIFEST_PATH:`${runtimeRoot}/public/fresh-product-manifest.json`,
    CHAIN_INDEX_FRESH_MANIFEST_SHA256:indexManifestSha256};
  const envLines=env=>Object.entries(env).map(([key,value])=>`Environment=${key}=${value}\n`).join('');
  const runtimeUnit=`[Unit]\nDescription=BEMine v4 fresh deployment runtime\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=pinkuang-v4\nGroup=pinkuang-v4\nSupplementaryGroups=pinkuang-v4-relay\nWorkingDirectory=${runtimeRoot}\nExecStart=/usr/bin/node ${runtimeRoot}/server/index.mjs\nStateDirectory=pinkuang-deploy-v4 pinkuang-v4\nStateDirectoryMode=0700\n${envLines(runtimeEnvironment)}UMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\nReadWritePaths=/var/lib/pinkuang-deploy-v4 /var/lib/pinkuang-v4\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=45\n\n[Install]\nWantedBy=multi-user.target\n`;
  const indexUnit=`[Unit]\nDescription=BEMine v4 independent chain index\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=pinkuang-v4\nGroup=pinkuang-v4\nWorkingDirectory=${runtimeRoot}\nExecStart=/usr/bin/node ${runtimeRoot}/server/chain-index/server.mjs\nStateDirectory=pinkuang-index-v4\nStateDirectoryMode=0700\n${envLines(indexEnvironment)}UMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\nReadWritePaths=/var/lib/pinkuang-index-v4\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=45\n\n[Install]\nWantedBy=multi-user.target\n`;
  // This optional draft only permits proof of the private Gas public address.
  // Neither process exposes Authority transaction submission.
  const runtimeRelayDropIn=`[Service]\nLoadCredential=authority-ipc-hmac:/etc/pinkuang-v4/authority-ipc-hmac\nEnvironment=AUTHORITY_RELAY_SOCKET=/run/pinkuang-v4-relay/authority.sock\nEnvironment=AUTHORITY_RELAY_PUBLIC_ENABLED=0\n`;
  const signerEnvironment={NODE_ENV:'production',AUTHORITY_RELAY_ENABLED:'0',
    AUTHORITY_SIGNER_ATTEST_ONLY:'1',
    BEMINE_V2_GAS_SENDER_DRAINED:'0',
    AUTHORITY_RELAY_SOCKET:'/run/pinkuang-v4-relay/authority.sock',
    DEPLOYMENT_JOURNAL_ORIGIN:'https://tapeout.cc.cd',DEPLOYMENT_JOURNAL_RPC_URL:rpc,
    DEPLOYMENT_JOURNAL_DB:'/var/lib/pinkuang-deploy-v4/journal.sqlite',
    BEMINE_EXPECTED_GAS_WALLET:gasWallet,
    BEMINE_DEPLOYMENT_RECORD_PATH:'/var/lib/pinkuang-v4-signer/trusted-product-deployment.json',
    BEMINE_PRODUCT_GENESIS_ARTIFACT_PATH:runtimeEnvironment.BEMINE_PRODUCT_GENESIS_ARTIFACT_PATH,
    BEMINE_PRODUCT_ACTIVATION_PATH:'/var/lib/pinkuang-v4-signer/fresh-activation.json',
    AUTHORITY_RELAY_JOURNAL:'/var/lib/pinkuang-v4-signer/authority/authority.json',
    PINKUANG_KEEPER_STATE_ROOT:keeperStateRoot};
  const gasCredentialSource=reusesV2GasWallet?'/etc/pinkuang/keeper.key':'/etc/pinkuang-v4/authority-gas.key';
  const signerUnit=`[Unit]\nDescription=BEMine v4 independent Gas address attestor (relay disabled draft)\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=10min\nStartLimitBurst=3\n\n[Service]\nType=simple\nUser=pinkuang-v4-signer\nGroup=pinkuang-v4-relay\nWorkingDirectory=${signerRoot}\nExecStart=/usr/bin/node ${signerRoot}/server/authority-signer.mjs\nLoadCredential=authority-ipc-hmac:/etc/pinkuang-v4/authority-ipc-hmac\nLoadCredential=keeper-private-key:${gasCredentialSource}\nRuntimeDirectory=pinkuang-v4-relay\nRuntimeDirectoryMode=0750\nStateDirectory=pinkuang-v4-signer\nStateDirectoryMode=0700\n${envLines(signerEnvironment)}UMask=0007\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\nReadWritePaths=/var/lib/pinkuang-v4-signer /run/pinkuang-v4-relay\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=45\n`;
  const purchaseEnvironment={FRESH_PURCHASE_ENABLED:'0',BEMINE_V2_GAS_SENDER_DRAINED:'0',
    PINKUANG_KEEPER_STATE_ROOT:keeperStateRoot,
    AUTHORITY_RELAY_JOURNAL:signerEnvironment.AUTHORITY_RELAY_JOURNAL,
    BEMINE_EXPECTED_GAS_WALLET:gasWallet,
    BEMINE_DEPLOYMENT_RECORD_PATH:signerEnvironment.BEMINE_DEPLOYMENT_RECORD_PATH,
    BEMINE_PRODUCT_GENESIS_ARTIFACT_PATH:runtimeEnvironment.BEMINE_PRODUCT_GENESIS_ARTIFACT_PATH,
    BEMINE_PRODUCT_ACTIVATION_PATH:signerEnvironment.BEMINE_PRODUCT_ACTIVATION_PATH};
  const purchaseJournal='/var/lib/pinkuang-v4-signer/purchase-journal';
  const purchaseUnit=`[Unit]\nDescription=BEMine v4 automatic purchase (disabled draft)\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=10min\nStartLimitBurst=3\n\n[Service]\nType=simple\nUser=pinkuang-v4-signer\nGroup=pinkuang-v4-relay\nWorkingDirectory=${runtimeRoot}\nExecStart=/usr/bin/node ${runtimeRoot}/scripts/purchase-supervisor.mjs --factory ${a.factory} --rpc ${rpc} --journal-dir ${purchaseJournal} --fresh-graph --send\nLoadCredential=keeper-private-key:${gasCredentialSource}\nStateDirectory=pinkuang-v4-signer\nStateDirectoryMode=0700\n${envLines(purchaseEnvironment)}UMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\nReadWritePaths=/var/lib/pinkuang-v4-signer\nRestart=on-failure\nRestartPreventExitStatus=2\nRestartSec=5\nTimeoutStopSec=45\n`;
  const nginxSnippet=`# Review and include only after live v4 graph and relay checks pass.\nlocation = /pinkuang-deploy-v4 { return 308 /pinkuang-deploy-v4/; }\nlocation ^~ /pinkuang-deploy-v4/ {\n    auth_basic "BEMine deployment";\n    auth_basic_user_file /etc/nginx/pinkuang-deploy-v4.htpasswd;\n    proxy_set_header Authorization "";\n    proxy_pass http://127.0.0.1:4177/;\n    proxy_set_header Host $host;\n    proxy_set_header Origin $http_origin;\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-For \"\";\n    proxy_set_header X-Forwarded-Host \"\";\n    proxy_set_header X-Forwarded-Proto \"\";\n    proxy_cookie_path /api/journal /pinkuang-deploy-v4/api/journal;\n    proxy_connect_timeout 5s;\n    proxy_read_timeout 90s;\n}\nlocation = /bemine-v4 { return 308 /bemine-v4/; }\nlocation ^~ /bemine-v4/api/journal/deployment { return 404; }\nlocation ^~ /bemine-v4/api/journal/fresh-activation { return 404; }\nlocation ^~ /bemine-v4/api/ {\n    proxy_pass http://127.0.0.1:4177/api/;\n    proxy_set_header Host $host;\n    proxy_set_header Origin $http_origin;\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-For \"\";\n    proxy_set_header X-Forwarded-Host \"\";\n    proxy_set_header X-Forwarded-Proto \"\";\n    proxy_cookie_path /api/journal /bemine-v4/api/journal;\n    proxy_connect_timeout 5s;\n    proxy_read_timeout 90s;\n}\nlocation ^~ /bemine-v4/firsto-api/ {\n    proxy_pass http://127.0.0.1:4177/firsto-api/;\n    proxy_set_header Cookie \"\";\n    proxy_set_header Authorization \"\";\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-For \"\";\n    proxy_hide_header Set-Cookie;\n    proxy_connect_timeout 5s;\n    proxy_read_timeout 30s;\n}\nlocation ^~ /bemine-v4/ {\n    alias /var/www/bemine-v4/current/public/;\n    index index.html;\n    try_files $uri $uri.html $uri/ =404;\n}\n`;
  return Object.freeze({schemaVersion:1,kind:'fresh-v4-cutover-draft',chainId:56,
    activationAllowed:false,
    missingLiveProofs:['7 finalized Authority actions and exact on-chain roles',
      'independent Factory runtime and own-registry behavior verified',
      'v4 index caught up to finalized chain',
      'Authority admin UI and Gas relay end-to-end verified',
      'if the v2 Gas wallet is reused, drain and disable every v2 sender and verify no pending nonce before enabling v4 senders',
      'separate reviewed fresh-active product release and transaction gate',
      'old site and its existing assets remain independently accessible'],
    oldSite:'/bemine-v2/',newSite:'/bemine-v4/',deploymentConsole:'/pinkuang-deploy-v4/',
    runtimeRoot,signerRoot,productRoot,recordPath,activationPath,
    genesisArtifactDigest:genesis.artifactDigest,activationTxHash:proof.steps.at(-1).txHash,
    indexManifest,indexManifestSha256,
    runtimeEnvironment,indexEnvironment,purchaseEnvironment,signerEnvironment,
    runtimeUnit,runtimeRelayDropIn,indexUnit,signerUnit,purchaseUnit,nginxSnippet});
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [configPath,outputPath]=process.argv.slice(2);
  check(configPath && outputPath, 'Usage: node prepare-fresh-cutover.mjs input.json output.json');
  const input=JSON.parse(readFileSync(configPath,'utf8'));
  const data={...input};
  for (const key of ['record','bundle','activation','manifest']) {
    check(typeof input[`${key}Path`]==='string',`Missing ${key}Path.`);
    data[key]=JSON.parse(readFileSync(input[`${key}Path`],'utf8'));
  }
  // Output is a draft with activationAllowed=false. Installing or enabling
  // services remains a separate audited step after current chain proofs.
  writeFileSync(outputPath,`${JSON.stringify(prepareFreshCutover(data),null,2)}\n`,{flag:'wx',mode:0o600});
}
