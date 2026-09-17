import * as fs from 'fs';
import { AccountManager } from '../managers/accountManager.js';
import {
    ROTATOR_PID_FILE,
    ROTATOR_LOG_FILE,
    ROTATOR_CHECK_INTERVAL_MS,
    DATA_DIR,
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
                // Do not auto-switch unless active account reaches 0% or switch is explicitly forced.
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

    async runDaemon(): Promise<void> {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
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
            if (res.rotated) {
                this.log(`[ROTATE] ${res.reason}`);
                console.log(`[ROTATE] ${res.reason}`);
            }
        } catch (e: any) {
            this.log(`[ERROR] Check failed: ${e.message}`);
        }

        // Polling loop (checks every 60 seconds)
        while (true) {
            await new Promise((resolve) => setTimeout(resolve, ROTATOR_CHECK_INTERVAL_MS));
            try {
                const res = await this.accountManager.checkAndAutoRotate();
                if (res.rotated) {
                    this.log(`[ROTATE] ${res.reason}`);
                    console.log(`[ROTATE] ${res.reason}`);
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
            // Check if process exists by sending signal 0
            process.kill(pid, 0);
            return true;
        } catch {
            // Process doesn't exist; remove stale PID file
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
