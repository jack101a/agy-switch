import * as https from 'https';
import {
    QUOTA_API_ENDPOINTS,
    LOAD_CODE_ASSIST_ENDPOINTS,
    MODEL_DISPLAY_NAMES,
    USER_AGENT,
} from '../constants.js';
import { QuotaModel, QuotaResult, HttpError } from '../types.js';

export class QuotaApiService {
    private static readonly CLOUD_API_TIMEOUT_MS = 25_000;

    async fetchRemoteQuota(accessToken: string): Promise<QuotaResult> {
        const { projectId, tier, tierName } = await this.loadProjectInfo(accessToken);

        let quotaData: any = null;
        let lastError: Error | null = null;

        for (const ep of QUOTA_API_ENDPOINTS) {
            try {
                quotaData = await this.postJson(ep, { project: projectId }, accessToken);
                if (quotaData) break;
            } catch (e) {
                lastError = e as Error;
                if (e instanceof HttpError) {
                    if (e.statusCode === 403) {
                        return { models: [], tier, tierName, isForbidden: true, isError: false };
                    }
                    if (e.statusCode === 401) {
                        throw e;
                    }
                }
            }
        }

        if (!quotaData) {
            return {
                models: [],
                tier,
                tierName,
                isForbidden: false,
                isError: true,
                errorMessage: lastError?.message || 'Failed to retrieve quota from all endpoints',
            };
        }

        const rawBuckets = quotaData.buckets || quotaData.modelQuotas || quotaData.quotaBuckets || [];
        const models = this.parseBuckets(rawBuckets);

        const geminiModels = models.filter((m) => m.modelId.includes('gemini'));
        let geminiHourlyPercent: number = 100;
        let geminiHourlyReset: string | null = null;
        let weeklyExpiry: string | null = null;

        const now = Date.now();
        for (const m of models) {
            if (m.resetAt) {
                const diff = new Date(m.resetAt).getTime() - now;
                if (diff > 24 * 60 * 60 * 1000) {
                    if (!weeklyExpiry || new Date(m.resetAt).getTime() < new Date(weeklyExpiry).getTime()) {
                        weeklyExpiry = m.resetAt;
                    }
                }
            }
        }

        if (geminiModels.length > 0) {
            const sample = geminiModels.find((m) => m.modelId === 'gemini-2.5-pro' || m.modelId === 'gemini-2.5-flash') || geminiModels[0];
            geminiHourlyPercent = Math.max(0, Math.min(100, 100 - sample.usedPercent));
            geminiHourlyReset = sample.resetAt;
            if (sample.resetAt && new Date(sample.resetAt).getTime() - now > 24 * 60 * 60 * 1000) {
                weeklyExpiry = sample.resetAt;
            }
        }

        return {
            models,
            tier,
            tierName,
            isForbidden: false,
            isError: false,
            geminiHourlyPercent,
            geminiHourlyReset,
            weeklyExpiry,
        };
    }

    private async loadProjectInfo(
        accessToken: string
    ): Promise<{ projectId: string; tier: string | null; tierName: string | null }> {
        let projectId = 'cloudaicompanion-enterprise';
        let tier: string | null = null;
        let tierName: string | null = null;

        for (const ep of LOAD_CODE_ASSIST_ENDPOINTS) {
            try {
                const res = await this.postJson(ep, { metadata: { ideType: 'ANTIGRAVITY' } }, accessToken);
                if (res) {
                    projectId = res.cloudaicompanionProject || res.project || projectId;
                    tier = res.paidTier?.id || res.currentTier?.id || res.tier || null;
                    tierName = res.paidTier?.name || res.currentTier?.name || tier || 'Standard';
                    break;
                }
            } catch {
                // Try next endpoint
            }
        }

        return { projectId, tier, tierName };
    }

    private parseBuckets(buckets: any[]): QuotaModel[] {
        const models: QuotaModel[] = [];

        for (const b of buckets) {
            const modelId = b.modelId || b.model || b.name || 'unknown-model';
            const displayName =
                MODEL_DISPLAY_NAMES[modelId] ||
                this.humanizeModelId(modelId);

            let used = 0;
            let limit = 100;
            let usedPercent = 0;
            let resetAt: string | null = b.resetTime || b.resetAt || null;

            if (typeof b.remainingFraction === 'number') {
                const remaining = Math.max(0, Math.min(1, b.remainingFraction));
                usedPercent = Math.round((1 - remaining) * 100);
                used = usedPercent;
                limit = 100;
            } else if (b.quota) {
                limit = b.quota.limit || 100;
                used = b.quota.used || 0;
                usedPercent = limit > 0 ? Math.round((used / limit) * 100) : 0;
            } else if (typeof b.used === 'number' && typeof b.limit === 'number') {
                used = b.used;
                limit = b.limit;
                usedPercent = limit > 0 ? Math.round((used / limit) * 100) : 0;
            }

            models.push({
                modelId,
                displayName,
                used,
                limit,
                usedPercent,
                resetAt,
            });
        }

        return models;
    }

    private humanizeModelId(id: string): string {
        return id
            .split('-')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    private async postJson(url: string, body: object, accessToken: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(url);
            const payload = JSON.stringify(body);

            const req = https.request(
                {
                    hostname: urlObj.hostname,
                    path: urlObj.pathname + urlObj.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                        Authorization: `Bearer ${accessToken}`,
                        'User-Agent': USER_AGENT,
                    },
                    timeout: QuotaApiService.CLOUD_API_TIMEOUT_MS,
                },
                (res) => {
                    let data = '';
                    res.on('data', (chunk) => (data += chunk));
                    res.on('end', () => {
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            try {
                                resolve(JSON.parse(data));
                            } catch (e) {
                                reject(e);
                            }
                        } else {
                            reject(new HttpError(res.statusCode || 500, data));
                        }
                    });
                }
            );
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('API request timed out'));
            });
            req.write(payload);
            req.end();
        });
    }
}
