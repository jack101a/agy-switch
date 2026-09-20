import * as fs from 'fs';
import * as https from 'https';
import { execSync, spawn } from 'child_process';
import { AccountManager } from '../managers/accountManager.js';
import {
    ROTATOR_PID_FILE,
    ROTATOR_LOG_FILE,
    DATA_DIR,
    DISCORD_WEBHOOK_URL,
    AGY_BINARY_PATH,
    AGY_PID_FILE,
} from '../constants.js';

// ---------------------------------------------------------------------------
// Adaptive polling tiers (active account Gemini 5h % only)
// ---------------------------------------------------------------------------
function getPollIntervalMs(hourlyPercent: number): number {
    if (hourlyPercent <= 0)  return 0;              // rotate immediately — no sleep
    if (hourlyPercent < 5)   return 30_000;         // < 5%  → 30s
    if (hourlyPercent <= 10) return 60_000;         // 5–10% → 1 min
    if (hourlyPercent <= 30) return 2 * 60_000;     // 10–30% → 2 min
    return 5 * 60_000;                              // > 30%  → 5 min
}

function tierLabel(pct: number): string {
    if (pct <= 0)  return 'EXHAUSTED → rotating';
    if (pct < 5)   return '< 5% — 30s polls';
    if (pct <= 10) return '5-10% — 1 min polls';
    if (pct <= 30) return '10-30% — 2 min polls';
    return '> 30% — 5 min polls';
}

// ---------------------------------------------------------------------------
// Weekly quota refresh TTL — checked infrequently (drains over 7 days)
// ---------------------------------------------------------------------------
function weeklyCheckIntervalMs(weeklyPct: number): number {
    if (weeklyPct <= 0)  return 0;           // exhausted — don't wait, act now
    if (weeklyPct < 5)   return 5 * 60_000; // < 5% → re-check every 5 min
    if (weeklyPct <= 10) return 10 * 60_000;// 5–10% → 10 min
    if (weeklyPct <= 50) return 30 * 60_000;// 10–50% → 30 min
    return 2 * 60 * 60_000;                  // > 50% → 2 hours
}

function weeklyLabel(pct: number): string {
    if (pct <= 0)  return 'weekly EXHAUSTED';
    if (pct < 5)   return `weekly ${pct}% (recheck 5min)`;
    if (pct <= 10) return `weekly ${pct}% (recheck 10min)`;
    if (pct <= 50) return `weekly ${pct}% (recheck 30min)`;
    return `weekly ${pct}% (recheck 2h)`;
}

// ---------------------------------------------------------------------------
// Discord (Style A — orange bar, bold one-liner)
// ---------------------------------------------------------------------------
async function sendDiscord(webhookUrl: string, fromName: string, toName: string): Promise<void> {
    if (!webhookUrl) return;
    return new Promise((resolve) => {
        try {
            const now = new Date().toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
            });
            const payload = JSON.stringify({
                embeds: [{
                    color: 0xFEA832, // orange
                    description: `🔄  **${fromName}** → **${toName}**  (⚡ Quota Rotated · ${now} IST)`,
                }],
            });
            const url = new URL(webhookUrl);
            const req = https.request(
                {
                    hostname: url.hostname,
                    path: url.pathname + url.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                    },
                },
                (res) => { res.resume(); resolve(); },
            );
            req.on('error', () => resolve());
            req.setTimeout(8000, () => { req.destroy(); resolve(); });
            req.write(payload);
            req.end();
        } catch {
            resolve();
        }
    });
}

// ---------------------------------------------------------------------------
// AGY restart
// ---------------------------------------------------------------------------
export class RotatorService {
    // Weekly quota is slow-draining (7-day cycle) — cache it with its own TTL
    private weeklyCache: { pct: number; nextCheckAt: number } | null = null;

    constructor(private accountManager: AccountManager) {}

    private log(message: string): void {
        const ts = new Date().toISOString();
        const line = `[${ts}] ${message}\n`;
        try {
            if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.appendFileSync(ROTATOR_LOG_FILE, line, 'utf-8');
        } catch {}
    }

