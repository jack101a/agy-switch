import fs from 'fs';
import crypto from 'crypto';
import type { StoredAccount, ActiveAccount, AccountQuota } from '../types.js';
import {
  DATA_DIR,
  ACCOUNTS_FILE,
  ACTIVE_ACCOUNT_FILE,
  TOKEN_REFRESH_BUFFER_SECS,
} from '../constants.js';
import type { GoogleAuthService } from '../services/googleAuth.js';
import type { QuotaApiService } from '../services/quotaApi.js';

export class AccountManager {
  private accounts: StoredAccount[] = [];
  private quotaCache = new Map<string, AccountQuota>();

  constructor(
    private authService: GoogleAuthService,
    private quotaApi: QuotaApiService,
  ) {}

  // ---------------------------------------------------------------------------
  // Initialization & Storage
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.accounts = await this.loadAccounts();
  }

  private async saveAccounts(): Promise<void> {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(this.accounts, null, 2), 'utf-8');
  }

  private async loadAccounts(): Promise<StoredAccount[]> {
    try {
      if (!fs.existsSync(ACCOUNTS_FILE)) {
        return [];
      }
      const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async saveActiveAccount(id: string, email: string): Promise<void> {
    const active: ActiveAccount = { id, email };
    fs.writeFileSync(ACTIVE_ACCOUNT_FILE, JSON.stringify(active, null, 2), 'utf-8');
  }

  async getActiveAccount(): Promise<ActiveAccount | null> {
    try {
      if (!fs.existsSync(ACTIVE_ACCOUNT_FILE)) {
        return null;
      }
      const raw = fs.readFileSync(ACTIVE_ACCOUNT_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as ActiveAccount;
      return parsed && parsed.id ? parsed : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Sync with Antigravity System Tokens
  // ---------------------------------------------------------------------------

  private syncToSystemTokens(account: StoredAccount): void {
    const homeDir = process.env.HOME || '/home/ubuntu';
    const expiryIso = new Date(account.expiryTimestamp * 1000).toISOString();

    const standardPayload = {
      token: {
        access_token: account.accessToken,
        token_type: 'Bearer',
        refresh_token: account.refreshToken,
        expiry: expiryIso,
      },
      auth_method: 'consumer',
    };

    const tokenPaths = [
      `${homeDir}/.gemini/jetski-standalone-oauth-token`,
      `${homeDir}/.gemini/antigravity-cli/antigravity-oauth-token`,
    ];

    for (const p of tokenPaths) {
      try {
        const dir = p.substring(0, p.lastIndexOf('/'));
        if (fs.existsSync(dir)) {
          fs.writeFileSync(p, JSON.stringify(standardPayload), 'utf-8');
        }
      } catch (err) {
        console.warn(`[Sync] Could not write to ${p}:`, err);
      }
    }

    try {
      const oauthCredsPath = `${homeDir}/.gemini/oauth_creds.json`;
      const credsPayload = {
        access_token: account.accessToken,
        refresh_token: account.refreshToken,
        scope:
          'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cloud-platform openid',
        token_type: 'Bearer',
        expiry_date: account.expiryTimestamp * 1000,
      };
      fs.writeFileSync(oauthCredsPath, JSON.stringify(credsPayload, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[Sync] Could not write to oauth_creds.json:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Account CRUD
  // ---------------------------------------------------------------------------

  getAccounts(): StoredAccount[] {
    return [...this.accounts];
  }

  getAccount(id: string): StoredAccount | undefined {
    return this.accounts.find((a) => a.id === id);
  }

  async addAccount(): Promise<{
    success: boolean;
    account?: StoredAccount;
    authUrl?: string;
    message: string;
  }> {
    try {
      const result = await this.authService.startOAuthFlow();

      const account: StoredAccount = {
        id: crypto.randomUUID(),
        email: result.email,
        name: result.name,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiryTimestamp: result.expiryTimestamp,
        addedAt: Date.now(),
      };

      this.accounts.push(account);
      await this.saveAccounts();
      await this.setActiveAccount(account.id);

      return { success: true, account, message: `Account ${account.email} added successfully.` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, message: `OAuth flow failed: ${message}` };
    }
  }

  async addAccountWithTokens(
    tokens: { accessToken: string; refreshToken: string; expiryTimestamp: number },
    userInfo: { email: string; name: string },
  ): Promise<StoredAccount> {
    const existingIndex = this.accounts.findIndex((a) => a.email === userInfo.email);

    let account: StoredAccount;
    if (existingIndex >= 0) {
      account = {
        ...this.accounts[existingIndex],
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiryTimestamp: tokens.expiryTimestamp,
      };
      this.accounts[existingIndex] = account;
    } else {
      account = {
        id: crypto.randomUUID(),
        email: userInfo.email,
        name: userInfo.name,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiryTimestamp: tokens.expiryTimestamp,
        addedAt: Date.now(),
      };
      this.accounts.push(account);
    }

    await this.saveAccounts();
    await this.setActiveAccount(account.id);

    return account;
  }

  async removeAccount(id: string): Promise<void> {
    this.accounts = this.accounts.filter((a) => a.id !== id);
    await this.saveAccounts();

    const active = await this.getActiveAccount();
    if (active?.id === id) {
      try {
        fs.unlinkSync(ACTIVE_ACCOUNT_FILE);
      } catch {}
    }

    this.quotaCache.delete(id);
  }

  async setActiveAccount(id: string): Promise<boolean> {
    const account = this.getAccount(id);
    if (!account) {
      return false;
    }
    await this.saveActiveAccount(account.id, account.email);

    // Sync tokens to Antigravity runtime files
    this.syncToSystemTokens(account);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Token Refresh
  // ---------------------------------------------------------------------------

  async getValidToken(account: StoredAccount): Promise<string> {
    const nowSecs = Date.now() / 1000;
    const secsUntilExpiry = account.expiryTimestamp - nowSecs;

    if (secsUntilExpiry < TOKEN_REFRESH_BUFFER_SECS) {
      const refreshed = await this.authService.refreshAccessToken(account.refreshToken);

      const idx = this.accounts.findIndex((a) => a.id === account.id);
      if (idx !== -1) {
        this.accounts[idx] = {
          ...this.accounts[idx],
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token ?? account.refreshToken,
          expiryTimestamp: refreshed.expiryTimestamp,
        };
        account.accessToken = refreshed.access_token;
        if (refreshed.refresh_token) {
          account.refreshToken = refreshed.refresh_token;
        }
        account.expiryTimestamp = refreshed.expiryTimestamp;
      }

      await this.saveAccounts();

      // If this is the active account, also sync refreshed token to system
      const active = await this.getActiveAccount();
      if (active?.id === account.id) {
        this.syncToSystemTokens(account);
      }

      return refreshed.access_token;
    }

    return account.accessToken;
  }

  // ---------------------------------------------------------------------------
  // Quota
  // ---------------------------------------------------------------------------

  getQuotaCache(): Map<string, AccountQuota> {
    return this.quotaCache;
  }

  getCachedQuota(accountId: string): AccountQuota | undefined {
    return this.quotaCache.get(accountId);
  }

  async refreshQuotaForAccount(account: StoredAccount): Promise<AccountQuota> {
    const token = await this.getValidToken(account);
    const quota = await this.quotaApi.fetchRemoteQuota(token);

    const entry: AccountQuota = {
      account,
      quota,
      fetchedAt: Date.now(),
    };

    this.quotaCache.set(account.id, entry);
    return entry;
  }

  async refreshAllQuotas(): Promise<AccountQuota[]> {
    const results = await Promise.allSettled(
      this.accounts.map((account) => this.refreshQuotaForAccount(account)),
    );

    const fulfilled: AccountQuota[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        fulfilled.push(result.value);
      }
    }

    return fulfilled;
  }
}
