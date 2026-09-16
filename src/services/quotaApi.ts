import * as https from 'https';
import {
    QUOTA_API_ENDPOINTS,
    QUOTA_SUMMARY_API_ENDPOINTS,
    LOAD_CODE_ASSIST_ENDPOINTS,
    MODEL_DISPLAY_NAMES,
    USER_AGENT,
} from '../constants.js';
import { QuotaModel, QuotaResult, QuotaGroupSummary, HttpError } from '../types.js';

export class QuotaApiService {
    private static readonly CLOUD_API_TIMEOUT_MS = 25_000;

    async fetchRemoteQuota(accessToken: string): Promise<QuotaResult> {
        const { projectId, tier, tierName } = await this.loadProjectInfo(accessToken);

        let summaryData: any = null;
        let quotaData: any = null;
        let lastError: Error | null = null;
        let isForbidden = false;

        // 1. Retrieve quota summary (authoritative for 5h and weekly limits)
        for (const ep of QUOTA_SUMMARY_API_ENDPOINTS) {
            try {
                summaryData = await this.postJson(ep, { project: projectId }, accessToken);
                if (summaryData) break;
            } catch (e) {
                lastError = e as Error;
                if (e instanceof HttpError) {
                    if (e.statusCode === 403) isForbidden = true;
                    if (e.statusCode === 401) throw e;
                }
            }
        }

        // 2. Retrieve per-model quota buckets (for detailed model list)
        for (const ep of QUOTA_API_ENDPOINTS) {
            try {
                quotaData = await this.postJson(ep, { project: projectId }, accessToken);
                if (quotaData) break;
            } catch (e) {
                if (!lastError) lastError = e as Error;
                if (e instanceof HttpError) {
                    if (e.statusCode === 403) isForbidden = true;
                    if (e.statusCode === 401) throw e;
                }
            }
        }

        if (!summaryData && !quotaData) {
            return {
                models: [],
                tier,
                tierName,
                isForbidden,
                isError: !isForbidden,
                errorMessage: lastError?.message || 'Failed to retrieve quota from all endpoints',
            };
        }

        let geminiHourlyPercent = 100;
        let geminiHourlyReset: string | null = null;
        let geminiHourlyDescription: string | null = null;
        let weeklyPercent = 100;
        let weeklyExpiry: string | null = null;
        let weeklyDescription: string | null = null;
        let claudeHourlyPercent: number | undefined;
        let claudeHourlyReset: string | null = null;
        let claudeWeeklyPercent: number | undefined;
        let claudeWeeklyReset: string | null = null;
        let groups: QuotaGroupSummary[] | undefined;

        if (summaryData?.groups && Array.isArray(summaryData.groups)) {
            groups = summaryData.groups.map((g: any) => ({
                displayName: g.displayName || '',
                description: g.description || null,
                buckets: (g.buckets || []).map((b: any) => {
                    const remainingFraction = typeof b.remainingFraction === 'number' ? b.remainingFraction : 1;
                    const remainingPercent = Math.max(0, Math.min(100, Math.round(remainingFraction * 100)));
                    return {
                        bucketId: b.bucketId || '',
                        displayName: b.displayName || '',
                        window: b.window || '',
                        resetTime: b.resetTime || null,
                        description: b.description || null,
                        remainingFraction,
                        remainingPercent,
                    };
                }),
            }));

            for (const g of groups) {
                const gName = g.displayName.toLowerCase();
                for (const b of g.buckets) {
                    const isWeekly = b.window === 'weekly' || b.bucketId.includes('weekly');
                    const is5h = b.window === '5h' || b.bucketId.includes('5h') || b.bucketId.includes('hourly');

                    if (gName.includes('gemini')) {
                        if (isWeekly) {
                            weeklyPercent = b.remainingPercent;
                            weeklyExpiry = b.resetTime || null;
                            weeklyDescription = b.description || null;
                        } else if (is5h) {
                            geminiHourlyPercent = b.remainingPercent;
                            geminiHourlyReset = b.resetTime || null;
                            geminiHourlyDescription = b.description || null;
                        }
                    } else if (gName.includes('claude') || gName.includes('3p') || gName.includes('gpt')) {
                        if (isWeekly) {
                            claudeWeeklyPercent = b.remainingPercent;
                            claudeWeeklyReset = b.resetTime || null;
                        } else if (is5h) {
                            claudeHourlyPercent = b.remainingPercent;
                            claudeHourlyReset = b.resetTime || null;
                        }
                    }
                }
            }
        }

        const rawBuckets = quotaData?.buckets || quotaData?.modelQuotas || quotaData?.quotaBuckets || [];
        const models = this.parseBuckets(rawBuckets);

        // Fallback for geminiHourlyPercent / weeklyExpiry if summaryData was missing
        if (!summaryData) {
            const geminiModels = models.filter((m) => m.modelId.includes('gemini'));
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
            }
        }

        return {
            models,
            groups,
            tier,
            tierName,
            isForbidden: false,
            isError: false,
            geminiHourlyPercent,
            geminiHourlyReset,
            geminiHourlyDescription,
            weeklyPercent,
            weeklyExpiry,
            weeklyDescription,
            claudeHourlyPercent,
            claudeHourlyReset,
            claudeWeeklyPercent,
            claudeWeeklyReset,
        };
    }

    private async loadProjectInfo(
        accessToken: string
    ): Promise<{ projectId: string; tier: string | null; tierName: string | null }> {
        let projectId = 'aicode-consumers';
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