    private getAgyArgs(): string[] {
        try {
            const p = `${DATA_DIR}/agy-args.json`;
            if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
        } catch {}
        return ['--remote-control', '--hub-port', '4400', '--remote-control-name', 'homeserver-mini'];
    }

    private saveAgyArgs(args: string[]): void {
        try { fs.writeFileSync(`${DATA_DIR}/agy-args.json`, JSON.stringify(args), 'utf-8'); } catch {}
    }

    private findAgyProcess(): { pid: number; args: string[] } | null {
        try {
            const out = execSync(`ps aux | grep '[a]gy --remote-control'`, { encoding: 'utf-8', timeout: 5000 }).trim();
            if (!out) return null;
            const line = out.split('\n')[0];
            const parts = line.trim().split(/\s+/);
            const pid = parseInt(parts[1], 10);
            const cmdStart = line.indexOf(AGY_BINARY_PATH);
            const fullCmd = cmdStart !== -1 ? line.slice(cmdStart + AGY_BINARY_PATH.length).trim() : '';
            const args = fullCmd ? fullCmd.split(/\s+/).filter(Boolean) : this.getAgyArgs();
            return isNaN(pid) ? null : { pid, args };
        } catch { return null; }
    }

    public async restartAgy(): Promise<{ restarted: boolean; newPid?: number; error?: string }> {
        try {
            // Check if systemd user service agy-remote-control is active
            try {
                const isActive = execSync('systemctl --user is-active agy-remote-control.service', {
                    encoding: 'utf-8',
                    timeout: 4000,
                }).trim();
                if (isActive === 'active') {
                    this.log(`[AGY] Restarting via systemctl --user restart agy-remote-control.service...`);
                    execSync('systemctl --user restart agy-remote-control.service', {
                        encoding: 'utf-8',
                        timeout: 10000,
                    });
                    await new Promise((r) => setTimeout(r, 2000));
                    const newProc = this.findAgyProcess();
                    this.log(`[AGY] Restarted via systemd (new PID ${newProc?.pid ?? 'unknown'})`);
                    return { restarted: true, newPid: newProc?.pid };
                }
            } catch (e: any) {
                // systemd service not found or not active; proceed to standalone fallback
            }

            const current = this.findAgyProcess();
            const args = current?.args ?? this.getAgyArgs();
            this.saveAgyArgs(args);

            if (current?.pid) {
                this.log(`[AGY] Sending SIGTERM to PID ${current.pid}`);
                try { process.kill(current.pid, 'SIGTERM'); } catch {}
                for (let i = 0; i < 10; i++) {
                    await new Promise((r) => setTimeout(r, 500));
                    try { process.kill(current.pid, 0); } catch { break; }
                }
            }

            await new Promise((r) => setTimeout(r, 1500));
            this.log(`[AGY] Restarting: ${AGY_BINARY_PATH} ${args.join(' ')}`);
            const child = spawn(AGY_BINARY_PATH, args, { detached: true, stdio: 'ignore', env: process.env });
            child.unref();

            if (child.pid) {
                fs.writeFileSync(AGY_PID_FILE, child.pid.toString(), 'utf-8');
                this.log(`[AGY] Restarted (new PID ${child.pid})`);
                return { restarted: true, newPid: child.pid };
            }
            return { restarted: false, error: 'No PID returned' };
        } catch (e: any) {
            this.log(`[AGY] Restart failed: ${e.message}`);
            return { restarted: false, error: e.message };
        }
    }

