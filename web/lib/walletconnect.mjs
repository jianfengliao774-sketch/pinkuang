import { createWalletConnectConnector, validWalletConnectProjectId } from '../../deploy/shared/walletconnect.mjs';
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '';
export const walletConnectEnabled = validWalletConnectProjectId(projectId);
export function walletConnectForPage() {
  return createWalletConnectConnector({ projectId, origin: window.location.href,
    loadProvider: async () => (await import('@walletconnect/ethereum-provider')).EthereumProvider,
    renderQr: async uri => (await import('qrcode')).default.toDataURL(uri, { width: 288, margin: 3, errorCorrectionLevel: 'M' }) });
}
