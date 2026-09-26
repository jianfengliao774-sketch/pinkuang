import { BrowserProvider, getAddress } from 'ethers';
import type { DeploymentSnapshot } from './deployment';
import type { MarketJournalStorage } from './market';
import type { WalletProvider } from './wallet';

const base = '/api/journal';
const MARKET_KEY = 'pinkuang.market.pending.v1';

class JournalHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function request<T>(path: string, method = 'GET', body?: unknown, account?: string, timeoutMs = 15_000): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (account) headers['X-Pinkuang-Account'] = account;
  const response = await fetch(`${base}/${path}`, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new JournalHttpError(response.status, result.error || `服务器记录服务不可用（HTTP ${response.status}）。`);
  return result;
}

type Versioned<T> = { record: T | null; revision: number };
type DeploymentView = Versioned<DeploymentSnapshot> & {
  archives: DeploymentSnapshot[];
  archiveNextCursor: string | null;
  latestCompleted: DeploymentSnapshot | null;
};
type ArchivePage = { items: DeploymentSnapshot[]; nextCursor: string | null };
type MarketView = Versioned<unknown>;

/** The server is the only durable journal. This class keeps revisions in memory solely for CAS. */
export class ServerJournal {
  private deploymentRevision = 0;
  private marketRevision = 0;
  private readonly marketAdapter: MarketJournalStorage;

  constructor(readonly account: string) {
    this.account = getAddress(account);
    this.marketAdapter = {
      getItem: async key => {
        if (key !== MARKET_KEY) throw new Error('未知的市场交易记录。');
        const view = await this.request<MarketView>('market');
        this.marketRevision = view.revision;
        return view.record === null ? null : JSON.stringify(view.record);
      },
      setItem: async (key, value) => {
        if (key !== MARKET_KEY) throw new Error('未知的市场交易记录。');
        const record: unknown = JSON.parse(value);
        const result = await this.request<{ revision: number }>('market', 'PUT', { record, expectedRevision: this.marketRevision });
        this.marketRevision = result.revision;
      },
      removeItem: async (key, hash) => {
        if (key !== MARKET_KEY || !hash) throw new Error('清除市场交易必须提供已最终确认的交易哈希。');
        const result = await this.request<{ revision: number }>('market', 'DELETE', { expectedRevision: this.marketRevision, hash });
        this.marketRevision = result.revision;
      },
    };
  }

  marketStorage(): MarketJournalStorage { return this.marketAdapter; }

  private request<T>(path: string, method = 'GET', body?: unknown, timeoutMs?: number): Promise<T> {
    return request<T>(path, method, body, this.account, timeoutMs);
  }

  async loadDeployment(): Promise<DeploymentView> {
    const view = await this.request<DeploymentView>('deployment');
    if (!Number.isSafeInteger(view.revision) || view.revision < 0 || !Array.isArray(view.archives)
      || (view.archiveNextCursor !== null && typeof view.archiveNextCursor !== 'string')
      || (view.latestCompleted !== null && typeof view.latestCompleted !== 'object')) throw new Error('服务器部署记录格式异常。');
    if (view.record && (view.record.chainId !== 56 || view.record.account.toLowerCase() !== this.account.toLowerCase())) throw new Error('服务器部署记录与当前钱包不匹配。');
    if (view.latestCompleted && (view.latestCompleted.chainId !== 56 || view.latestCompleted.status !== 'complete'
      || view.latestCompleted.account.toLowerCase() !== this.account.toLowerCase())) throw new Error('服务器已完成部署与当前钱包不匹配。');
    this.deploymentRevision = view.revision;
    return view;
  }

  async readLatestDeployment(): Promise<DeploymentSnapshot | null> {
    return (await this.loadDeployment()).record;
  }

  async saveDeployment(record: DeploymentSnapshot): Promise<void> {
    if (record.chainId !== 56 || record.account.toLowerCase() !== this.account.toLowerCase()) throw new Error('部署记录与已认证钱包不匹配。');
    const result = await this.request<{ revision: number }>('deployment', 'PUT', { record, expectedRevision: this.deploymentRevision });
    this.deploymentRevision = result.revision;
  }

  async archiveDeployment(id: string): Promise<DeploymentView> {
    try {
      // Finality checks can require multiple RPC calls. A lost HTTP response may
      // arrive after the server has committed the archive; reconcile by ID.
      const result = await this.request<Omit<DeploymentView, 'record'>>('deployment/archive', 'POST',
        { id, expectedRevision: this.deploymentRevision }, 90_000);
      this.deploymentRevision = result.revision;
      return { ...result, record: null };
    } catch (error) {
      try {
        const current = await this.loadDeployment();
        if (current.record === null && current.archives.some(item => item.id === id)) return current;
      } catch { /* Preserve the original failure when readback is unavailable. */ }
      throw error;
    }
  }

  async loadArchivedDeployments(cursor: string, limit = 20): Promise<ArchivePage> {
    if (!/^[1-9]\d{0,18}$/.test(cursor) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('历史记录分页参数无效。');
    }
    const page = await this.request<ArchivePage>(`deployment/archives?cursor=${cursor}&limit=${limit}`);
    if (!Array.isArray(page.items) || (page.nextCursor !== null && typeof page.nextCursor !== 'string')
      || page.items.some(item => item.chainId !== 56 || item.account.toLowerCase() !== this.account.toLowerCase())) {
      throw new Error('服务器历史部署格式异常。');
    }
    return page;
  }

  async importAbortedArchive(record: DeploymentSnapshot): Promise<void> {
    if (record.chainId !== 56 || record.account.toLowerCase() !== this.account.toLowerCase() || record.status !== 'aborted') {
      throw new Error('旧部署归档与当前钱包不匹配。');
    }
    await this.request('deployment/import-archive', 'POST', { record });
  }

  async saveQuote(record: unknown): Promise<void> {
    await this.request<{ id: string }>('quote', 'POST', { record });
  }

  async loadQuotes(cursor = 0, limit = 20): Promise<{ items: { id: string; record: unknown; createdAt: number }[]; nextCursor: number | null }> {
    return this.request(`quotes?cursor=${cursor}&limit=${limit}`);
  }
}

export async function authenticateJournal(wallet: WalletProvider, account: string): Promise<ServerJournal> {
  const address = getAddress(account);
  try {
    const session = await request<{ account: string }>('session');
    if (session.account.toLowerCase() === address.toLowerCase()) return new ServerJournal(address);
  } catch (error) {
    if (!(error instanceof JournalHttpError) || error.status !== 401) throw error;
  }
  const challenge = await request<{ message: string; nonce: string }>('challenge', 'POST', { account: address });
  if (typeof challenge.message !== 'string' || typeof challenge.nonce !== 'string') throw new Error('服务器钱包认证挑战格式异常。');
  const signer = await new BrowserProvider(wallet, 'any').getSigner(address);
  const signature = await signer.signMessage(challenge.message);
  const session = await request<{ account: string }>('session', 'POST', { account: address, nonce: challenge.nonce, signature });
  if (session.account.toLowerCase() !== address.toLowerCase()) throw new Error('服务器会话的钱包地址不匹配。');
  return new ServerJournal(address);
}
