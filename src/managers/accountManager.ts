import fs from 'fs';
import crypto from 'crypto';
import type { StoredAccount, ActiveAccount, AccountQuota } from '../types.js';
import {
  DATA_DIR,
  ACCOUNTS_FILE,
  ACTIVE_ACCOUNT_FILE,
  TOKEN_REFRESH_BUFFER_SECS,
  OAUTH_SCOPES,
} from '../constants.js';
import { getEffectiveWeeklyExpiry } from '../tui/components.js';
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
        scope: OAUTH_SCOPES.join(' '),
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

  getEffectiveWeeklyExpiryForAccount(account: StoredAccount): string | null {
    const cachedQuota = this.quotaCache.get(account.id)?.quota;
    const liveExpiry = cachedQuota?.weeklyExpiry;
    if (liveExpiry) return liveExpiry;
    return getEffectiveWeeklyExpiry(account.weeklyExpiry, account.addedAt);
  }

  async setWeeklyExpiry(id: string, dateIso: string | null): Promise<boolean> {
    const acc = this.accounts.find((a) => a.id === id);
    if (!acc) return false;
    acc.weeklyExpiry = dateIso;
    await this.saveAccounts();
    const cached = this.quotaCache.get(id);
    if (cached?.quota) {
      cached.quota.weeklyExpiry = dateIso;
    }
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

    let changed = false;
    if (quota.weeklyExpiry && account.weeklyExpiry !== quota.weeklyExpiry) {
      account.weeklyExpiry = quota.weeklyExpiry;
      changed = true;
    }
    if (typeof quota.weeklyPercent === 'number' && account.weeklyPercent !== quota.weeklyPercent) {
      account.weeklyPercent = quota.weeklyPercent;
      changed = true;
    }
    if (typeof quota.geminiHourlyPercent === 'number' && account.hourlyPercent !== quota.geminiHourlyPercent) {
      account.hourlyPercent = quota.geminiHourlyPercent;
      changed = true;
    }

    if (changed) {
      const idx = this.accounts.findIndex((a) => a.id === account.id);
      if (idx !== -1) {
        this.accounts[idx] = { ...account };
        this.saveAccounts().catch(() => {});
      }
    }

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

  // ---------------------------------------------------------------------------
  // Auto-Rotation Logic (Gemini Hourly Limit & Weekly Expiry Priority)
  // ---------------------------------------------------------------------------

  async evaluateAccounts(forceRefresh = false): Promise<Array<{
    account: StoredAccount;
    hourlyPercent: number;
    hourlyReset: string | null;
    weeklyPercent: number;
    weeklyExpiry: string | null;
    isAvailable: boolean;
  }>> {
    const now = Date.now();
    // Ensure quotas are loaded and reasonably fresh (TTL 60s) for all accounts
    for (const acc of this.accounts) {
      const cached = this.quotaCache.get(acc.id);
      if (forceRefresh || !cached || (now - cached.fetchedAt > 60000)) {
        try {
          await this.refreshQuotaForAccount(acc);
        } catch {}
      }
    }

    return this.accounts.map((acc) => {
      const q = this.quotaCache.get(acc.id)?.quota;
      const hourlyPercent = q?.geminiHourlyPercent ?? 100;
      const hourlyReset = q?.geminiHourlyReset ?? null;
      const weeklyPercent = q?.weeklyPercent ?? 100;
      const weeklyExpiry = this.getEffectiveWeeklyExpiryForAccount(acc);
      // Available if both 5-hour quota and weekly quota are > 0%
      const isAvailable = hourlyPercent > 0 && weeklyPercent > 0;

      return {
        account: acc,
        hourlyPercent,
        hourlyReset,
        weeklyPercent,
        weeklyExpiry,
        isAvailable,
      };
    });
  }

  async selectOptimalAccount(forceRefresh = false): Promise<{
    optimal: StoredAccount | null;
    candidates: Array<{
      account: StoredAccount;
      hourlyPercent: number;
      weeklyPercent: number;
      weeklyExpiry: string | null;
      hourlyReset: string | null;
      isAvailable: boolean;
    }>;
  }> {
    const evaluated = await this.evaluateAccounts(forceRefresh);
    if (evaluated.length === 0) {
      return { optimal: null, candidates: [] };
    }

    // Sort all candidates by Gemini priority:
    // 1. Available accounts (5h > 0% AND weekly > 0%) come first, sorted by earliest weeklyExpiry
    // 2. Exhausted accounts come after, sorted by earliest recovery time
    evaluated.sort((a, b) => {
      if (a.isAvailable && !b.isAvailable) return -1;
      if (!a.isAvailable && b.isAvailable) return 1;

      if (a.isAvailable && b.isAvailable) {
        const timeA = a.weeklyExpiry ? new Date(a.weeklyExpiry).getTime() : Number.MAX_SAFE_INTEGER;
        const timeB = b.weeklyExpiry ? new Date(b.weeklyExpiry).getTime() : Number.MAX_SAFE_INTEGER;

        if (timeA !== timeB) {
          return timeA - timeB; // Earliest weekly expiry first
        }
        // Tie-breaker 1: lower weekly percent remaining (burn quota nearing reset)
        if (a.weeklyPercent !== b.weeklyPercent) {
          return a.weeklyPercent - b.weeklyPercent;
        }
        // Tie-breaker 2: higher hourly available percentage
        return b.hourlyPercent - a.hourlyPercent;
      }

      // Both are exhausted: sort by earliest recovery time
      const getRecoveryTime = (item: typeof a) => {
        if (item.hourlyPercent <= 0 && item.hourlyReset) {
          return new Date(item.hourlyReset).getTime();
        }
        if (item.weeklyPercent <= 0 && item.weeklyExpiry) {
          return new Date(item.weeklyExpiry).getTime();
        }
        return Number.MAX_SAFE_INTEGER;
      };
      return getRecoveryTime(a) - getRecoveryTime(b);
    });

    const optimal = evaluated[0]?.account || null;

    return { optimal, candidates: evaluated };
  }

  async checkAndAutoRotate(): Promise<{
    rotated: boolean;
    currentAccount: StoredAccount | null;
    newAccount: StoredAccount | null;
    reason: string;
  }> {
    const activeInfo = await this.getActiveAccount();
    if (!activeInfo) {
      const { optimal } = await this.selectOptimalAccount();
      if (optimal) {
        await this.setActiveAccount(optimal.id);
        return {
          rotated: true,
          currentAccount: null,
          newAccount: optimal,
          reason: 'No active account set. Activated optimal account.',
        };
      }
      return { rotated: false, currentAccount: null, newAccount: null, reason: 'No accounts available.' };
    }

    const current = this.getAccount(activeInfo.id);
    if (!current) {
      return { rotated: false, currentAccount: null, newAccount: null, reason: 'Current active account not found.' };
    }

    // Refresh quota for active account to get current percentage
    try {
      await this.refreshQuotaForAccount(current);
    } catch {}

    const q = this.quotaCache.get(current.id)?.quota;
    const currentHourlyPercent = q?.geminiHourlyPercent ?? 100;
    const currentWeeklyPercent = q?.weeklyPercent ?? 100;
    const isExhausted = currentHourlyPercent <= 0 || currentWeeklyPercent <= 0;

    // Rule: Stay on current account while it has available quota
    if (!isExhausted) {
      return {
        rotated: false,
        currentAccount: current,
        newAccount: current,
        reason: `Active account still has available quota (5h: ${currentHourlyPercent}%, weekly: ${currentWeeklyPercent}%).`,
      };
    }

    // Current account is exhausted -> evaluate optimal switch with fresh quotas
    const { optimal, candidates } = await this.selectOptimalAccount(true);
    const bestCandidate = candidates.find((c) => c.account.id === optimal?.id);
    if (!optimal || !bestCandidate?.isAvailable || optimal.id === current.id) {
      return {
        rotated: false,
        currentAccount: current,
        newAccount: current,
        reason: 'All accounts have exhausted Gemini quota (0%) or current is only available option.',
      };
    }

    // Switch to optimal account
    await this.setActiveAccount(optimal.id);

    const exhaustionReason = currentHourlyPercent <= 0
      ? `5-hour limit exhausted (0%)`
      : `Weekly limit exhausted (0%)`;

    return {
      rotated: true,
      currentAccount: current,
      newAccount: optimal,
      reason: `${exhaustionReason} on ${current.name}. Rotated to ${optimal.name} (nearest weekly expiry: ${this.getEffectiveWeeklyExpiryForAccount(optimal)}).`,
    };
  }
}
