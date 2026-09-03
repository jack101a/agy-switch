import * as readline from 'readline';
import { AccountManager } from '../managers/accountManager.js';
import { GoogleAuthService } from '../services/googleAuth.js';
import { DASHBOARD_PORT } from '../constants.js';
import {
    C,
    stripAnsi,
    padRight,
    truncate,
    makeProgressBar,
    formatResetCountdown,
    getTopModels,
    getTermWidth,
} from './components.js';
import type { StoredAccount, AccountQuota } from '../types.js';

interface CardClickRegion {
    accountIndex: number;
    startRow: number;
    endRow: number;
}

export class TUIEngine {
    private isRunning = false;
    private selectedIndex = 0;
    private activeId: string | null = null;
    private statusMessage = '';
    private clickRegions: CardClickRegion[] = [];

    constructor(
        private authService: GoogleAuthService,
        private accountManager: AccountManager
    ) {}

    private clearScreen(): void {
        process.stdout.write('\x1b[H\x1b[2J');
    }

    private hideCursor(): void {
        process.stdout.write('\x1b[?25l');
    }

    private showCursor(): void {
        process.stdout.write('\x1b[?25h');
    }

    private enableMouse(): void {
        if (process.stdout.isTTY) {
            process.stdout.write('\x1b[?1000h\x1b[?1006h');
        }
    }

    private disableMouse(): void {
        if (process.stdout.isTTY) {
            process.stdout.write('\x1b[?1000l\x1b[?1006l');
        }
    }