    // -------------------------------------------------------------------------
    // Get active account quota
    //  - 5h (hourly): always freshly fetched — drains fast, needs tight polling
    //  - weekly: cached with its own TTL — drains over 7 days, no need to hit
    //            the API every 30s. Re-fetched only when TTL expires.
    // -------------------------------------------------------------------------
    private async getActiveQuota(): Promise<{
        hourly: number;
        weekly: number;
        weeklyFresh: boolean; // true = weekly was just re-fetched this cycle
        name: string;
        email: string;
    } | null> {
        const activeInfo = await this.accountManager.getActiveAccount();
        if (!activeInfo) return null;
        const account = this.accountManager.getAccount(activeInfo.id);
        if (!account) return null;

        // Always refresh to get fresh 5h quota
        try {
            await this.accountManager.refreshQuotaForAccount(account);
        } catch {}
        const q = this.accountManager.getCachedQuota(account.id)?.quota;
        const hourly = q?.geminiHourlyPercent ?? 100;

        // Weekly: use cache unless TTL has expired or no cache yet
        const now = Date.now();
        const weeklyDue = !this.weeklyCache || now >= this.weeklyCache.nextCheckAt;

        let weekly: number;
        let weeklyFresh: boolean;

        if (weeklyDue) {
            // Cache just got refreshed via refreshQuotaForAccount above
            weekly = q?.weeklyPercent ?? 100;
            this.weeklyCache = {
                pct: weekly,
                nextCheckAt: now + weeklyCheckIntervalMs(weekly),
            };
            weeklyFresh = true;
        } else {
            weekly = this.weeklyCache!.pct;
            weeklyFresh = false;
        }

        return { hourly, weekly, weeklyFresh, name: account.name, email: account.email };
    }

    // -------------------------------------------------------------------------
    // select-best CLI command
    // -------------------------------------------------------------------------
    async selectAndActivateOptimal(force = false): Promise<{
        activated: boolean;
        account: any;
        reason: string;
        candidates: any[];
    }> {
        const active = await this.accountManager.getActiveAccount();
        if (active) {
            const current = this.accountManager.getAccount(active.id);
            if (current) {
                try { await this.accountManager.refreshQuotaForAccount(current); } catch {}
                const q = this.accountManager.getCachedQuota(current.id)?.quota;
                const hourlyPercent = q?.geminiHourlyPercent ?? 100;
                const weeklyPercent = q?.weeklyPercent ?? 100;
                const isExhausted = hourlyPercent <= 0 || weeklyPercent <= 0;

                if (!isExhausted && !force) {
                    const { candidates } = await this.accountManager.selectOptimalAccount();
                    return {
                        activated: false,
                        account: current,
                        reason: `Active account ${current.name} still has available quota (5h: ${hourlyPercent}%, weekly: ${weeklyPercent}%). Not switching unless 0%.`,
                        candidates,
                    };
                }
            }
        }

        const { optimal, candidates } = await this.accountManager.selectOptimalAccount();
        if (!optimal) {
            return { activated: false, account: null, reason: 'No accounts registered.', candidates: [] };
        }

        if (active?.id !== optimal.id) {
            await this.accountManager.setActiveAccount(optimal.id);
            const reason = active
                ? `Active account exhausted (0%). Switched to ${optimal.name} (${optimal.email})`
                : `No active account. Activated ${optimal.name} (${optimal.email})`;
            this.log(`[SWITCH] ${reason}`);

            // Restart AGY to pick up new tokens
            const restartResult = await this.restartAgy();
            this.log(`[AGY] ${restartResult.restarted ? `Restarted (PID ${restartResult.newPid})` : `Restart failed: ${restartResult.error}`}`);

            if (DISCORD_WEBHOOK_URL) {
                const prevName = active ? (this.accountManager.getAccount(active.id)?.name || active.email) : 'None';
                await sendDiscord(DISCORD_WEBHOOK_URL, prevName, optimal.name);
                this.log(`[DISCORD] Notification sent`);
            }

            return { activated: true, account: optimal, reason, candidates };
        }

        return { activated: false, account: optimal, reason: `Account ${optimal.email} is already active.`, candidates };
    }

    // -------------------------------------------------------------------------
    // Daemon: adaptive polling on active account only
    // -------------------------------------------------------------------------
    async runDaemon(): Promise<void> {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

        // Save AGY args on startup
        const agyProc = this.findAgyProcess();
        if (agyProc) {
            this.saveAgyArgs(agyProc.args);
            this.log(`[DAEMON] Found AGY (PID ${agyProc.pid}), args saved`);
        }

        if (this.isDaemonRunning()) {
            console.log('Rotator daemon is already running.');
            return;
        }

        fs.writeFileSync(ROTATOR_PID_FILE, process.pid.toString(), 'utf-8');
        this.log(`[DAEMON] Started (PID ${process.pid})`);

        const cleanup = () => {
            try { if (fs.existsSync(ROTATOR_PID_FILE)) fs.unlinkSync(ROTATOR_PID_FILE); } catch {}
            this.log(`[DAEMON] Stopped (PID ${process.pid})`);
            process.exit(0);
        };
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);

