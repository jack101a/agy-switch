import * as readline from 'readline';
import { AccountManager } from './managers/accountManager.js';
import { GoogleAuthService } from './services/googleAuth.js';
import { QuotaApiService } from './services/quotaApi.js';
import { DASHBOARD_PORT } from './constants.js';
import { TUIEngine } from './tui/engine.js';
import {
    C,
    makeProgressBar,
    formatResetCountdown,
    parseWeeklyDate,
    stripAnsi,
} from './tui/components.js';

import { RotatorService } from './services/rotatorService.js';

const authService = new GoogleAuthService();
const quotaApi = new QuotaApiService();
const accountManager = new AccountManager(authService, quotaApi);
const rotatorService = new RotatorService(accountManager);

await accountManager.initialize();

const args = process.argv.slice(2);
const isJson = args.includes('--json') || args.includes('-j');
const filteredArgs = args.filter((a) => a !== '--json' && a !== '-j');
const cmd = filteredArgs[0] ?? '';
const param = filteredArgs[1];

async function runCliList() {
    const accs = accountManager.getAccounts();
    const active = await accountManager.getActiveAccount();
    const cache = accountManager.getQuotaCache();

    if (isJson) {
        const out = accs.map((a) => ({
            id: a.id,
            name: a.name,
            email: a.email,
            isActive: a.id === active?.id,
            tier: cache.get(a.id)?.quota?.tierName || 'Standard',
            quota: cache.get(a.id)?.quota || null,
        }));
        console.log(JSON.stringify(out, null, 2));
        return;
    }

    if (accs.length === 0) {
        console.log(`\n${C.yellow}No accounts connected.${C.reset} Run ${C.green}agy-auth add${C.reset}\n`);
        return;
    }

    console.log(`\n${C.bold}${C.brightCyan}⚡ Connected Accounts (${accs.length})${C.reset}\n`);
    accs.forEach((acc, idx) => {
        const isActive = acc.id === active?.id;
        const badge = isActive ? ` ${C.bgGreen}${C.bold}${C.white} ACTIVE ${C.reset}` : '';
        const tier = cache.get(acc.id)?.quota?.tierName || 'Standard';
        console.log(`  [${idx + 1}] ${isActive ? C.brightGreen : C.white}${C.bold}${acc.name}${C.reset}  ${C.dim}${acc.email}${C.reset}  ${C.gray}(${tier})${C.reset}${badge}`);
    });
    console.log('');
}

