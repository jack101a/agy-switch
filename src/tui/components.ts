import type { StoredAccount, AccountQuota } from '../types.js';

// ─── ANSI Styling & Escape Codes ───────────────────────────────────────────────
export const C = {
    reset:        '\x1b[0m',
    bold:         '\x1b[1m',
    dim:          '\x1b[2m',
    inverse:      '\x1b[7m',
    green:        '\x1b[32m',
    brightGreen:  '\x1b[92m',
    yellow:       '\x1b[33m',
    brightYellow: '\x1b[93m',
    red:          '\x1b[31m',
    brightRed:    '\x1b[91m',
    blue:         '\x1b[34m',
    cyan:         '\x1b[36m',
    brightCyan:   '\x1b[96m',
    white:        '\x1b[97m',
    gray:         '\x1b[90m',
    bgGreen:      '\x1b[42m',
    bgDarkGreen:  '\x1b[48;5;22m',
    bgBlue:       '\x1b[44m',
    bgCyan:       '\x1b[46m',
    bgRed:        '\x1b[41m',
    bgDarkGray:   '\x1b[48;5;236m',
};

// Check if colors should be disabled
const noColor = process.env.NO_COLOR !== undefined;
if (noColor) {
    for (const key of Object.keys(C)) {
        (C as any)[key] = '';
    }
}

export function getTermWidth(): number {
    const cols = process.stdout.columns || 80;
    return Math.max(32, Math.min(cols, 110));
}

export function stripAnsi(str: string): string {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
}

export function padRight(str: string, len: number): string {
    const plain = stripAnsi(str);
    return str + ' '.repeat(Math.max(0, len - plain.length));
}

export function truncate(str: string, len: number): string {
    if (str.length <= len) return str;
    return str.substring(0, Math.max(1, len - 1)) + '…';
}

export function makeProgressBar(pct: number, width: number = 10): string {
    const clampedUsed = Math.max(0, Math.min(100, pct));
    const available = Math.max(0, Math.min(100, 100 - Math.round(clampedUsed)));
    const filled = Math.round((available / 100) * width);
    const empty = width - filled;

    let color = C.brightGreen;
    if (available <= 20) color = C.brightRed;
    else if (available <= 50) color = C.brightYellow;

    return `${color}${'█'.repeat(filled)}${C.gray}${'░'.repeat(empty)}${C.reset} ${color}${available.toString().padStart(3)}%/100%${C.reset}`;
}

export function formatResetCountdown(iso: string | null, isCompact: boolean = false): string {
    if (!iso) return `${C.gray}N/A${C.reset}`;
    try {
        const target = new Date(iso);
        const now = new Date();
        const diffMs = target.getTime() - now.getTime();

        if (diffMs <= 0) {
            return `${C.brightGreen}Ready (Reset now)${C.reset}`;
        }

        const totalMins = Math.floor(diffMs / 60000);
        const hours = Math.floor(totalMins / 60);
        const mins = totalMins % 60;
        const days = Math.floor(hours / 24);
        const remHours = hours % 24;

        let relative = '';
        if (days > 0) {
            relative = `${days}d ${remHours}h`;
        } else if (hours > 0) {
            relative = `${hours}h ${mins}m`;
        } else {
            relative = `${mins}m`;
        }

        const dayName = target.toLocaleDateString('en-GB', { weekday: 'short' });
        const time = target.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true });

        if (isCompact) {
            return `${C.brightCyan}in ${relative}${C.reset} ${C.gray}(${dayName} ${time})${C.reset}`;
        }
        return `${C.brightCyan}in ${relative}${C.reset} ${C.gray}(${dayName} ${time})${C.reset}`;
    } catch {
        return `${C.gray}N/A${C.reset}`;
    }
}

// ─── Priority Models ───────────────────────────────────────────────────────────
export const PRIORITY_MODELS: Record<string, string> = {
    'claude-sonnet-4-6': 'Claude Sonnet 4.6',
    'claude-opus-4-6-thinking': 'Claude Opus 4.6',
    'gemini-3.7-flash-high': 'Gemini 3.7 Flash',
    'gemini-3.1-pro-high': 'Gemini 3.1 Pro',
    'gpt-oss-120b-medium': 'GPT-OSS 120B',
};

export function getTopModels(quota: AccountQuota['quota'] | undefined, maxCount: number = 3) {
    if (!quota?.models?.length) return [];
    
    const matched: Array<{ modelId: string; displayName: string; usedPercent: number; resetAt: string | null }> = [];
    
    for (const [key, cleanName] of Object.entries(PRIORITY_MODELS)) {
        const found = quota.models.find(m => m.modelId === key || m.modelId.includes(key));
        if (found) {
            matched.push({
                ...found,
                displayName: cleanName,
            });
        }
    }

    if (matched.length >= maxCount) return matched.slice(0, maxCount);

    for (const m of quota.models) {
        if (!matched.some(x => x.modelId === m.modelId)) {
            matched.push(m);
        }
        if (matched.length >= maxCount) break;
    }

    return matched;
}