        console.log(`⚡ AG Switchboard Auto-Rotator running (PID ${process.pid}) — adaptive polling active`);

        // -----------------------------------------------------------------------
        // Main adaptive loop — checks active account 5h AND weekly quota
        // -----------------------------------------------------------------------
        while (true) {
            try {
                const status = await this.getActiveQuota();

                if (!status) {
                    this.log(`[POLL] No active account — sleeping 60s`);
                    await new Promise((r) => setTimeout(r, 60_000));
                    continue;
                }

                const { hourly, weekly, weeklyFresh, name, email } = status;
                // Use the lower of the two limits to determine poll tier
                const effectivePct = Math.min(hourly, weekly);
                const exhausted = hourly <= 0 || weekly <= 0;

                const exhaustLabel = hourly <= 0 && weekly <= 0
                    ? '5h+weekly EXHAUSTED'
                    : hourly <= 0 ? '5h EXHAUSTED'
                    : weekly <= 0 ? 'weekly EXHAUSTED'
                    : tierLabel(effectivePct);

                const weeklyStr = weeklyFresh
                    ? weeklyLabel(weekly)          // freshly fetched
                    : `weekly ~${weekly}% (cached)`;// served from cache

                this.log(`[POLL] ${name} (${email}) 5h: ${hourly}%  ${weeklyStr} — ${exhaustLabel}`);

                if (exhausted) {
                    // Rotate immediately
                    const res = await this.accountManager.checkAndAutoRotate();
                    if (res.rotated && res.newAccount) {
                        this.log(`[ROTATE] ${res.reason}`);
                        console.log(`[ROTATE] ${res.reason}`);

                        // Restart AGY
                        const restartResult = await this.restartAgy();
                        this.log(`[AGY] ${restartResult.restarted ? `Restarted (PID ${restartResult.newPid})` : `Restart failed: ${restartResult.error}`}`);

                        // Discord notification (Style A)
                        if (DISCORD_WEBHOOK_URL && res.currentAccount) {
                            await sendDiscord(DISCORD_WEBHOOK_URL, res.currentAccount.name, res.newAccount.name);
                            this.log(`[DISCORD] Notification sent`);
                        }

                        // Reset weekly cache — new account has different weekly quota
                        this.weeklyCache = null;

                        // After switching, sleep 5 min (new account has full quota)
                        await new Promise((r) => setTimeout(r, 5 * 60_000));
                    } else {
                        // No switch possible (all accounts exhausted), retry in 60s
                        await new Promise((r) => setTimeout(r, 60_000));
                    }
                } else {
                    const interval = getPollIntervalMs(effectivePct);
                    await new Promise((r) => setTimeout(r, interval));
                }
            } catch (e: any) {
                this.log(`[ERROR] ${e.message}`);
                await new Promise((r) => setTimeout(r, 60_000));
            }
        }
    }

    isDaemonRunning(): boolean {
        if (!fs.existsSync(ROTATOR_PID_FILE)) return false;
        try {
            const pid = parseInt(fs.readFileSync(ROTATOR_PID_FILE, 'utf-8').trim(), 10);
            if (!pid) return false;
            process.kill(pid, 0);
            return true;
        } catch {
            try { fs.unlinkSync(ROTATOR_PID_FILE); } catch {}
            return false;
        }
    }

    stopDaemon(): boolean {
        if (!fs.existsSync(ROTATOR_PID_FILE)) return false;
        try {
            const pid = parseInt(fs.readFileSync(ROTATOR_PID_FILE, 'utf-8').trim(), 10);
            if (pid) process.kill(pid, 'SIGTERM');
            try { fs.unlinkSync(ROTATOR_PID_FILE); } catch {}
            this.log(`[DAEMON] Stopped watcher (PID ${pid})`);
            return true;
        } catch {
            try { fs.unlinkSync(ROTATOR_PID_FILE); } catch {}
            return false;
        }
    }
}
