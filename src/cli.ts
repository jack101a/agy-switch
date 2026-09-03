import * as readline from 'readline';
import { AccountManager } from './managers/accountManager.js';
import { GoogleAuthService } from './services/googleAuth.js';
import { QuotaApiService } from './services/quotaApi.js';
import { DASHBOARD_PORT } from './constants.js';

// ANSI color helpers
const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    bgBlue: '\x1b[44m',
    bgGreen: '\x1b[42m',
};

function progressBar(pct: number, width: number = 16): string {
    const clampedUsed = Math.max(0, Math.min(100, pct));
    const available = Math.max(0, Math.min(100, 100 - Math.round(clampedUsed)));
    const filledCount = Math.round((available / 100) * width);
    const emptyCount = width - filledCount;

    let color = c.green;
    if (available <= 20) color = c.red;
    else if (available <= 50) color = c.yellow;

    const filled = '█'.repeat(filledCount);
    const empty = '░'.repeat(emptyCount);
    return `${color}${filled}${c.dim}${empty}${c.reset} ${color}${available.toString().padStart(3)}%/100%${c.reset}`;
}

const authService = new GoogleAuthService();
const quotaApi = new QuotaApiService();
const accountManager = new AccountManager(authService, quotaApi);

await accountManager.initialize();

async function showHelp() {
    console.log(`
${c.bold}${c.cyan}⚡ AG Switchboard CLI — Antigravity 2.0 Multi-Account Manager${c.reset}

${c.bold}Available Commands:${c.reset}
  ${c.green}agy-list${c.reset}               List all connected accounts and their quota utilization
  ${c.green}agy-switch [query]${c.reset}     Switch active account interactively or by number/email
  ${c.green}agy-quota [query]${c.reset}      Show detailed model-by-model quota breakdown & reset timers
  ${c.green}agy-add${c.reset}                Connect a new Google account via terminal OAuth
  ${c.green}agy-remove [query]${c.reset}     Remove an account
  ${c.green}agy-dashboard${c.reset}          Launch the web dashboard on http://0.0.0.0:${DASHBOARD_PORT}
  ${c.green}agy-help${c.reset}               Show this help message
`);
}

async function listAccounts() {
    const accounts = accountManager.getAccounts();
    const active = await accountManager.getActiveAccount();
    const cache = accountManager.getQuotaCache();

    if (accounts.length === 0) {
        console.log(`\n${c.yellow}No accounts connected in AG Switchboard.${c.reset}`);
        console.log(`Run ${c.green}agy-add${c.reset} to connect a Google account.\n`);
        return;
    }

    console.log(`\n${c.bold}${c.cyan}⚡ Connected Antigravity Accounts (${accounts.length})${c.reset}\n`);

    accounts.forEach((acc, idx) => {
        const isActive = active?.id === acc.id;
        const cached = cache.get(acc.id)?.quota;
        const tier = cached?.tierName || 'Standard';

        const numPrefix = `${c.dim}[${idx + 1}]${c.reset}`;
        const activeBadge = isActive
            ? ` ${c.bgGreen}${c.bold} ACTIVE ${c.reset}`
            : '';

        console.log(`${numPrefix} ${c.bold}${acc.name}${c.reset} ${c.dim}(${acc.email})${c.reset}${activeBadge}`);
        console.log(`    ${c.dim}Tier:${c.reset} ${c.cyan}${tier}${c.reset}  ${c.dim}ID:${c.reset} ${c.dim}${acc.id}${c.reset}`);

        if (cached?.models && cached.models.length > 0) {
            // Pick top models
            const keyModels = ['claude-sonnet-4-6', 'gemini-3.7-flash-high', 'gemini-3.1-pro-high', 'gpt-oss-120b-medium'];
            const displayed = cached.models.filter(m => keyModels.includes(m.modelId) || keyModels.some(k => m.modelId.includes(k))).slice(0, 4);

            for (const m of (displayed.length > 0 ? displayed : cached.models.slice(0, 3))) {
                console.log(`    ${m.displayName.padEnd(28)} ${progressBar(m.usedPercent)}`);
            }
        } else {
            console.log(`    ${c.dim}(Quota not cached yet. Run 'agy-quota ${idx + 1}' to fetch)${c.reset}`);
        }
        console.log('');
    });
}

