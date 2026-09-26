import { getAddress, ZeroAddress } from 'ethers';
import { artifactDigest, type ArtifactBundle, type DeploymentSnapshot } from './deployment';

const REQUIRED_ADDRESSES = ['factory', 'shareMarket', 'lens', 'beacon', 'timelock'] as const;
const REQUIRED_CHECKS = ['Factory.lens', 'Lens.factory', 'Market.factory', 'Market.timelock', 'Beacon.owner'];
const HASH = /^0x[0-9a-fA-F]{64}$/;

export interface DeploymentManifest {
  schemaVersion: 1;
  chainId: 56;
  factory: string;
  shareMarket: string;
  lens: string;
  beacon: string;
  timelock: string;
  deployment: { txHash: string; blockNumber: number; blockHash: string };
  artifactDigest: string;
  sourceCommit: string;
  verifiedAt: string;
  verifiedBlockNumber: number;
  codehash: Record<(typeof REQUIRED_ADDRESSES)[number], string>;
}

/** A compact, public handoff for a frontend/indexer. The consumer must still verify it on chain. */
export function deploymentManifest(snapshot: DeploymentSnapshot, bundle: ArtifactBundle): DeploymentManifest {
  if (snapshot.chainId !== 56 || snapshot.status !== 'complete' || !snapshot.verification) throw new Error('只有完成链上核验的 BSC 部署可以导出合约清单。');
  if (snapshot.artifactDigest !== artifactDigest(bundle) || snapshot.sourceCommit !== bundle.sourceCommit) throw new Error('部署记录与当前源码构建不一致。');
  if (!snapshot.steps.length || snapshot.steps.some(step => step.status !== 'confirmed')) throw new Error('部署仍有未确认的交易。');
  const initialize = snapshot.steps.find(step => step.id === 'initialize');
  if (!initialize?.txHash || !HASH.test(initialize.txHash) || !initialize.receipt || initialize.receipt.status !== 1 || !HASH.test(initialize.receipt.blockHash)) throw new Error('缺少已成功上链的原子初始化回执。');
  if (!Number.isSafeInteger(initialize.receipt.blockNumber) || initialize.receipt.blockNumber < 0 || !Number.isSafeInteger(snapshot.verification.blockNumber) || snapshot.verification.blockNumber < initialize.receipt.blockNumber) throw new Error('部署和核验区块不一致。');
  if (!snapshot.verification.checks.length || snapshot.verification.checks.some(check => !check.passed) || REQUIRED_CHECKS.some(label => !snapshot.verification!.checks.some(check => check.label === label && check.passed))) throw new Error('部署图尚未通过完整核验。');
  const addresses = {} as Record<(typeof REQUIRED_ADDRESSES)[number], string>;
  const codehash = {} as Record<(typeof REQUIRED_ADDRESSES)[number], string>;
  for (const name of REQUIRED_ADDRESSES) {
    const address = getAddress(snapshot.addresses[name]);
    const code = snapshot.verification.code[name];
    if (address === ZeroAddress || !code || getAddress(code.address) !== address || !HASH.test(code.codehash) || code.codeBytes <= 0 || !snapshot.verification.checks.some(check => check.label === `${name} 运行代码匹配` && check.passed)) throw new Error(`${name} 地址或运行代码未核验。`);
    addresses[name] = address;
    codehash[name] = code.codehash;
  }
  return {
    schemaVersion: 1, chainId: 56, ...addresses,
    deployment: { txHash: initialize.txHash, blockNumber: initialize.receipt.blockNumber, blockHash: initialize.receipt.blockHash },
    artifactDigest: snapshot.artifactDigest, sourceCommit: snapshot.sourceCommit,
    verifiedAt: snapshot.verification.checkedAt, verifiedBlockNumber: snapshot.verification.blockNumber, codehash,
  };
}