async function runCliQuota(query?: string) {
    const accounts = accountManager.getAccounts();
    if (accounts.length === 0) {
        if (isJson) {
            console.log(JSON.stringify({ error: 'No accounts connected' }));
            return;
        }
        console.log(`\n${C.yellow}No accounts connected.${C.reset} Run ${C.green}agy-auth add${C.reset}\n`);
        return;
    }

    let targets = accounts;
    if (query) {
        const num = parseInt(query, 10);
        if (!isNaN(num) && num >= 1 && num <= accounts.length) {
            targets = [accounts[num - 1]];
        } else {
            const found = accounts.find(
                (a) =>
                    a.email.toLowerCase().includes(query.toLowerCase()) ||
                    a.name.toLowerCase().includes(query.toLowerCase())
            );
            if (found) targets = [found];
        }
    }

    if (isJson) {
        const results = [];
        for (const acc of targets) {
            const res = await accountManager.refreshQuotaForAccount(acc);
            results.push({ account: { id: acc.id, name: acc.name, email: acc.email }, quota: res.quota });
        }
        console.log(JSON.stringify(results, null, 2));
        return;
    }

    const width = Math.max(32, Math.min(process.stdout.columns || 80, 100));
    const isMobile = width < 60;

    for (const acc of targets) {
        console.log(`\n${C.bold}🔄 Fetching live quota for ${C.brightCyan}${acc.name}${C.reset} (${acc.email})...\n`);
        try {
            const res = await accountManager.refreshQuotaForAccount(acc);
            const q = res.quota;

            if (q.isForbidden) {
                console.log(`${C.red}⚠ 403 Forbidden: No permissions for Cloud AI Companion.${C.reset}\n`);
                continue;
            }
            if (q.isError) {
                console.log(`${C.red}❌ Error: ${q.errorMessage}${C.reset}\n`);
                continue;
            }

            console.log(`${C.bold}Tier:${C.reset} ${C.brightGreen}${q.tierName || 'Standard'}${C.reset}`);
            const weeklyIso = accountManager.getEffectiveWeeklyExpiryForAccount(acc);
            const weeklyStr = weeklyIso ? formatResetCountdown(weeklyIso, false) : `${C.gray}N/A${C.reset}`;
            const hourlyBar = makeProgressBar(100 - (q.geminiHourlyPercent ?? 100), 10);
            const weeklyBar = makeProgressBar(100 - (q.weeklyPercent ?? 100), 10);
            const hourlyResetStr = q.geminiHourlyReset ? formatResetCountdown(q.geminiHourlyReset, false) : `${C.gray}active${C.reset}`;

            console.log(`${C.bold}Gemini 5-Hour:${C.reset}  ${hourlyBar}  ${C.gray}Resets: ${hourlyResetStr}${C.reset}`);
            console.log(`${C.bold}Gemini Weekly:${C.reset}  ${weeklyBar}  ${C.gray}Resets: ${weeklyStr}${C.reset}\n`);

            if (isMobile) {
                for (const m of q.models) {
                    const barStr = makeProgressBar(m.usedPercent, 8);
                    const countdownStr = formatResetCountdown(m.resetAt, true);
                    console.log(`${C.bold}${m.displayName}${C.reset}`);
                    console.log(`  ${barStr}  ${C.gray}Resets: ${countdownStr}${C.reset}`);
                }
            } else {
                console.log(`${C.gray}${'─'.repeat(width)}${C.reset}`);
                console.log(`${C.bold}${'Model'.padEnd(28)} ${'Available Quota'.padEnd(23)} Reset Date & Time${C.reset}`);
                console.log(`${C.gray}${'─'.repeat(width)}${C.reset}`);

                for (const m of q.models) {
                    const barStr = makeProgressBar(m.usedPercent, 12);
                    const countdownStr = formatResetCountdown(m.resetAt, false);
                    console.log(`${m.displayName.padEnd(28)} ${barStr}   Resets ${countdownStr}`);
                }
                console.log(`${C.gray}${'─'.repeat(width)}${C.reset}`);
            }
            console.log('');
        } catch (e: any) {
            console.log(`${C.red}Error fetching quota: ${e.message}${C.reset}\n`);
        }
    }
}

async function runCliSwitch(param?: string) {
    const accs = accountManager.getAccounts();
    if (!param) {
        console.log(`\n${C.yellow}Usage:${C.reset} agy-auth switch <name|number>\n`);
        accs.forEach((a, i) => console.log(`  [${i + 1}] ${a.name} (${a.email})`));
        console.log('');
        return;
    }
    const num = parseInt(param, 10);
    const target =
        !isNaN(num) && num >= 1 && num <= accs.length
            ? accs[num - 1]
            : accs.find(
                  (a) =>
                      a.email.toLowerCase().includes(param.toLowerCase()) ||
                      a.name.toLowerCase().includes(param.toLowerCase())
              );

    if (!target) {
        if (isJson) {
            console.log(JSON.stringify({ success: false, error: `Account ${param} not found` }));
            return;
        }
        console.log(`\n${C.red}Account "${param}" not found.${C.reset}\n`);
        return;
    }

    await accountManager.setActiveAccount(target.id);
    const restartRes = await rotatorService.restartAgy();

    if (isJson) {
        console.log(JSON.stringify({ success: true, activeAccount: target, agyRestarted: restartRes.restarted }));
        return;
    }
    console.log(`\n${C.bgGreen}${C.bold}${C.white} ✔ ACTIVE ACCOUNT SWITCHED TO: ${target.name} (${target.email}) ${C.reset}`);
    if (restartRes.restarted) {
        console.log(`${C.dim}  ↳ AGY daemon restarted (PID ${restartRes.newPid}) to apply new account.${C.reset}\n`);
    } else {
        console.log('');
    }
}