async function showQuota(query?: string) {
    const accounts = accountManager.getAccounts();
    if (accounts.length === 0) {
        console.log(`\n${c.yellow}No accounts connected.${c.reset} Run ${c.green}agy-add${c.reset}\n`);
        return;
    }

    let target = accounts[0];
    if (query) {
        const num = parseInt(query, 10);
        if (!isNaN(num) && num >= 1 && num <= accounts.length) {
            target = accounts[num - 1];
        } else {
            const found = accounts.find(
                a => a.email.toLowerCase().includes(query.toLowerCase()) ||
                     a.name.toLowerCase().includes(query.toLowerCase()) ||
                     a.id === query
            );
            if (found) target = found;
        }
    } else {
        const active = await accountManager.getActiveAccount();
        if (active) {
            const found = accounts.find(a => a.id === active.id);
            if (found) target = found;
        }
    }

    console.log(`\n${c.bold}🔄 Fetching live quota for ${c.cyan}${target.name}${c.reset} (${target.email})...\n`);

    try {
        const res = await accountManager.refreshQuotaForAccount(target);
        const quota = res.quota;

        if (quota.isForbidden) {
            console.log(`${c.red}⚠️ 403 Forbidden: Account does not have Cloud AI Companion permissions.${c.reset}\n`);
            return;
        }
        if (quota.isError) {
            console.log(`${c.red}❌ Error: ${quota.errorMessage || 'Failed to fetch quota'}${c.reset}\n`);
            return;
        }

        console.log(`${c.bold}Tier:${c.reset} ${c.green}${quota.tierName || 'Standard'}${c.reset}\n`);
        console.log(`${c.dim}${'Model'.padEnd(32)} ${'Usage'.padEnd(24)} Reset Time${c.reset}`);
        console.log('─'.repeat(74));

        for (const m of quota.models) {
            const resetStr = m.resetAt
                ? new Date(m.resetAt).toLocaleTimeString()
                : c.dim + 'N/A' + c.reset;

            console.log(`${c.bold}${m.displayName.padEnd(32)}${c.reset} ${progressBar(m.usedPercent)}  ${c.dim}${resetStr}${c.reset}`);
        }
        console.log('');
    } catch (e: any) {
        console.log(`${c.red}Failed to fetch quota: ${e.message}${c.reset}\n`);
    }
}

async function switchAccount(query?: string) {
    const accounts = accountManager.getAccounts();
    const active = await accountManager.getActiveAccount();

    if (accounts.length === 0) {
        console.log(`\n${c.yellow}No accounts connected.${c.reset} Run ${c.green}agy-add${c.reset}\n`);
        return;
    }

    if (query) {
        let target: any = null;
        const num = parseInt(query, 10);
        if (!isNaN(num) && num >= 1 && num <= accounts.length) {
            target = accounts[num - 1];
        } else {
            target = accounts.find(
                a => a.email.toLowerCase().includes(query.toLowerCase()) ||
                     a.name.toLowerCase().includes(query.toLowerCase()) ||
                     a.id === query
            );
        }

        if (!target) {
            console.log(`\n${c.red}Account matching "${query}" not found.${c.reset}\n`);
            return;
        }

        await accountManager.setActiveAccount(target.id);
        console.log(`\n${c.green}✔ Active account switched to:${c.reset} ${c.bold}${target.name}${c.reset} (${target.email})\n`);
        return;
    }

    // Interactive TUI selection
    console.log(`\n${c.bold}${c.cyan}Select an account to activate:${c.reset}\n`);
    accounts.forEach((acc, idx) => {
        const isActive = active?.id === acc.id;
        const mark = isActive ? `${c.green}● (active)${c.reset}` : `${c.dim}○${c.reset}`;
        console.log(`  ${c.bold}[${idx + 1}]${c.reset} ${mark} ${c.bold}${acc.name}${c.reset} ${c.dim}(${acc.email})${c.reset}`);
    });

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    rl.question(`\nEnter number (1-${accounts.length}) or 'q' to cancel: `, async (answer) => {
        rl.close();
        const trimmed = answer.trim();
        if (trimmed.toLowerCase() === 'q' || !trimmed) {
            console.log('Cancelled.\n');
            return;
        }

        const idx = parseInt(trimmed, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= accounts.length) {
            console.log(`${c.red}Invalid selection.${c.reset}\n`);
            return;
        }

        const chosen = accounts[idx];
        await accountManager.setActiveAccount(chosen.id);
        console.log(`\n${c.green}✔ Active account switched to:${c.reset} ${c.bold}${chosen.name}${c.reset} (${chosen.email})\n`);
    });
}

