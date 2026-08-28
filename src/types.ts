export interface StoredAccount {
    id: string;
    email: string;
    name: string;
    accessToken: string;
    refreshToken: string;
    expiryTimestamp: number;
    addedAt: number;
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

export interface QuotaResult {
    models: QuotaModel[];
    tier: string | null;
    tierName: string | null;
    isForbidden: boolean;
    isError: boolean;
    errorMessage?: string;
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