async function runCliAdd() {
    console.log(`\n${C.bold}${C.brightCyan}⚡ Connect Google Account to AG Switchboard${C.reset}\n`);
    const session = authService.createOAuthSession();
    console.log(`${C.bold}1.${C.reset} Open this link in your browser:\n   ${C.brightCyan}${session.authUrl}${C.reset}\n`);
    console.log(`${C.bold}2.${C.reset} Sign in with Google and grant access.`);
    console.log(`${C.bold}3.${C.reset} Copy the redirect URL from your browser address bar and paste below:\n`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${C.bold}Paste redirect URL or code: ${C.reset}`, async (input) => {
        rl.close();
        if (!input.trim()) {
            console.log(`${C.yellow}Cancelled.${C.reset}\n`);
            return;
        }
        try {
            const res = await authService.completeOAuthWithCode(input.trim(), session.state);
            const acc = await accountManager.addAccountWithTokens(
                { accessToken: res.accessToken, refreshToken: res.refreshToken, expiryTimestamp: res.expiryTimestamp },
                { email: res.email, name: res.name }
            );
            console.log(`\n${C.bgGreen}${C.bold}${C.white} ✔ Connected & Activated: ${acc.name} (${acc.email}) ${C.reset}\n`);
        } catch (e: any) {
            console.log(`\n${C.red}❌ Connection failed: ${e.message}${C.reset}\n`);
        }
    });
}

async function runCliRemove(param?: string) {
    const accs = accountManager.getAccounts();
    if (!param) {
        console.log(`\n${C.yellow}Usage:${C.reset} agy-auth remove <name|number>\n`);
        accs.forEach((a, i) => console.log(`  [${i + 1}] ${a.name} (${a.email})`));
        console.log('');
        return;
    }
    const num = parseInt(param, 10);
    const target =
        !isNaN(num) && num >= 1 && num <= accs.length
            ? accs[num - 1]
            : accs.find(
                  (a) =>
                      a.email.toLowerCase().includes(param.toLowerCase()) ||
                      a.name.toLowerCase().includes(param.toLowerCase())
              );

    if (!target) {
        console.log(`\n${C.red}Account "${param}" not found.${C.reset}\n`);
        return;
    }
    await accountManager.removeAccount(target.id);
    console.log(`\n${C.green}✔ Removed account: ${target.name} (${target.email})${C.reset}\n`);
}

function showHelp() {
    console.log(`
${C.bold}${C.brightCyan}⚡ agy-auth — Antigravity 2.0 Account Manager${C.reset}

${C.bold}Usage:${C.reset}
  ${C.green}agy-auth${C.reset}                     Launch full interactive TUI dashboard
  ${C.green}agy-auth list [--json]${C.reset}       List connected accounts
  ${C.green}agy-auth switch <name|#>${C.reset}   Switch active account instantly
  ${C.green}agy-auth quota [name|#]${C.reset}    Detailed model quotas & reset countdowns
  ${C.green}agy-auth set-weekly <name|#> [date]${C.reset} Set weekly quota reset day/date (e.g. "18-Sep", "Friday")
  ${C.green}agy-auth add${C.reset}                 Connect new Google account
  ${C.green}agy-auth remove <name|#>${C.reset}   Disconnect an account
  ${C.green}agy-auth select-best [--force]${C.reset} Evaluate accounts (auto-switches ONLY if active at 0%)
  ${C.green}agy-auth rotate [start|stop]${C.reset}   Manage background watcher daemon
  ${C.green}agy-auth dashboard${C.reset}           Start web dashboard on http://0.0.0.0:${DASHBOARD_PORT}
  ${C.green}agy-auth help${C.reset}                Show this help menu

${C.bold}Interactive TUI Hotkeys:${C.reset}
  ${C.bold}[1-9]${C.reset}         Quick-switch directly to account 1, 2, 3...
  ${C.bold}↑ / ↓${C.reset}         Navigate accounts
  ${C.bold}Click / Tap${C.reset}   Select & activate card directly (mouse/touch supported)
  ${C.bold}Enter / Space${C.reset} Activate highlighted account
  ${C.bold}[a]${C.reset}           Add new Google account
  ${C.bold}[d] / [x]${C.reset}     Disconnect / remove highlighted account
  ${C.bold}[w]${C.reset}           Configure weekly quota reset date/day
  ${C.bold}[r]${C.reset}           Refresh live quotas from Google Cloud
  ${C.bold}[b]${C.reset}           Launch web dashboard
  ${C.bold}[q] / Esc${C.reset}     Quit
`);
}

async function runCliSetWeekly(accountQuery?: string, dateInput?: string) {
    if (!accountQuery) {
        console.log(`\n${C.bold}Usage:${C.reset} ${C.green}agy-auth set-weekly <name|#|email> [date|day]${C.reset}`);
        console.log(`Examples:`);
        console.log(`  ${C.dim}agy-auth set-weekly 1 18-Sep${C.reset}`);
        console.log(`  ${C.dim}agy-auth set-weekly Ajay Friday${C.reset}`);
        console.log(`  ${C.dim}agy-auth set-weekly 2 "2026-09-20 00:00"${C.reset}`);
        console.log(`  ${C.dim}agy-auth set-weekly 3 clear${C.reset}\n`);
        return;
    }

    const accounts = accountManager.getAccounts();
    let target = accounts.find((a) => a.name.toLowerCase() === accountQuery.toLowerCase() || a.email.toLowerCase() === accountQuery.toLowerCase());
    if (!target) {
        const num = parseInt(accountQuery, 10);
        if (!isNaN(num) && num >= 1 && num <= accounts.length) {
            target = accounts[num - 1];
        }
    }
    if (!target) {
        target = accounts.find((a) => a.name.toLowerCase().includes(accountQuery.toLowerCase()) || a.email.toLowerCase().includes(accountQuery.toLowerCase()));
    }

    if (!target) {
        console.log(`\n${C.red}Account not found: "${accountQuery}"${C.reset}\n`);
        return;
    }

    if (!dateInput) {
        const effective = accountManager.getEffectiveWeeklyExpiryForAccount(target);
        const formatted = effective ? formatResetCountdown(effective, false) : 'N/A';
        console.log(`\nAccount: ${C.bold}${target.name}${C.reset} (${target.email})`);
        console.log(`Current Weekly Expiry: ${formatted}\n`);
        return;
    }

    if (['clear', 'reset', 'none', 'remove'].includes(dateInput.toLowerCase())) {
        await accountManager.setWeeklyExpiry(target.id, null);
        console.log(`\n${C.brightGreen}✔ Cleared weekly reset for ${target.name}.${C.reset}\n`);
        return;
    }

    const parsed = parseWeeklyDate(dateInput);
    if (!parsed) {
        console.log(`\n${C.red}❌ Could not parse date: "${dateInput}". Try formats like "18-Sep", "Friday", "2026-09-20", or "+3d".${C.reset}\n`);
        return;
    }

    await accountManager.setWeeklyExpiry(target.id, parsed);
    const formatted = formatResetCountdown(parsed, false);
    console.log(`\n${C.brightGreen}✔ Set weekly reset for ${target.name} to: ${formatted}${C.reset}\n`);
}

async function runCliSelectBest() {
    const force = process.argv.includes('--force') || process.argv.includes('-f');
    console.log(`\n${C.bold}${C.brightCyan}⚡ Evaluating accounts for Gemini quota & nearest weekly expiry...${C.reset}`);
    const res = await rotatorService.selectAndActivateOptimal(force);
    if (!res.account) {
        console.log(`${C.yellow}No accounts registered.${C.reset}\n`);
        return;
    }
    const effectiveWeekly = accountManager.getEffectiveWeeklyExpiryForAccount(res.account);
    const weeklyStr = effectiveWeekly ? formatResetCountdown(effectiveWeekly, false) : `${C.gray}N/A${C.reset}`;
    const headerTitle = res.activated ? `Switched to Optimal Account:` : `Active Account Retained:`;
    console.log(`✔ ${headerTitle} ${C.bold}${C.brightGreen}${res.account.name}${C.reset} (${res.account.email})`);
    console.log(`  Decision: ${C.dim}${res.reason}${C.reset}`);
    console.log(`  Weekly Expiry: ${weeklyStr}\n`);

    if (res.candidates && res.candidates.length > 0) {
        console.log(`${C.bold}Candidate Account Pool (Sorted by Gemini Priority):${C.reset}`);
        for (const c of res.candidates) {
            const hBar = makeProgressBar(100 - c.hourlyPercent, 8);
            const wBar = makeProgressBar(100 - c.weeklyPercent, 8);
            const exp = c.weeklyExpiry ? formatResetCountdown(c.weeklyExpiry, true) : `${C.gray}N/A${C.reset}`;
            const statusTag = c.account.id === res.account.id
                ? `${C.brightGreen}★ ACTIVE${C.reset}`
                : (c.isAvailable ? `${C.brightCyan}AVAILABLE${C.reset}` : `${C.red}EXHAUSTED${C.reset}`);
            console.log(`  ${c.account.name.padEnd(16)} 5h:${hBar} (${c.hourlyPercent}%)  Weekly:${wBar} (${c.weeklyPercent}%)  Exp: ${exp.padEnd(20)}  [${statusTag}]`);
        }
        console.log('');
    }
}

async function runCliRotate(subcmd?: string) {
    if (subcmd === '--start' || subcmd === 'start') {
        if (rotatorService.isDaemonRunning()) {
            console.log(`${C.yellow}Auto-rotator is already running.${C.reset}`);
            return;
        }
        const { spawn } = await import('child_process');
        const scriptPath = process.argv[1];
        const child = spawn(process.execPath, [scriptPath, 'rotate', '--daemon'], {
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
        console.log(`${C.brightGreen}✔ Auto-rotator background watcher started.${C.reset}`);
    } else if (subcmd === '--stop' || subcmd === 'stop') {
        const stopped = rotatorService.stopDaemon();
        if (stopped) {
            console.log(`${C.brightGreen}✔ Auto-rotator background watcher stopped.${C.reset}`);
        } else {
            console.log(`${C.gray}Auto-rotator was not running.${C.reset}`);
        }
    } else if (subcmd === '--daemon') {
        await rotatorService.runDaemon();
    } else if (subcmd === '--status' || subcmd === 'status') {
        const running = rotatorService.isDaemonRunning();
        console.log(`Auto-rotator status: ${running ? `${C.brightGreen}RUNNING (ONLINE)${C.reset}` : `${C.gray}STOPPED (OFFLINE)${C.reset}`}`);
    } else {
        await runCliSelectBest();
    }
}

switch (cmd) {
    case '': {
        const engine = new TUIEngine(authService, accountManager);
        await engine.start();
        break;
    }
    case 'list':
    case 'ls':
        await runCliList();
        break;
    case 'switch':
    case 'use':
        await runCliSwitch(param);
        break;
    case 'quota':
    case 'status':
        await runCliQuota(param);
        break;
    case 'add':
    case 'login':
        await runCliAdd();
        break;
    case 'remove':
    case 'rm':
        await runCliRemove(param);
        break;
    case 'set-weekly':
    case 'weekly':
        await runCliSetWeekly(param, filteredArgs[2]);
        break;
    case 'select-best':
    case 'best':
        await runCliSelectBest();
        break;
    case 'rotate':
        await runCliRotate(param);
        break;
    case 'dashboard': {
        console.log(`\n${C.brightCyan}⚡ Starting AG Switchboard Dashboard at http://0.0.0.0:${DASHBOARD_PORT}...${C.reset}\n`);
        const { spawn } = await import('child_process');
        const child = spawn('node', [
            new URL('./dashboard-server.js', import.meta.url).pathname
        ], { detached: true, stdio: 'ignore' });
        child.unref();
        await new Promise((r) => setTimeout(r, 1200));
        console.log(`Dashboard active at ${C.brightCyan}http://0.0.0.0:${DASHBOARD_PORT}${C.reset}\n`);
        break;
    }
    case 'help':
    case '--help':
    case '-h':
    default:
        showHelp();
}