    private renderFrame(): void {
        const width = getTermWidth();
        const isMobile = width < 58;
        const accounts = this.accountManager.getAccounts();
        const cache = this.accountManager.getQuotaCache();
        const lines: string[] = [];

        this.clickRegions = [];

        const add = (line: string = '') => lines.push(line);

        // Header
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (isMobile) {
            add(`${C.gray}╭${'─'.repeat(width - 2)}╮${C.reset}`);
            add(`${C.gray}│${C.reset} ⚡ ${C.bold}${C.brightCyan}AG SWITCHBOARD${C.reset} ${C.dim}${timeStr.padStart(width - 21)}${C.reset} ${C.gray}│${C.reset}`);
            add(`${C.gray}╰${'─'.repeat(width - 2)}╯${C.reset}`);
            if (this.statusMessage) {
                add(` ${this.statusMessage}`);
                add(`${C.gray}${'─'.repeat(width)}${C.reset}`);
            }
        } else {
            add(`${C.gray}╭${'─'.repeat(width - 2)}╮${C.reset}`);
            const headerTitle = ` ⚡ ${C.bold}${C.white}AG SWITCHBOARD${C.reset} ${C.gray}— Multi-Account AI Quota Controller${C.reset}`;
            const clock = `${C.dim}${timeStr}${C.reset}`;
            add(`${C.gray}│${C.reset}${padRight(headerTitle, width - 12)}${clock} ${C.gray}│${C.reset}`);
            add(`${C.gray}├${'─'.repeat(width - 2)}┤${C.reset}`);
            const statusRow = ` ${this.statusMessage || `${C.gray}Select account to activate • Press [a] to add, [d] to remove${C.reset}`}`;
            add(`${C.gray}│${C.reset}${padRight(statusRow, width - 2)}${C.gray}│${C.reset}`);
            add(`${C.gray}╰${'─'.repeat(width - 2)}╯${C.reset}`);
        }

        if (accounts.length === 0) {
            add(`\n  ${C.yellow}No accounts connected.${C.reset}`);
            add(`  Press ${C.bold}${C.brightGreen}[a]${C.reset} now to connect a Google account.\n`);
        }

        // Account Cards
        accounts.forEach((acc, idx) => {
            const startRow = lines.length + 1;
            const isActive = acc.id === this.activeId;
            const isCursor = idx === this.selectedIndex;
            const cached = cache.get(acc.id);
            const quota = cached?.quota;
            const tier = quota?.tierName || 'Standard';
            const models = getTopModels(quota, isMobile ? 2 : 3);
            const quickKey = idx < 9 ? `${idx + 1}` : '';

            if (isMobile) {
                const cardBorder = isActive ? C.brightGreen : (isCursor ? C.brightCyan : C.gray);
                const boxChar = isActive ? '━' : '─';

                add(`${cardBorder}${boxChar.repeat(width)}${C.reset}`);

                if (isActive) {
                    const keyBadge = quickKey ? `[${quickKey}] ` : '';
                    add(`${C.bgGreen}${C.bold}${C.white} ★ ACTIVE ACCOUNT ${C.reset} ${C.bold}${C.brightGreen}${keyBadge}${acc.name}${C.reset}`);
                } else if (isCursor) {
                    const keyBadge = quickKey ? `[${quickKey}] ` : '';
                    add(`${C.brightCyan}▶ [SELECTED]${C.reset} ${C.bold}${keyBadge}${acc.name}${C.reset} ${C.dim}(${tier})${C.reset}`);
                } else {
                    const keyBadge = quickKey ? `${C.dim}[${quickKey}]${C.reset} ` : '';
                    add(`  ${keyBadge}${C.bold}${acc.name}${C.reset} ${C.dim}(${tier})${C.reset}`);
                }

                add(`  ${C.dim}${truncate(acc.email, width - 4)}${C.reset}`);

                if (isCursor && !isActive) {
                    add(`  ${C.inverse}${C.bold}${C.brightCyan} [ Press ${quickKey ? quickKey + ' or ' : ''}ENTER to Activate ] ${C.reset}`);
                }

                add(`  ${C.gray}┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄${C.reset}`);

                if (models.length > 0) {
                    for (const m of models) {
                        const barStr = makeProgressBar(m.usedPercent, Math.max(6, Math.floor(width * 0.22)));
                        const countdownStr = formatResetCountdown(m.resetAt, true);
                        const nameStr = truncate(m.displayName, Math.max(14, Math.floor(width * 0.38)));

                        add(`  ${C.white}${nameStr.padEnd(16)}${C.reset} ${barStr}`);
                        add(`  ${C.gray}↳ Resets ${countdownStr}`);
                    }
                } else {
                    add(`  ${C.dim}Fetching quota details...${C.reset}`);
                }

                add('');
            } else {
                // Desktop Wide
                const cardColor = isActive ? C.brightGreen : (isCursor ? C.brightCyan : C.gray);
                const boxChar = isActive ? '━' : '─';

                add(`${cardColor}╭${boxChar.repeat(width - 2)}╮${C.reset}`);

                let topBanner = '';
                const keyBadge = quickKey ? `[${quickKey}] ` : '';

                if (isActive) {
                    topBanner = ` ${C.bgGreen}${C.bold}${C.white} ★ ACTIVE ACCOUNT ★ ${C.reset}  ${C.bold}${C.brightGreen}${keyBadge}${acc.name}${C.reset} ${C.gray}(${acc.email})${C.reset}  ${C.dim}[${tier}]${C.reset}`;
                } else if (isCursor) {
                    topBanner = ` ${C.bgCyan}${C.bold}${C.white} ▶ SELECTED ${C.reset}  ${C.bold}${keyBadge}${acc.name}${C.reset} ${C.gray}(${acc.email})${C.reset}  ${C.dim}[${tier}]${C.reset}  ${C.inverse} [Press ${quickKey ? quickKey + '/' : ''}ENTER to Switch] ${C.reset}`;
                } else {
                    topBanner = `   ${C.dim}${keyBadge}${C.reset}${C.bold}${acc.name}${C.reset} ${C.gray}(${acc.email})${C.reset}  ${C.dim}[${tier}]${C.reset}`;
                }

                add(`${cardColor}│${C.reset}${padRight(topBanner, width - 2)}${cardColor}│${C.reset}`);
                add(`${cardColor}├${'┄'.repeat(width - 2)}┤${C.reset}`);

                if (models.length > 0) {
                    for (const m of models) {
                        const barStr = makeProgressBar(m.usedPercent, 12);
                        const countdownStr = formatResetCountdown(m.resetAt, false);
                        const nameStr = m.displayName.padEnd(20);

                        const modelRow = `   ${C.white}${nameStr}${C.reset} ${barStr}   ${C.gray}Resets: ${countdownStr}`;
                        add(`${cardColor}│${C.reset}${padRight(modelRow, width - 2)}${cardColor}│${C.reset}`);
                    }
                } else {
                    const loadingRow = `   ${C.dim}Fetching quota details...${C.reset}`;
                    add(`${cardColor}│${C.reset}${padRight(loadingRow, width - 2)}${cardColor}│${C.reset}`);
                }

                add(`${cardColor}╰${boxChar.repeat(width - 2)}╯${C.reset}`);
            }

            const endRow = lines.length;
            this.clickRegions.push({ accountIndex: idx, startRow, endRow });
        });

        // Navigation Footer
        if (isMobile) {
            add(`${C.gray}${'═'.repeat(width)}${C.reset}`);
            add(`${C.bold}[1-9]${C.reset}:Switch  ${C.bold}[a]${C.reset}:Add  ${C.bold}[d]${C.reset}:Remove  ${C.bold}[r]${C.reset}:Refresh  ${C.bold}[q]${C.reset}:Quit`);
        } else {
            add(`${C.gray}╭${'─'.repeat(width - 2)}╮${C.reset}`);
            const navRow = `  ${C.bold}[1-9]${C.reset} Quick Switch   ${C.bold}[a]${C.reset} Add Account   ${C.bold}[d]${C.reset} Remove Account   ${C.bold}[r]${C.reset} Refresh   ${C.bold}[w]${C.reset} Web Dashboard   ${C.bold}[q]${C.reset} Exit`;
            add(`${C.gray}│${C.reset}${padRight(navRow, width - 2)}${C.gray}│${C.reset}`);
            add(`${C.gray}╰${'─'.repeat(width - 2)}╯${C.reset}`);
        }

        // Single atomic write to stdout
        process.stdout.write('\x1b[H' + lines.join('\n') + '\n');
    }

