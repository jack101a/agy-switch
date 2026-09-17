export interface StoredAccount {
    id: string;
    email: string;
    name: string;
    accessToken: string;
    refreshToken: string;
    idToken?: string;
    expiryTimestamp: number;
    addedAt: number;
    weeklyExpiry?: string | null;
    weeklyPercent?: number;
    hourlyPercent?: number;
}

export interface ActiveAccount {
    id: string;
    email: string;
}

export interface QuotaModel {
    modelId: string;
    displayName: string;
    used: number;
    limit: number;
    usedPercent: number;
    resetAt: string | null;
}

export interface QuotaBucketSummary {
    bucketId: string;
    displayName: string;
    window: string;
    resetTime?: string | null;
    description?: string | null;
    remainingFraction: number;
    remainingPercent: number;
}

export interface QuotaGroupSummary {
    displayName: string;
    description?: string | null;
    buckets: QuotaBucketSummary[];
}

export interface QuotaResult {
    models: QuotaModel[];
    groups?: QuotaGroupSummary[];
    tier: string | null;
    tierName: string | null;
    isForbidden: boolean;
    isError: boolean;
    errorMessage?: string;
    geminiHourlyPercent?: number;
    geminiHourlyReset?: string | null;
    geminiHourlyDescription?: string | null;
    weeklyPercent?: number;
    weeklyExpiry?: string | null;
    weeklyDescription?: string | null;
    claudeHourlyPercent?: number;
    claudeHourlyReset?: string | null;
    claudeWeeklyPercent?: number;
    claudeWeeklyReset?: string | null;
}

export interface AccountQuota {
    account: StoredAccount;
    quota: QuotaResult;
    fetchedAt: number;
}

export class HttpError extends Error {
    constructor(public statusCode: number, message: string) {
        super(`HTTP ${statusCode}: ${message}`);
        this.name = 'HttpError';
    }
}
