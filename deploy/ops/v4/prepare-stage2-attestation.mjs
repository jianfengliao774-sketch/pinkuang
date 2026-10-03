import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getAddress } from 'ethers';
import { ORIGINAL_GAS_WALLET } from '../../shared/original-gas-wallet.mjs';

const RELEASE = /^v4-[a-z0-9][a-z0-9-]{1,70}$/;

/** Offline unit drafts for proving the existing Gas key. Neither unit can submit a transaction. */
export function prepareStage2Attestation({ signerReleaseId, expectedGasWallet }) {
  if (!RELEASE.test(signerReleaseId ?? '')) throw new Error('A reviewed v4 signer release id is required.');
  if (getAddress(expectedGasWallet) !== ORIGINAL_GAS_WALLET)
    throw new Error('The Stage 2 proof must use the reviewed original Gas public address.');
  const signerRoot=`/srv/pinkuang-v4-signer/releases/${signerReleaseId}`;
  const signerEnvironment={NODE_ENV:'production',AUTHORITY_RELAY_ENABLED:'0',
    AUTHORITY_SIGNER_ATTEST_ONLY:'1',
    AUTHORITY_RELAY_SOCKET:'/run/pinkuang-v4-relay/authority.sock',
    DEPLOYMENT_JOURNAL_ORIGIN:'https://tapeout.cc.cd',
    BEMINE_EXPECTED_GAS_WALLET:ORIGINAL_GAS_WALLET};
  const lines=env=>Object.entries(env).map(([key,value])=>`Environment=${key}=${value}\n`).join('');
  const signerUnit=`[Unit]\nDescription=BEMine v4 Stage 2 Gas public-address attestation only\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=10min\nStartLimitBurst=3\n\n[Service]\nType=simple\nUser=pinkuang-v4-signer\nGroup=pinkuang-v4-relay\nWorkingDirectory=${signerRoot}\nExecStart=/usr/bin/node ${signerRoot}/server/authority-signer.mjs\nLoadCredential=authority-ipc-hmac:/etc/pinkuang-v4/authority-ipc-hmac\nLoadCredential=keeper-private-key:/etc/pinkuang/keeper.key\nRuntimeDirectory=pinkuang-v4-relay\nRuntimeDirectoryMode=0750\n${lines(signerEnvironment)}UMask=0007\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\nReadWritePaths=/run/pinkuang-v4-relay\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=45\n`;
  const publicDropIn=`[Service]\nSupplementaryGroups=pinkuang-v4-relay\nLoadCredential=authority-ipc-hmac:/etc/pinkuang-v4/authority-ipc-hmac\nEnvironment=AUTHORITY_RELAY_SOCKET=/run/pinkuang-v4-relay/authority.sock\nEnvironment=AUTHORITY_RELAY_PUBLIC_ENABLED=0\nEnvironment=AUTHORITY_RELAY_ENABLED=0\nEnvironment=BEMINE_EXPECTED_GAS_WALLET=${ORIGINAL_GAS_WALLET}\nEnvironment=BEMINE_FRESH_STAGE2_HOLD=1\n`;
  return Object.freeze({schemaVersion:1,kind:'fresh-v4-stage2-attestation-draft',chainId:56,
    activationAllowed:false,signerRoot,signerEnvironment,signerUnit,publicDropIn,
    requiredSignerEntrypoint:'server/authority-signer.mjs',
    signerReleaseRequiresIndependentPackage:true});
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [configPath,outputPath]=process.argv.slice(2);
  if (!configPath || !outputPath)
    throw new Error('Usage: node prepare-stage2-attestation.mjs input.json output.json');
  const data=JSON.parse(readFileSync(configPath,'utf8'));
  writeFileSync(outputPath,`${JSON.stringify(prepareStage2Attestation(data),null,2)}\n`,
    {flag:'wx',mode:0o600});
}
