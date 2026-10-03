import { Contract, Interface, type Provider } from 'ethers';

export const LEGACY_FACTORY = '0xcB24E7F96D81037086A268d6ea63c53f91D412A2';
const ABI = ['function owner() view returns(address)', 'function poolCount() view returns(uint256)',
  'function creationPaused() view returns(bool)', 'function pauseCreation(bool)'];
const iface = new Interface(ABI);

export type LegacyCutoverStatus = { owner: string; poolCount: bigint; creationPaused: boolean; block: number };

export async function readLegacyCutover(provider: Provider): Promise<LegacyCutoverStatus> {
  const block = await provider.getBlockNumber();
  const factory = new Contract(LEGACY_FACTORY, ABI, provider);
  const [owner, poolCount, creationPaused] = await Promise.all([
    factory.owner({ blockTag: block }), factory.poolCount({ blockTag: block }), factory.creationPaused({ blockTag: block }),
  ]);
  return { owner, poolCount, creationPaused, block };
}

export function assertLegacyCutoverReady(status: LegacyCutoverStatus, account: string): void {
  if (status.owner.toLowerCase() !== account.toLowerCase()) throw new Error('当前钱包不是旧 Factory 的 owner。请切换到旧版部署钱包。');
  if (status.poolCount !== 0n) throw new Error('旧 Factory 已经出现矿池，不能按零历史方案停建切换。');
  if (status.creationPaused) throw new Error('旧 Factory 已暂停建池，无需重复发送交易。');
}

export function legacyPauseData(): string { return iface.encodeFunctionData('pauseCreation', [true]); }
