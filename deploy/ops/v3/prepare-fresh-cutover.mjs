import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getAddress } from 'ethers';
import { productGraphConfiguration } from '../../server/product-graph.mjs';

const OLD_V2_FACTORY = '0x2995B10d19056c8C24C57b281C22562a603C571F';
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const check = (ok,message) => { if (!ok) throw new Error(message); };
const publicAddress = value => {
  check(typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value), 'A complete 40-hex public address is required.');
  return getAddress(value);
};
const release = (value,prefix) => {
  check(typeof value === 'string' && /^v3-[a-z0-9][a-z0-9-]{1,70}$/.test(value),
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
  const trusted=productGraphConfiguration({record,bundle,productActivation:activation,expectedGasWallet:gasWallet});
  const proof=trusted.freshAuthority, genesis=trusted.record, a=genesis.addresses;
  check(proof && a.FreshPoolFactory && same(a.PoolFactory,a.FreshPoolFactory),
    'A completed fresh integrated deployment and seven Authority actions are required.');
  check(!same(a.factory,OLD_V2_FACTORY) && !same(a.portfolioFactory,OLD_V2_FACTORY)
    && !same(a.factory,a.portfolioFactory), 'Fresh Factories must be separate from each other and the old v2 graph.');
  check(same(genesis.account,genesis.input.ownerMultisig)
    && same(genesis.account,genesis.input.operator) && same(genesis.account,genesis.input.treasury),
  'Fresh Stage1 must use the hardware wallet for all initial privileged roles.');
  const initialize=genesis.steps.find(step=>step.id==='initialize');
  check(manifest?.schemaVersion===1 && manifest?.kind==='integrated-v2' && manifest.chainId===56
    && same(manifest.artifactDigest,genesis.artifactDigest)
    && same(manifest.deployment?.txHash,initialize.txHash)
    && manifest.deployment?.blockNumber===initialize.receipt.blockNumber
    && same(manifest.deployment?.blockHash,initialize.receipt.blockHash)
    && manifest.verifiedBlockNumber>=initialize.receipt.blockNumber,
  'The v3 static manifest must be from the same fresh genesis deployment.');
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
  'The v3 static manifest must pin the exact activated Authority, administrators and Gas wallet.');
  runtimeReleaseId=release(runtimeReleaseId,'runtime');
  productReleaseId=release(productReleaseId,'product');
  check(typeof keeperStateRoot==='string' && /^\/var\/lib\/[a-z0-9][a-z0-9/-]*$/i.test(keeperStateRoot)
    && !keeperStateRoot.includes('//') && !keeperStateRoot.endsWith('/'),
  'Explicit shared /var/lib keeper state root is required for Gas-wallet nonce coordination.');
  const rpc=https(rpcUrl), logs=https(logsRpcUrl);
  const runtimeRoot=`/srv/pinkuang-deploy-v3/releases/${runtimeReleaseId}`;
  const productRoot=`/var/www/bemine-v3/releases/${productReleaseId}`;
  const recordPath='/var/lib/pinkuang-deploy-v3/trusted-product-deployment.json';
  const activationPath='/etc/pinkuang-deploy-v3/fresh-activation.json';
  const runtimeEnvironment={NODE_ENV:'production',HOST:'127.0.0.1',PORT:'4175',
    DEPLOYMENT_JOURNAL_ORIGIN:'https://tapeout.cc.cd',
    DEPLOYMENT_JOURNAL_DB:'/var/lib/pinkuang-deploy-v3/journal.sqlite',
    DEPLOYMENT_JOURNAL_RPC_URL:rpc,BEMINE_READ_RPC_URL:rpc,
    BEMINE_INDEX_URL:'http://127.0.0.1:4182',BEMINE_NOTIFICATIONS_ENABLED:'0',
    BEMINE_JOURNAL_FACTORIES:`${a.factory},${a.portfolioFactory}`,
    BEMINE_DEPLOYMENT_RECORD_PATH:recordPath,
    BEMINE_PRODUCT_GENESIS_ARTIFACT_PATH:`${runtimeRoot}/public/deployment-artifacts.json`,
    BEMINE_PRODUCT_ACTIVATION_PATH:activationPath,
    BEMINE_EXPECTED_GAS_WALLET:gasWallet,
    BEMINE_LEGACY_FACTORY:OLD_V2_FACTORY,
    AUTHORITY_RELAY_ENABLED:'0',
    AUTHORITY_RELAY_JOURNAL:'/var/lib/pinkuang-v3/authority/authority.json',
    PINKUANG_KEEPER_STATE_ROOT:keeperStateRoot};
  const indexEnvironment={NODE_ENV:'production',CHAIN_INDEX_HOST:'127.0.0.1',CHAIN_INDEX_PORT:'4182',
    CHAIN_INDEX_DB:'/var/lib/pinkuang-index-v3/index.sqlite',CHAIN_INDEX_CONFIRMATIONS:'12',
    CHAIN_INDEX_SCAN_RANGE:'100',CHAIN_INDEX_RPC_URL:rpc,CHAIN_INDEX_LOGS_RPC_URL:logs,
    CHAIN_INDEX_FACTORY:a.factory,CHAIN_INDEX_MARKET:a.shareMarket,
    CHAIN_INDEX_PORTFOLIO_FACTORY:a.portfolioFactory,CHAIN_INDEX_PORTFOLIO_MARKET:a.portfolioShareMarket,
    CHAIN_INDEX_START_BLOCK:String(initialize.receipt.blockNumber)};
  const envLines=env=>Object.entries(env).map(([key,value])=>`Environment=${key}=${value}\n`).join('');
  const runtimeUnit=`[Unit]\nDescription=BEMine v3 fresh deployment runtime\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=pinkuang-v3\nGroup=pinkuang-v3\nWorkingDirectory=${runtimeRoot}\nExecStart=/usr/bin/node ${runtimeRoot}/server/index.mjs\nStateDirectory=pinkuang-deploy-v3 pinkuang-v3\nStateDirectoryMode=0700\n${envLines(runtimeEnvironment)}UMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\nReadWritePaths=/var/lib/pinkuang-deploy-v3 /var/lib/pinkuang-v3 ${keeperStateRoot}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=45\n\n[Install]\nWantedBy=multi-user.target\n`;
  const indexUnit=`[Unit]\nDescription=BEMine v3 independent chain index\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=pinkuang-v3\nGroup=pinkuang-v3\nWorkingDirectory=${runtimeRoot}\nExecStart=/usr/bin/node ${runtimeRoot}/server/chain-index/server.mjs\nStateDirectory=pinkuang-index-v3\nStateDirectoryMode=0700\n${envLines(indexEnvironment)}UMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\nReadWritePaths=/var/lib/pinkuang-index-v3\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=45\n\n[Install]\nWantedBy=multi-user.target\n`;
  const purchaseEnvironment={FRESH_PURCHASE_ENABLED:'0',
    PINKUANG_KEEPER_STATE_ROOT:keeperStateRoot,
    AUTHORITY_RELAY_JOURNAL:runtimeEnvironment.AUTHORITY_RELAY_JOURNAL,
    BEMINE_EXPECTED_GAS_WALLET:gasWallet,
    BEMINE_DEPLOYMENT_RECORD_PATH:recordPath,
    BEMINE_PRODUCT_GENESIS_ARTIFACT_PATH:runtimeEnvironment.BEMINE_PRODUCT_GENESIS_ARTIFACT_PATH,
    BEMINE_PRODUCT_ACTIVATION_PATH:activationPath};
  const purchaseJournal='/var/lib/pinkuang-v3/purchase-journal';
  const purchaseUnit=`[Unit]\nDescription=BEMine v3 automatic purchase (disabled draft)\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=pinkuang-v3\nGroup=pinkuang-v3\nWorkingDirectory=${runtimeRoot}\nExecStart=/usr/bin/node ${runtimeRoot}/scripts/purchase-supervisor.mjs --factory ${a.factory} --rpc ${rpc} --journal-dir ${purchaseJournal} --fresh-graph\nStateDirectory=pinkuang-v3\nStateDirectoryMode=0700\n${envLines(purchaseEnvironment)}UMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\nReadWritePaths=/var/lib/pinkuang-v3 ${keeperStateRoot}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=45\n\n[Install]\nWantedBy=multi-user.target\n`;
  const nginxSnippet=`# Review and include only after live v3 graph, relay and old-pool checks pass.\nlocation = /pinkuang-deploy-v3 { return 308 /pinkuang-deploy-v3/; }\nlocation ^~ /pinkuang-deploy-v3/ {\n    proxy_pass http://127.0.0.1:4175/;\n    proxy_set_header Host $host;\n    proxy_set_header Origin $http_origin;\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-For \"\";\n    proxy_set_header X-Forwarded-Host \"\";\n    proxy_set_header X-Forwarded-Proto \"\";\n    proxy_cookie_path /api/journal /pinkuang-deploy-v3/api/journal;\n    proxy_connect_timeout 5s;\n    proxy_read_timeout 30s;\n}\nlocation = /bemine-v3 { return 308 /bemine-v3/; }\nlocation ^~ /bemine-v3/api/ {\n    proxy_pass http://127.0.0.1:4175/api/;\n    proxy_set_header Host $host;\n    proxy_set_header Origin $http_origin;\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-For \"\";\n    proxy_set_header X-Forwarded-Host \"\";\n    proxy_set_header X-Forwarded-Proto \"\";\n    proxy_cookie_path /api/journal /bemine-v3/api/journal;\n    proxy_connect_timeout 5s;\n    proxy_read_timeout 30s;\n}\nlocation ^~ /bemine-v3/firsto-api/ {\n    proxy_pass http://127.0.0.1:4175/firsto-api/;\n    proxy_set_header Cookie \"\";\n    proxy_set_header Authorization \"\";\n    proxy_hide_header Set-Cookie;\n    proxy_connect_timeout 5s;\n    proxy_read_timeout 30s;\n}\nlocation ^~ /bemine-v3/ {\n    root /var/www/bemine-v3/current/public;\n    index index.html;\n    try_files $uri $uri.html $uri/ =404;\n}\n`;
  return Object.freeze({schemaVersion:1,kind:'fresh-v3-cutover-draft',chainId:56,
    activationAllowed:false,
    missingLiveProofs:['7 finalized Authority actions and exact on-chain roles',
      'both previous Factories pinned and creationPaused',
      'v3 index caught up to finalized chain',
      'Authority admin UI and Gas relay end-to-end verified',
      'v2 Gas keeper drained or safely sharing one wallet lock account',
      'separate reviewed fresh-active product release and transaction gate',
      'v2 pool, claims and listing visible at old URL'],
    oldSite:'/bemine-v2/',newSite:'/bemine-v3/',deploymentConsole:'/pinkuang-deploy-v3/',
    runtimeRoot,productRoot,recordPath,activationPath,
    genesisArtifactDigest:genesis.artifactDigest,activationTxHash:proof.steps.at(-1).txHash,
    runtimeEnvironment,indexEnvironment,purchaseEnvironment,
    runtimeUnit,indexUnit,purchaseUnit,nginxSnippet});
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
