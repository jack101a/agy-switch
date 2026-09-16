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

        const daysShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const monthsShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const dayName = daysShort[target.getDay()];
        const monthName = monthsShort[target.getMonth()];
        const dateStr = days > 0 ? `${dayName} ${target.getDate()} ${monthName}` : dayName;
        const time = target.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true });

        return `${C.brightCyan}in ${relative}${C.reset} ${C.gray}(${dateStr} ${time})${C.reset}`;
    } catch {
        return `${C.gray}N/A${C.reset}`;
    }
}

export function parseWeeklyDate(input: string): string | null {
    if (!input) return null;
    const str = input.trim().toLowerCase();
    if (['none', 'clear', 'reset', 'null', 'remove'].includes(str)) return null;

    const now = new Date();
    const currentYear = now.getFullYear();

    // Check weekday: mon, tue, wed, thu, fri, sat, sun
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const shortDays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const targetDayIndex = days.findIndex(d => d.startsWith(str)) !== -1 
        ? days.findIndex(d => d.startsWith(str))
        : shortDays.findIndex(d => d === str);

    if (targetDayIndex !== -1) {
        const todayDay = now.getDay();
        let diff = targetDayIndex - todayDay;
        if (diff <= 0) diff += 7; // Next occurrence
        const target = new Date(now.getTime() + diff * 24 * 60 * 60 * 1000);
        target.setHours(23, 59, 59, 0);
        return target.toISOString();
    }

    // Relative like "+3d", "in 3d", "3 days"
    const relMatch = str.match(/(?:in|\+)?\s*(\d+)\s*d(?:ays?)?/);
    if (relMatch) {
        const daysAdd = parseInt(relMatch[1], 10);
        return new Date(now.getTime() + daysAdd * 24 * 60 * 60 * 1000).toISOString();
    }

    // Patterns like "16-sep", "16 sep", "sep 16", "17-sep 12:00", "16/09"
    const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const dayMonthMatch = str.match(/^(\d{1,2})[-/\s]+([a-z]{3,9})(?:[-/\s]+(\d{2,4}))?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/i);
    if (dayMonthMatch) {
        const day = parseInt(dayMonthMatch[1], 10);
        const mStr = dayMonthMatch[2].substring(0, 3).toLowerCase();
        const mIdx = monthNames.indexOf(mStr);
        const year = dayMonthMatch[3] ? parseInt(dayMonthMatch[3], 10) : currentYear;
        const hour = dayMonthMatch[4] !== undefined ? parseInt(dayMonthMatch[4], 10) : 23;
        const min = dayMonthMatch[5] !== undefined ? parseInt(dayMonthMatch[5], 10) : 59;
        const sec = dayMonthMatch[6] !== undefined ? parseInt(dayMonthMatch[6], 10) : 59;
        if (mIdx !== -1) {
            const target = new Date(year, mIdx, day, hour, min, sec);
            return target.toISOString();
        }
    }

    const monthDayMatch = str.match(/^([a-z]{3,9})[-/\s]+(\d{1,2})(?:[-/\s]+(\d{2,4}))?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/i);
    if (monthDayMatch) {
        const mStr = monthDayMatch[1].substring(0, 3).toLowerCase();
        const mIdx = monthNames.indexOf(mStr);
        const day = parseInt(monthDayMatch[2], 10);
        const year = monthDayMatch[3] ? parseInt(monthDayMatch[3], 10) : currentYear;
        const hour = monthDayMatch[4] !== undefined ? parseInt(monthDayMatch[4], 10) : 23;
        const min = monthDayMatch[5] !== undefined ? parseInt(monthDayMatch[5], 10) : 59;
        const sec = monthDayMatch[6] !== undefined ? parseInt(monthDayMatch[6], 10) : 59;
        if (mIdx !== -1) {
            const target = new Date(year, mIdx, day, hour, min, sec);
            return target.toISOString();
        }
    }

    const parsed = Date.parse(input);
    if (!isNaN(parsed)) {
        return new Date(parsed).toISOString();
    }

    return null;
}

export function getEffectiveWeeklyExpiry(iso?: string | null, fallbackAnchorMs?: number): string | null {
    if (!iso && !fallbackAnchorMs) return null;
    let d: Date;
    if (iso) {
        d = new Date(iso);
        if (isNaN(d.getTime())) {
            if (!fallbackAnchorMs) return null;
            d = new Date(fallbackAnchorMs);
        }
    } else {
        d = new Date(fallbackAnchorMs!);
    }

    const now = Date.now();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    while (d.getTime() <= now) {
        d = new Date(d.getTime() + SEVEN_DAYS_MS);
    }
    return d.toISOString();
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
