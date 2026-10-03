export function validWalletConnectProjectId(value: unknown): boolean;
export function standardWalletConnectProvider(value: unknown): QrWalletProvider;
export interface QrWalletProvider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  disconnect(): Promise<void>;
}
export interface WalletConnectConnector {
  enabled: boolean;
  connect(options?: { onQr?: (image: string) => void }): Promise<QrWalletProvider>;
  cancel(): void;
  disconnect(): Promise<void>;
}
export function createWalletConnectConnector(options: {
  projectId: string; origin: string; loadProvider: () => Promise<unknown>;
  renderQr: (uri: string) => Promise<string>; timeoutMs?: number;
}): WalletConnectConnector;