    private async promptAddAccount(): Promise<void> {
        this.disableMouse();
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        this.showCursor();
        this.clearScreen();

        console.log(`\n${C.bold}${C.brightCyan}⚡ Connect New Google Account${C.reset}\n`);
        const session = this.authService.createOAuthSession();

        console.log(`${C.bold}1.${C.reset} Open this URL in your browser:`);
        console.log(`   ${C.brightCyan}${session.authUrl}${C.reset}\n`);
        console.log(`${C.bold}2.${C.reset} Sign in with Google and grant access.`);
        console.log(`${C.bold}3.${C.reset} Copy the full redirect URL (or auth code) and paste below:\n`);

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

        return new Promise<void>((resolve) => {
            rl.question(`${C.bold}Paste redirect URL or code (or Enter to cancel): ${C.reset}`, async (input) => {
                rl.close();
                const raw = input.trim();
                if (!raw) {
                    this.statusMessage = `${C.yellow}Cancelled account addition.${C.reset}`;
                } else {
                    try {
                        console.log(`\nConnecting account...`);
                        const res = await this.authService.completeOAuthWithCode(raw, session.state);
                        const acc = await this.accountManager.addAccountWithTokens(
                            { accessToken: res.accessToken, refreshToken: res.refreshToken, expiryTimestamp: res.expiryTimestamp },
                            { email: res.email, name: res.name }
                        );
                        this.selectedIndex = Math.max(0, this.accountManager.getAccounts().length - 1);
                        this.activeId = acc.id;
                        this.statusMessage = `${C.brightGreen}✔ Connected & Activated: ${acc.name}${C.reset}`;
                    } catch (e: any) {
                        this.statusMessage = `${C.red}❌ Connection failed: ${e.message}${C.reset}`;
                    }
                }
                this.clearScreen();
                this.hideCursor();
                this.enableMouse();
                if (process.stdin.isTTY) {
                    process.stdin.setRawMode(true);
                    process.stdin.resume();
                }
                this.renderFrame();
                resolve();
            });
        });
    }

