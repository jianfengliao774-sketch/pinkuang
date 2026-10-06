import { getAddress, ZeroAddress } from 'ethers';

export const authorityAdministrators = [
  getAddress('0x7674fa446D42b1f7f150DC5e678cc525d275Ea53'),
  getAddress('0xed2fcbe59ebe1754a3676aeb9ccfba20f193fcbb'),
] as const;

export type StageTwoAddresses = {
  hardwareWallet: string;
  gasWallet: string;
  administratorOne: string;
  administratorTwo: string;
};

/** These are public configuration candidates, never proof of on-chain authority. */
export function stageTwoAddresses(
  hardwareInput: string,
  gasInput: string,
  existing: {timelock: string; factory: string; portfolioFactory: string; oldOwner: string},
): StageTwoAddresses {
  if (!hardwareInput.trim() || !gasInput.trim()) {
    throw new Error('请填写硬件钱包和 Gas 钱包的公开地址；不要在网页输入私钥。');
  }
  const hardwareWallet = getAddress(hardwareInput.trim());
  const gasWallet = getAddress(gasInput.trim());
  const forbidden = [ZeroAddress, existing.timelock, existing.factory, existing.portfolioFactory,
    ...authorityAdministrators].map(address => getAddress(address).toLowerCase());
  if (forbidden.includes(hardwareWallet.toLowerCase())
      || hardwareWallet.toLowerCase() === getAddress(existing.oldOwner).toLowerCase()) {
    throw new Error('硬件钱包须与旧 owner、两位管理员和部署合约地址不同。');
  }
  if ([...forbidden, hardwareWallet.toLowerCase(), getAddress(existing.oldOwner).toLowerCase()]
    .includes(gasWallet.toLowerCase())) {
    throw new Error('Gas 钱包须与硬件钱包、旧 owner、管理员和部署合约地址不同。');
  }
  return {hardwareWallet, gasWallet,
    administratorOne:authorityAdministrators[0], administratorTwo:authorityAdministrators[1]};
}
