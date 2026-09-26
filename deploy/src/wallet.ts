import { BrowserProvider, formatEther, type Eip1193Provider } from 'ethers';

export type WalletProvider = Eip1193Provider & {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};
export type WalletOption = { id: string; name: string; provider: WalletProvider };
export type WalletState = { address: string; chainId: number; balance: string };

declare global { interface Window { ethereum?: WalletProvider } }

export function discoverWallets(onChange: (options: WalletOption[]) => void) {
  const wallets = new Map<string, WalletOption>();
  const update = () => onChange([...wallets.values()]);
  if (window.ethereum) wallets.set('injected', { id: 'injected', name: '浏览器钱包', provider: window.ethereum });
  const announce = (event: Event) => {
    const { info, provider } = (event as CustomEvent<{ info: { uuid: string; name: string }; provider: WalletProvider }>).detail;
    if (!provider?.request || !info?.uuid) return;
    if (wallets.get('injected')?.provider === provider) wallets.delete('injected');
    wallets.set(info.uuid, { id: info.uuid, name: info.name, provider });
    update();
  };
  window.addEventListener('eip6963:announceProvider', announce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  update();
  return () => window.removeEventListener('eip6963:announceProvider', announce);
}

export async function readWallet(wallet: WalletProvider): Promise<WalletState | null> {
  const accounts = await wallet.request({ method: 'eth_accounts' }) as string[];
  if (!accounts.length) return null;
  const chainId = Number(await wallet.request({ method: 'eth_chainId' }));
  const provider = new BrowserProvider(wallet, 'any');
  return { address: accounts[0], chainId, balance: formatEther(await provider.getBalance(accounts[0])) };
}

export async function switchToBsc(wallet: WalletProvider) {
  try { await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] }); }
  catch (error) {
    if (Number((error as { code?: number }).code) !== 4902) throw error;
    await wallet.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x38', chainName: 'BNB Smart Chain', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, rpcUrls: ['https://bsc-dataseed.bnbchain.org'], blockExplorerUrls: ['https://bscscan.com'] }] });
    await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] });
  }
}

export function messageOf(error: unknown): string {
  const item = error as { code?: number | string; shortMessage?: string; message?: string };
  if (item.code === 4001 || item.code === 'ACTION_REJECTED') return '你已取消钱包请求，可以准备好后重试。';
  return (item.shortMessage || item.message || '操作未完成，请重试。').slice(0,500);
}
