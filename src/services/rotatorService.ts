import * as fs from 'fs';
import * as https from 'https';
import { execSync, spawn } from 'child_process';
import { AccountManager } from '../managers/accountManager.js';
import {
    ROTATOR_PID_FILE,
    ROTATOR_LOG_FILE,
    ROTATOR_CHECK_INTERVAL_MS,
    DATA_DIR,
    DISCORD_WEBHOOK_URL,
    AGY_BINARY_PATH,
    AGY_PID_FILE,
} from '../constants.js';

export class RotatorService {
    constructor(private accountManager: AccountManager) {}

    private log(message: string): void {
        const timestamp = new Date().toISOString();
        const line = `[${timestamp}] ${message}\n`;
        try {
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }
            fs.appendFileSync(ROTATOR_LOG_FILE, line, 'utf-8');
        } catch {}
    }

    // -------------------------------------------------------------------------
    // Discord Notification
    // -------------------------------------------------------------------------

    private async sendDiscordNotification(message: string): Promise<void> {
        if (!DISCORD_WEBHOOK_URL) return;
        return new Promise((resolve) => {
            try {
                const body = JSON.stringify({ content: message });
                const url = new URL(DISCORD_WEBHOOK_URL);
                const req = https.request(
                    {
                        hostname: url.hostname,
                        path: url.pathname + url.search,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(body),
                        },
                    },
                    (res) => {
                        res.resume();
                        resolve();
                    },
                );
                req.on('error', () => resolve());
                req.setTimeout(8000, () => { req.destroy(); resolve(); });
                req.write(body);
                req.end();
            } catch {
                resolve();
            }
        });
    }

    // -------------------------------------------------------------------------
    // AGY Daemon Restart
    // -------------------------------------------------------------------------

    private getAgyArgs(): string[] {
        try {
            // Read the saved AGY command-line args from when we first saw it running
            const savedPath = `${DATA_DIR}/agy-args.json`;
            if (fs.existsSync(savedPath)) {
                return JSON.parse(fs.readFileSync(savedPath, 'utf-8'));
            }
        } catch {}
        // Fallback to default args
        return ['--remote-control', '--hub-port', '4400', '--remote-control-name', 'homeserver-mini'];
    }

    private saveAgyArgs(args: string[]): void {
        try {
            fs.writeFileSync(`${DATA_DIR}/agy-args.json`, JSON.stringify(args), 'utf-8');
        } catch {}
    }

    private findAgyProcess(): { pid: number; args: string[] } | null {
        try {
            const out = execSync(
                `ps aux | grep '[a]gy --remote-control'`,
                { encoding: 'utf-8', timeout: 5000 },
            ).trim();
            if (!out) return null;
            const line = out.split('\n')[0];
            const parts = line.trim().split(/\s+/);
            const pid = parseInt(parts[1], 10);
            // Extract args after the binary name
            const cmdStart = line.indexOf(AGY_BINARY_PATH);
            const fullCmd = cmdStart !== -1 ? line.slice(cmdStart + AGY_BINARY_PATH.length).trim() : '';
            const args = fullCmd ? fullCmd.split(/\s+/).filter(Boolean) : this.getAgyArgs();
            return isNaN(pid) ? null : { pid, args };
        } catch {
            return null;
        }
    }

    private async restartAgy(): Promise<{ restarted: boolean; newPid?: number; error?: string }> {
        try {
            // Find current AGY process and save its args
            const current = this.findAgyProcess();
            const args = current?.args ?? this.getAgyArgs();
            this.saveAgyArgs(args);

            if (current?.pid) {
                this.log(`[AGY] Sending SIGTERM to AGY process (PID ${current.pid})...`);
                try {
                    process.kill(current.pid, 'SIGTERM');
                } catch {}
                // Wait for process to die (up to 5s)
                for (let i = 0; i < 10; i++) {
                    await new Promise((r) => setTimeout(r, 500));
                    try { process.kill(current.pid, 0); } catch { break; } // dead
                }
            }

            // Small buffer before restart
            await new Promise((r) => setTimeout(r, 1500));

            // Restart AGY with same args
            this.log(`[AGY] Restarting: ${AGY_BINARY_PATH} ${args.join(' ')}`);
            const child = spawn(AGY_BINARY_PATH, args, {
                detached: true,
                stdio: 'ignore',
                env: process.env,
            });
            child.unref();

            // Save new PID
            if (child.pid) {
                fs.writeFileSync(AGY_PID_FILE, child.pid.toString(), 'utf-8');
                this.log(`[AGY] Restarted successfully (new PID ${child.pid})`);
                return { restarted: true, newPid: child.pid };
            }

            return { restarted: false, error: 'Failed to get new PID from spawned process' };
        } catch (e: any) {
            this.log(`[AGY] Restart failed: ${e.message}`);
            return { restarted: false, error: e.message };
        }
    }

    // -------------------------------------------------------------------------
    // Core: Select & Activate Optimal (used by `agy-auth select-best`)
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
                try {
                    await this.accountManager.refreshQuotaForAccount(current);
                } catch {}
                const q = this.accountManager.getCachedQuota(current.id)?.quota;
                const hourlyPercent = q?.geminiHourlyPercent ?? 100;
                const weeklyPercent = q?.weeklyPercent ?? 100;
                const isExhausted = hourlyPercent <= 0 || weeklyPercent <= 0;

                // STRICT RULE: Keep active account as long as it has available quota (>0%).
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
            return {
                activated: false,
                account: null,
                reason: 'No accounts registered.',
                candidates: [],
            };
        }

        if (active?.id !== optimal.id) {
            await this.accountManager.setActiveAccount(optimal.id);
            const reason = active
                ? `Active account exhausted (0%). Switched to ${optimal.name} (${optimal.email}) [nearest weekly expiry: ${optimal.weeklyExpiry || 'N/A'}]`
                : `No active account. Activated ${optimal.name} (${optimal.email}) [nearest weekly expiry: ${optimal.weeklyExpiry || 'N/A'}]`;
            this.log(`[SWITCH] ${reason}`);
            return {
                activated: true,
                account: optimal,
                reason,
                candidates,
            };
        }

        return {
            activated: false,
            account: optimal,
            reason: `Account ${optimal.email} is already active.`,
            candidates,
        };
    }

    // -------------------------------------------------------------------------
    // Core: After-switch actions — restart AGY + Discord notification
    // -------------------------------------------------------------------------

    private async onAccountSwitched(
        fromAccount: { name: string; email: string } | null,
        toAccount: { name: string; email: string },
        reason: string,
    ): Promise<void> {
        const fromLabel = fromAccount ? `**${fromAccount.name}** (\`${fromAccount.email}\`)` : '`none`';
        const toLabel = `**${toAccount.name}** (\`${toAccount.email}\`)`;
        const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });

        // 1. Restart AGY so it picks up the new token
        this.log(`[AGY] Restarting AGY to apply new account token...`);
        const restartResult = await this.restartAgy();
        const restartStatus = restartResult.restarted
            ? `✅ AGY restarted (PID ${restartResult.newPid})`
            : `⚠️ AGY restart failed: ${restartResult.error}`;

        this.log(`[AGY] ${restartStatus}`);

        // 2. Send Discord notification
        const discordMsg = [
            `🔄 **AG Switchboard — Account Rotated**`,
            ``,
            `**From:** ${fromLabel}`,
            `**To:** ${toLabel}`,
            `**Reason:** ${reason}`,
            `**AGY:** ${restartStatus}`,
            `**Time:** ${now} IST`,
        ].join('\n');

        await this.sendDiscordNotification(discordMsg);
        this.log(`[DISCORD] Notification sent`);
    }

    // -------------------------------------------------------------------------
    // Daemon
    // -------------------------------------------------------------------------

    async runDaemon(): Promise<void> {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }

        // Save current AGY args on startup so we can restart it later
        const agyProc = this.findAgyProcess();
        if (agyProc) {
            this.saveAgyArgs(agyProc.args);
            this.log(`[DAEMON] Found AGY process (PID ${agyProc.pid}), saved args: ${agyProc.args.join(' ')}`);
        }

        // Check if already running
        if (this.isDaemonRunning()) {
            console.log('Rotator daemon is already running.');
            return;
        }

        // Write PID
        fs.writeFileSync(ROTATOR_PID_FILE, process.pid.toString(), 'utf-8');
        this.log(`[DAEMON] Watcher daemon started (PID ${process.pid})`);

        const cleanup = () => {
            try {
                if (fs.existsSync(ROTATOR_PID_FILE)) {
                    fs.unlinkSync(ROTATOR_PID_FILE);
                }
            } catch {}
            this.log(`[DAEMON] Watcher daemon stopped (PID ${process.pid})`);
            process.exit(0);
        };

        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);

        console.log(`⚡ AG Switchboard Auto-Rotator running in background (PID ${process.pid})`);

        // Check immediately on start
        try {
            const res = await this.accountManager.checkAndAutoRotate();
            if (res.rotated && res.newAccount) {
                this.log(`[ROTATE] ${res.reason}`);
                console.log(`[ROTATE] ${res.reason}`);
                await this.onAccountSwitched(res.currentAccount, res.newAccount, res.reason);
            }
        } catch (e: any) {
            this.log(`[ERROR] Check failed: ${e.message}`);
        }

        // Polling loop (checks every 60 seconds)
        while (true) {
            await new Promise((resolve) => setTimeout(resolve, ROTATOR_CHECK_INTERVAL_MS));
            try {
                const res = await this.accountManager.checkAndAutoRotate();
                if (res.rotated && res.newAccount) {
                    this.log(`[ROTATE] ${res.reason}`);
                    console.log(`[ROTATE] ${res.reason}`);
                    await this.onAccountSwitched(res.currentAccount, res.newAccount, res.reason);
                }
            } catch (e: any) {
                this.log(`[ERROR] Check failed: ${e.message}`);
            }
        }
    }

    isDaemonRunning(): boolean {
        if (!fs.existsSync(ROTATOR_PID_FILE)) {
            return false;
        }
        try {
            const pidStr = fs.readFileSync(ROTATOR_PID_FILE, 'utf-8').trim();
            const pid = parseInt(pidStr, 10);
            if (!pid) return false;
            process.kill(pid, 0);
            return true;
        } catch {
            try {
                fs.unlinkSync(ROTATOR_PID_FILE);
            } catch {}
            return false;
        }
    }

    stopDaemon(): boolean {
        if (!fs.existsSync(ROTATOR_PID_FILE)) {
            return false;
        }
        try {
            const pidStr = fs.readFileSync(ROTATOR_PID_FILE, 'utf-8').trim();
            const pid = parseInt(pidStr, 10);
            if (pid) {
                process.kill(pid, 'SIGTERM');
            }
            try {
                fs.unlinkSync(ROTATOR_PID_FILE);
            } catch {}
            this.log(`[DAEMON] Stopped watcher daemon (PID ${pid})`);
            return true;
        } catch {
            try {
                fs.unlinkSync(ROTATOR_PID_FILE);
            } catch {}
            return false;
        }
    }
}
