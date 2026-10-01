import { getAddress, ZeroAddress } from 'ethers';
import type { FreshActivationProfile } from './fresh-activation';

export interface FullTestConsoleConfig { schemaVersion: 1; profile: 'full-test'; chainId: 56;
  artifactDigest: string; roles: { deployer: string; administratorOne: string; administratorTwo: string; gasWallet: string };
  timings: { holdSeconds: number; proposalCooldownSeconds: number; voteSeconds: number;
    listingSeconds: number; upgradeDelaySeconds?: number }; }

/** A public test profile cannot silently substitute production roles or a different bundle. */
export function validateFullTestConsoleConfig(value: FullTestConsoleConfig, digest: string): FullTestConsoleConfig {
  if (value?.schemaVersion !== 1 || value.profile !== 'full-test' || value.chainId !== 56
    || value.artifactDigest?.toLowerCase() !== digest.toLowerCase()
    || value.timings?.holdSeconds !== 0 || value.timings?.proposalCooldownSeconds !== 0
    || value.timings?.voteSeconds !== 86400 || value.timings?.listingSeconds !== 604800
    || value.timings.upgradeDelaySeconds !== 0) throw new Error('完整测试部署配置与本次编译产物不一致。');
  const roles = Object.fromEntries(['deployer', 'administratorOne', 'administratorTwo', 'gasWallet']
    .map(name => [name, getAddress(value.roles?.[name as keyof typeof value.roles] ?? '')])) as FullTestConsoleConfig['roles'];
  if (Object.values(roles).some(address => address === ZeroAddress)
    || new Set([roles.administratorOne, roles.administratorTwo, roles.gasWallet]).size !== 3
    || roles.deployer === roles.gasWallet)
    throw new Error('测试部署、管理员与 Gas 钱包公开地址无效。');
  return { ...value, roles };
}

export function fullTestActivationProfile(value: FullTestConsoleConfig): FreshActivationProfile {
  return { fullTest: true, administratorOne: value.roles.administratorOne,
    administratorTwo: value.roles.administratorTwo, gasWallet: value.roles.gasWallet, minTimelockDelaySeconds: 0 };
}
