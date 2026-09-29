import { getAddress, Interface, keccak256, type JsonRpcProvider } from 'ethers';
import type { DeploymentManifest } from './manifest';

export const pauseFactoryNames = ['factory', 'portfolioFactory'] as const;
export type PauseFactoryName = typeof pauseFactoryNames[number];
export type PauseTargetProof = {
  blockNumber: number;
  blockHash: string;
  targets: Record<PauseFactoryName, {address: string; owner: string; paused: boolean}>;
};

const factory = new Interface([
  'function owner() view returns(address)',
  'function timelock() view returns(address)',
  'function creationPaused() view returns(bool)',
  'function pauseCreation(bool paused)',
]);

export function pauseCreationData(): string {
  return factory.encodeFunctionData('pauseCreation',[true]);
}

/** Pin both old factory proxies before asking the current owner to pause new creations. */
export async function inspectPauseTargets(
  provider: JsonRpcProvider,
  trusted: DeploymentManifest,
  expectedOwner: string,
): Promise<PauseTargetProof> {
  const [chain,block] = await Promise.all([provider.send('eth_chainId',[]),provider.getBlock('finalized')]);
  if (BigInt(chain) !== 56n || !block?.hash || !Number.isSafeInteger(block.number)) {
    throw new Error('暂停建池前必须读取 BSC 主网最终确认区块。');
  }
  const tag = `0x${block.number.toString(16)}`;
  const targets = {} as PauseTargetProof['targets'];
  for (const name of pauseFactoryNames) {
    const address = getAddress(trusted[name] || '');
    const [code,ownerData,timelockData,pausedData] = await Promise.all([
      provider.getCode(address,block.number),
      provider.send('eth_call',[{to:address,data:factory.encodeFunctionData('owner')},tag]),
      provider.send('eth_call',[{to:address,data:factory.encodeFunctionData('timelock')},tag]),
      provider.send('eth_call',[{to:address,data:factory.encodeFunctionData('creationPaused')},tag]),
    ]);
    if (code === '0x' || keccak256(code).toLowerCase() !== trusted.codehash[name]?.toLowerCase()) {
      throw new Error(`${name} 运行代码与已发布清单不一致，不能发暂停交易。`);
    }
    const owner = getAddress(factory.decodeFunctionResult('owner',ownerData)[0]);
    const timelock = getAddress(factory.decodeFunctionResult('timelock',timelockData)[0]);
    if (owner !== getAddress(expectedOwner) || timelock !== getAddress(trusted.timelock)) {
      throw new Error(`${name} 当前 owner 或 Timelock 与旧部署记录不一致。`);
    }
    targets[name] = {address,owner,paused:factory.decodeFunctionResult('creationPaused',pausedData)[0] === true};
  }
  const [again,againChain] = await Promise.all([provider.getBlock(block.number),provider.send('eth_chainId',[])]);
  if (again?.hash?.toLowerCase() !== block.hash.toLowerCase() || BigInt(againChain) !== 56n) {
    throw new Error('暂停建池核验期间最终确认区块发生变化，请重试。');
  }
  return {blockNumber:block.number,blockHash:block.hash,targets};
}