async function addAccount() {
    console.log(`\n${c.bold}${c.cyan}⚡ Connect New Google Account${c.reset}\n`);
    const session = authService.createOAuthSession();

    console.log(`1. Open this link in your browser:`);
    console.log(`   ${c.blue}${session.authUrl}${c.reset}\n`);
    console.log(`2. Sign in and approve permissions.`);
    console.log(`3. When redirected, copy the URL from your address bar (or the auth code) and paste it below:\n`);

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    rl.question(`${c.bold}Paste redirect URL or code: ${c.reset}`, async (input) => {
        rl.close();
        const raw = input.trim();
        if (!raw) {
            console.log(`${c.yellow}Cancelled.${c.reset}\n`);
            return;
        }

        console.log(`\nConnecting account...`);
        try {
            const oauthResult = await authService.completeOAuthWithCode(raw, session.state);
            const account = await accountManager.addAccountWithTokens(
                {
                    accessToken: oauthResult.accessToken,
                    refreshToken: oauthResult.refreshToken,
                    expiryTimestamp: oauthResult.expiryTimestamp,
                },
                {
                    email: oauthResult.email,
                    name: oauthResult.name,
                }
            );

            console.log(`\n${c.green}✔ Account connected successfully!${c.reset}`);
            console.log(`  Name:  ${c.bold}${account.name}${c.reset}`);
            console.log(`  Email: ${account.email}`);
            console.log(`  Set as active account automatically.\n`);
        } catch (e: any) {
            console.log(`\n${c.red}❌ Failed to connect account:${c.reset} ${e.message}\n`);
        }
    });
}

async function removeAccount(query?: string) {
    const accounts = accountManager.getAccounts();
    if (accounts.length === 0) {
        console.log(`\n${c.yellow}No accounts to remove.${c.reset}\n`);
        return;
    }

    if (!query) {
        console.log(`\n${c.yellow}Usage: agy-remove <number|email|name>${c.reset}`);
        accounts.forEach((acc, idx) => {
            console.log(`  [${idx + 1}] ${acc.name} (${acc.email})`);
        });
        console.log('');
        return;
    }

    let target: any = null;
    const num = parseInt(query, 10);
    if (!isNaN(num) && num >= 1 && num <= accounts.length) {
        target = accounts[num - 1];
    } else {
        target = accounts.find(
            a => a.email.toLowerCase().includes(query.toLowerCase()) ||
                 a.name.toLowerCase().includes(query.toLowerCase()) ||
                 a.id === query
        );
    }

    if (!target) {
        console.log(`\n${c.red}Account "${query}" not found.${c.reset}\n`);
        return;
    }

    await accountManager.removeAccount(target.id);
    console.log(`\n${c.green}✔ Removed account:${c.reset} ${target.name} (${target.email})\n`);
}

// Router for CLI commands
const args = process.argv.slice(2);
const cmd = args[0] || 'list';
const param = args[1];

switch (cmd) {
    case 'list':
    case 'ls':
        await listAccounts();
        break;
    case 'switch':
    case 'use':
        await switchAccount(param);
        break;
    case 'quota':
    case 'status':
        await showQuota(param);
        break;
    case 'add':
    case 'login':
        await addAccount();
        break;
    case 'remove':
    case 'rm':
    case 'delete':
        await removeAccount(param);
        break;
    case 'help':
    case '--help':
    case '-h':
        await showHelp();
        break;
    default:
        // If argument is a number or string, try switching
        if (accountsMatch(cmd)) {
            await switchAccount(cmd);
        } else {
            console.log(`${c.red}Unknown command: ${cmd}${c.reset}`);
            await showHelp();
        }
        break;
}

function accountsMatch(q: string): boolean {
    const accs = accountManager.getAccounts();
    const num = parseInt(q, 10);
    if (!isNaN(num) && num >= 1 && num <= accs.length) return true;
    return accs.some(
        a => a.email.toLowerCase().includes(q.toLowerCase()) ||
             a.name.toLowerCase().includes(q.toLowerCase())
    );
}