    private async promptRemoveAccount(): Promise<void> {
        const accounts = this.accountManager.getAccounts();
        const target = accounts[this.selectedIndex];
        if (!target) return;

        this.disableMouse();
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        this.showCursor();
        this.clearScreen();

        console.log(`\n${C.bold}${C.red}⚠️ Disconnect Account${C.reset}\n`);
        console.log(`Are you sure you want to disconnect:`);
        console.log(`  ${C.bold}${target.name}${C.reset} (${target.email})\n`);

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

        return new Promise<void>((resolve) => {
            rl.question(`${C.bold}Type 'y' to confirm, or Enter to cancel: ${C.reset}`, async (ans) => {
                rl.close();
                if (ans.trim().toLowerCase() === 'y') {
                    await this.accountManager.removeAccount(target.id);
                    const remaining = this.accountManager.getAccounts();
                    const active = await this.accountManager.getActiveAccount();
                    this.activeId = active?.id ?? null;
                    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, remaining.length - 1));
                    this.statusMessage = `${C.yellow}Account ${target.name} removed.${C.reset}`;
                } else {
                    this.statusMessage = `${C.yellow}Cancelled removal.${C.reset}`;
                }
                this.clearScreen();
                this.hideCursor();
                this.enableMouse();
                if (process.stdin.isTTY) {
                    process.stdin.setRawMode(true);
                    process.stdin.resume();
                }
                this.renderFrame();
                resolve();
            });
        });
    }

    public async start(): Promise<void> {
        const accounts = this.accountManager.getAccounts();
        const active = await this.accountManager.getActiveAccount();
        this.activeId = active?.id ?? null;
        this.selectedIndex = accounts.findIndex((a) => a.id === this.activeId);
        if (this.selectedIndex < 0) this.selectedIndex = 0;

        this.isRunning = true;

        const restoreTerminal = () => {
            try {
                if (process.stdout.isTTY) {
                    process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?25h');
                }
                if (process.stdin.isTTY) {
                    process.stdin.setRawMode(false);
                }
            } catch {}
        };

        return new Promise<void>((resolve) => {
            const stopAndExit = () => {
                this.isRunning = false;
                process.stdout.removeListener('resize', onResize);
                restoreTerminal();
                console.log('');
                resolve();
                process.exit(0);
            };

            process.on('exit', restoreTerminal);
            process.on('uncaughtException', (err) => {
                restoreTerminal();
                console.error(err);
                process.exit(1);
            });
            process.on('unhandledRejection', (err) => {
                console.error('Unhandled rejection:', err);
            });

            this.clearScreen();
            this.hideCursor();
            this.enableMouse();
            this.statusMessage = `${C.gray}Fetching latest quotas from cloud...${C.reset}`;
            this.renderFrame();

            // Background live quota sync
            this.accountManager.refreshAllQuotas().then(() => {
                this.statusMessage = `${C.brightGreen}✔ Quotas up to date (${new Date().toLocaleTimeString()})${C.reset}`;
                if (this.isRunning) this.renderFrame();
            }).catch(() => {
                this.statusMessage = `${C.yellow}Could not refresh cloud quotas${C.reset}`;
                if (this.isRunning) this.renderFrame();
            });

            // Resize handler (SIGWINCH)
            const onResize = () => {
                if (this.isRunning) {
                    this.clearScreen();
                    this.renderFrame();
                }
            };
            process.stdout.on('resize', onResize);

            // Input setup
            readline.emitKeypressEvents(process.stdin);
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(true);
                process.stdin.resume();
            }

            process.stdin.on('data', async (chunk) => {
                try {
                    const str = chunk.toString();

                    // SGR Mouse Click Event: \x1b[<0;x;yM
                    const mouseMatch = str.match(/\x1b\[<0;(\d+);(\d+)M/);
                    if (mouseMatch) {
                        const clickY = parseInt(mouseMatch[2], 10);
                        const hit = this.clickRegions.find((r) => clickY >= r.startRow && clickY <= r.endRow);
                        if (hit !== undefined) {
                            this.selectedIndex = hit.accountIndex;
                            const accs = this.accountManager.getAccounts();
                            const chosen = accs[this.selectedIndex];
                            if (chosen) {
                                await this.accountManager.setActiveAccount(chosen.id);
                                this.activeId = chosen.id;
                                this.statusMessage = `${C.bgGreen}${C.bold}${C.white} ✔ ACTIVATED: ${chosen.name} (${chosen.email}) ${C.reset}`;
                                this.renderFrame();
                            }
                            return;
                        }
                    }
                } catch (e: any) {
                    this.statusMessage = `${C.red}Error: ${e.message}${C.reset}`;
                    if (this.isRunning) this.renderFrame();
                }
            });

            process.stdin.on('keypress', async (str, key) => {
                if (!this.isRunning) return;

                // Ignore mouse escape sequences leaking into keypress
                if (key?.sequence?.startsWith('\x1b[<') || key?.sequence?.startsWith('\x1b[M')) {
                    return;
                }

                try {
                    const accs = this.accountManager.getAccounts();

                    // Direct numeric quick-switch [1-9]
                    if (str && str >= '1' && str <= '9') {
                        const num = parseInt(str, 10);
                        if (num <= accs.length) {
                            this.selectedIndex = num - 1;
                            const chosen = accs[this.selectedIndex];
                            await this.accountManager.setActiveAccount(chosen.id);
                            this.activeId = chosen.id;
                            this.statusMessage = `${C.bgGreen}${C.bold}${C.white} ✔ ACTIVATED: ${chosen.name} (${chosen.email}) ${C.reset}`;
                            this.renderFrame();
                            return;
                        }
                    }

                    if (key?.name === 'up' || key?.name === 'k') {
                        this.selectedIndex = (this.selectedIndex - 1 + accs.length) % accs.length;
                    } else if (key?.name === 'down' || key?.name === 'j') {
                        this.selectedIndex = (this.selectedIndex + 1) % accs.length;
                    } else if (key?.name === 'return' || key?.name === 'space') {
                        const chosen = accs[this.selectedIndex];
                        if (chosen) {
                            await this.accountManager.setActiveAccount(chosen.id);
                            this.activeId = chosen.id;
                            this.statusMessage = `${C.bgGreen}${C.bold}${C.white} ✔ ACTIVATED: ${chosen.name} (${chosen.email}) ${C.reset}`;
                        }
                    } else if (str === 'a' || str === 'A') {
                        await this.promptAddAccount();
                        return;
                    } else if (str === 'd' || str === 'D' || str === 'x' || str === 'X') {
                        await this.promptRemoveAccount();
                        return;
                    } else if (str === 'r' || str === 'R') {
                        this.statusMessage = `${C.brightYellow}🔄 Refreshing quotas from Google Cloud...${C.reset}`;
                        this.renderFrame();

                        this.accountManager.refreshAllQuotas().then(() => {
                            this.statusMessage = `${C.brightGreen}✔ Refreshed at ${new Date().toLocaleTimeString()}${C.reset}`;
                            if (this.isRunning) this.renderFrame();
                        }).catch(() => {
                            this.statusMessage = `${C.red}❌ Refresh failed${C.reset}`;
                            if (this.isRunning) this.renderFrame();
                        });
                        return;
                    } else if (str === 'w' || str === 'W') {
                        this.statusMessage = `${C.brightCyan}Web dashboard running on http://0.0.0.0:${DASHBOARD_PORT}${C.reset}`;
                        const { spawn } = await import('child_process');
                        const child = spawn('node', [
                            new URL('../dashboard-server.js', import.meta.url).pathname
                        ], { detached: true, stdio: 'ignore' });
                        child.unref();
                    } else if (str === 'q' || str === 'Q' || (key?.ctrl && (str === 'c' || key?.name === 'c'))) {
                        stopAndExit();
                        return;
                    }

                    this.renderFrame();
                } catch (err: any) {
                    this.statusMessage = `${C.red}Error: ${err.message}${C.reset}`;
                    if (this.isRunning) this.renderFrame();
                }
            });

            process.on('SIGINT', stopAndExit);
            process.on('SIGTERM', stopAndExit);
        });
    }
}
