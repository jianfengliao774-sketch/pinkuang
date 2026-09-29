import { getAddress } from 'ethers';
import { artifactDigest, type ArtifactBundle, type DeploymentSnapshot } from './deployment';
import { deploymentManifest, type DeploymentManifest } from './manifest';

type TrustedManifest = DeploymentManifest;

const ANCHOR_ADDRESSES = [
  'factory', 'shareMarket', 'lens', 'beacon', 'timelock',
  'portfolioFactory', 'portfolioMarket', 'portfolioBeacon',
  'portfolioImplementation', 'portfolioFactoryImplementation',
] as const;

/** The public product release is a build-time trust anchor, never a file upload. */
export function assertTrustedGenesis(
  record: DeploymentSnapshot,
  genesisBundle: ArtifactBundle,
  trusted: TrustedManifest,
): DeploymentManifest {
  if (record.kind !== 'integrated-v2' || trusted.kind !== 'integrated-v2') {
    throw new Error('只能升级已核验的单机与多机集成部署。');
  }
  if (record.status !== 'complete' || record.chainId !== 56 || trusted.chainId !== 56) {
    throw new Error('旧部署尚未完成 BSC 主网核验。');
  }
  if (artifactDigest(genesisBundle).toLowerCase() !== trusted.artifactDigest.toLowerCase()) {
    throw new Error('旧合约产物与已发布的正式合约清单不一致。');
  }
  const actual = deploymentManifest(record, genesisBundle);
  if (actual.artifactDigest.toLowerCase() !== trusted.artifactDigest.toLowerCase()
      || actual.sourceCommit.toLowerCase() !== trusted.sourceCommit.toLowerCase()
      || actual.deployment.txHash.toLowerCase() !== trusted.deployment.txHash.toLowerCase()
      || actual.deployment.blockNumber !== trusted.deployment.blockNumber
      || actual.deployment.blockHash.toLowerCase() !== trusted.deployment.blockHash.toLowerCase()) {
    throw new Error('旧部署记录与已发布的部署交易或源码版本不一致。');
  }
  for (const key of ANCHOR_ADDRESSES) {
    const address = actual[key];
    const expected = trusted[key];
    const codehash = actual.codehash[key];
    const expectedCodehash = trusted.codehash[key];
    if (!address || !expected || getAddress(address) !== getAddress(expected)
        || !codehash || !expectedCodehash || codehash.toLowerCase() !== expectedCodehash.toLowerCase()) {
      throw new Error(`${key} 与已发布的旧合约地址或运行代码不一致。`);
    }
  }
  return actual;
}

export function deploymentPlanReady(options: {
  trustedGenesis: boolean;
  trustedUpgradeBundle: boolean;
  chainVerified: boolean;
  walletOnBsc: boolean;
  proposer: boolean;
  unknownTransaction: boolean;
  operationDone: boolean;
}): boolean {
  return options.trustedGenesis && options.trustedUpgradeBundle && options.chainVerified
    && options.walletOnBsc && options.proposer && !options.unknownTransaction && !options.operationDone;
}
