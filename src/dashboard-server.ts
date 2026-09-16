import express from 'express';
import { AccountManager } from './managers/accountManager.js';
import { GoogleAuthService } from './services/googleAuth.js';
import { QuotaApiService } from './services/quotaApi.js';
import { DASHBOARD_PORT } from './constants.js';
import { parseWeeklyDate } from './tui/components.js';

const authService = new GoogleAuthService();
const quotaApi = new QuotaApiService();
const accountManager = new AccountManager(authService, quotaApi);

const app = express();
app.use(express.json());

// Initialize AccountManager
await accountManager.initialize();

// REST Endpoints
app.get('/api/accounts', async (_req, res) => {
    try {
        const accounts = accountManager.getAccounts();
        const active = await accountManager.getActiveAccount();
        const cache = accountManager.getQuotaCache();

        const data = accounts.map((acc) => ({
            id: acc.id,
            email: acc.email,
            name: acc.name,
            addedAt: acc.addedAt,
            weeklyExpiry: acc.weeklyExpiry || null,
            effectiveWeeklyExpiry: accountManager.getEffectiveWeeklyExpiryForAccount(acc),
            isActive: active?.id === acc.id,
            quota: cache.get(acc.id) || null,
        }));

        res.json({ success: true, accounts: data, activeId: active?.id || null });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/accounts/:id/quota', async (req, res) => {
    try {
        const account = accountManager.getAccount(req.params.id);
        if (!account) {
            return res.status(404).json({ success: false, error: 'Account not found' });
        }
        const quota = await accountManager.refreshQuotaForAccount(account);
        res.json({ success: true, quota });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/accounts/:id/activate', async (req, res) => {
    try {
        const ok = await accountManager.setActiveAccount(req.params.id);
        if (!ok) {
            return res.status(404).json({ success: false, error: 'Account not found' });
        }
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/accounts/:id/weekly', async (req, res) => {
    try {
        const { weeklyExpiry } = req.body;
        let dateIso: string | null = null;
        if (weeklyExpiry && !['clear', 'reset', 'none', 'remove'].includes(weeklyExpiry.toLowerCase())) {
            dateIso = parseWeeklyDate(weeklyExpiry);
            if (!dateIso) {
                return res.status(400).json({ success: false, error: 'Could not parse date format.' });
            }
        }
        const ok = await accountManager.setWeeklyExpiry(req.params.id, dateIso);
        if (!ok) {
            return res.status(404).json({ success: false, error: 'Account not found' });
        }
        res.json({ success: true, weeklyExpiry: dateIso });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/accounts/:id', async (req, res) => {
    try {
        await accountManager.removeAccount(req.params.id);
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/refresh', async (_req, res) => {
    try {
        const results = await accountManager.refreshAllQuotas();
        res.json({ success: true, results });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// OAuth Session endpoint - returns direct URL for mobile/web
app.get('/api/auth-url', (_req, res) => {
    try {
        const session = authService.createOAuthSession();
        res.json({
            success: true,
            authUrl: session.authUrl,
            state: session.state,
        });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Complete OAuth with pasted URL or Code
app.post('/api/auth-complete', async (req, res) => {
    try {
        const { code, state } = req.body;
        if (!code) {
            return res.status(400).json({ success: false, error: 'Authorization code or URL is required' });
        }

        const oauthResult = await authService.completeOAuthWithCode(code, state);

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

        // Fetch initial quota in background
        accountManager.refreshQuotaForAccount(account).catch(console.error);

        res.json({
            success: true,
            account: {
                id: account.id,
                email: account.email,
                name: account.name,
            },
        });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// HTML Dashboard UI
app.get('/', (_req, res) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>AG Multi-Account Switchboard</title>
    <style>
        :root {
            --bg: #090d16;
            --card-bg: #131b2e;
            --card-border: #1e293b;
            --active-border: #3b82f6;
            --text-primary: #f8fafc;
            --text-secondary: #94a3b8;
            --text-muted: #64748b;
            --accent: #6366f1;
            --success: #10b981;
            --warning: #f59e0b;
            --danger: #ef4444;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
        body { background: var(--bg); color: var(--text-primary); min-height: 100vh; padding: 1.5rem 1rem; }
        .container { max-width: 960px; margin: 0 auto; }
        header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 2rem; border-bottom: 1px solid var(--card-border); padding-bottom: 1.5rem; }
        .logo-group { display: flex; align-items: center; gap: 0.75rem; }
        .logo-icon { width: 38px; height: 38px; background: linear-gradient(135deg, #6366f1, #a855f7); border-radius: 10px; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 1.25rem; box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3); }
        h1 { font-size: 1.4rem; font-weight: 700; letter-spacing: -0.025em; }
        .subtitle { font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.15rem; }
        .actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
        button { cursor: pointer; border: none; border-radius: 8px; padding: 0.6rem 1rem; font-size: 0.875rem; font-weight: 500; transition: all 0.2s; display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; }
        .btn-primary { background: var(--accent); color: white; box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3); }
        .btn-primary:hover { background: #4f46e5; }
        .btn-secondary { background: #1e293b; color: var(--text-primary); border: 1px solid #334155; }
        .btn-secondary:hover { background: #334155; }
        .btn-success { background: #059669; color: white; }
        .btn-success:hover { background: #047857; }
        .btn-danger { background: rgba(239, 68, 68, 0.12); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.25); }
        .btn-danger:hover { background: rgba(239, 68, 68, 0.25); }
        .grid { display: grid; gap: 1.25rem; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); }
        @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } header { flex-direction: column; align-items: stretch; } .actions { justify-content: space-between; } }
        .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 14px; padding: 1.25rem; transition: transform 0.2s, border-color 0.2s; position: relative; }
        .card.active { border-color: var(--active-border); box-shadow: 0 0 0 1px var(--active-border), 0 8px 24px -8px rgba(59, 130, 246, 0.25); }
        .card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1rem; }
        .account-info { display: flex; flex-direction: column; gap: 0.2rem; }
        .account-name { font-weight: 600; font-size: 1.05rem; }
        .account-email { color: var(--text-secondary); font-size: 0.8rem; word-break: break-all; }
        .badge-group { display: flex; gap: 0.4rem; align-items: center; }
        .badge { padding: 0.2rem 0.5rem; border-radius: 9999px; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
        .badge-active { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); }
        .badge-tier { background: rgba(99, 102, 241, 0.2); color: #818cf8; border: 1px solid rgba(99, 102, 241, 0.4); }
        .quota-list { display: flex; flex-direction: column; gap: 0.85rem; margin: 1rem 0; }
        .quota-item { display: flex; flex-direction: column; gap: 0.3rem; }
        .quota-label-row { display: flex; justify-content: space-between; font-size: 0.8rem; }
        .model-name { color: var(--text-primary); font-weight: 500; }
        .quota-meta { color: var(--text-muted); font-size: 0.75rem; }
        .progress-bar-bg { width: 100%; height: 7px; background: #1e293b; border-radius: 4px; overflow: hidden; }
        .progress-bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s ease; }
        .fill-green { background: var(--success); }
        .fill-yellow { background: var(--warning); }
        .fill-red { background: var(--danger); }
        .card-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 1.25rem; padding-top: 0.85rem; border-top: 1px solid #1e293b; }
        .empty-state { text-align: center; padding: 3.5rem 1.5rem; background: var(--card-bg); border-radius: 14px; border: 1px dashed var(--card-border); }
        .empty-state h3 { font-size: 1.2rem; margin-bottom: 0.5rem; }
        .empty-state p { color: var(--text-secondary); margin-bottom: 1.5rem; font-size: 0.875rem; line-height: 1.5; }
        .last-update { font-size: 0.75rem; color: var(--text-muted); width: 100%; text-align: right; }

        /* Modal Styles */
        .modal-backdrop { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.75); backdrop-filter: blur(4px); z-index: 1000; align-items: center; justify-content: center; padding: 1rem; }
        .modal-backdrop.open { display: flex; }
        .modal { background: #131b2e; border: 1px solid #1e293b; border-radius: 16px; width: 100%; max-width: 500px; padding: 1.75rem; box-shadow: 0 20px 40px rgba(0,0,0,0.6); position: relative; }
        .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.25rem; }
        .modal-header h2 { font-size: 1.25rem; font-weight: 600; }
        .close-btn { background: none; border: none; color: var(--text-muted); font-size: 1.5rem; cursor: pointer; padding: 0.2rem; }
        .step-box { background: #090d16; border: 1px solid #1e293b; border-radius: 10px; padding: 1rem; margin-bottom: 1rem; }
        .step-title { font-size: 0.85rem; font-weight: 600; color: #818cf8; margin-bottom: 0.5rem; }
        .step-desc { font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.75rem; line-height: 1.4; }
        .input-group input { width: 100%; padding: 0.75rem; border-radius: 8px; background: #131b2e; border: 1px solid #334155; color: white; font-size: 0.85rem; outline: none; margin-bottom: 0.75rem; }
        .input-group input:focus { border-color: var(--accent); }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div class="logo-group">
                <div class="logo-icon">⚡</div>
                <div>
                    <h1>AG Switchboard</h1>
                    <div class="subtitle">Antigravity 2.0 Multi-Account & Quota Controller</div>
                </div>
            </div>
            <div class="actions">
                <button class="btn-secondary" onclick="refreshAll()">🔄 Refresh</button>
                <button class="btn-primary" onclick="openAuthModal()">➕ Add Google Account</button>
            </div>
            <div id="lastUpdated" class="last-update">Updating...</div>
        </header>

        <main id="accountList" class="grid"></main>
    </div>

    <!-- OAuth Modal for Mobile & Desktop -->
    <div id="authModal" class="modal-backdrop">
        <div class="modal">
            <div class="modal-header">
                <h2>Connect Google Account</h2>
                <button class="close-btn" onclick="closeAuthModal()">✕</button>
            </div>

            <div class="step-box">
                <div class="step-title">STEP 1: Sign in with Google</div>
                <div class="step-desc">Open the Google sign-in page to grant Antigravity quota access:</div>
                <a id="googleAuthLink" href="#" target="_blank" style="text-decoration: none; display: block;">
                    <button type="button" class="btn-primary" style="width: 100%;">👉 Open Google Sign-In Tab</button>
                </a>
            </div>

            <div class="step-box">
                <div class="step-title">STEP 2: Complete Connection</div>
                <div class="step-desc">After approving, your browser will redirect to a localhost URL. Copy the full address bar URL or the code, paste it below, and click Connect:</div>
                <div class="input-group">
                    <input id="authCodeInput" type="text" placeholder="Paste redirect URL or code here..." />
                    <button id="completeBtn" class="btn-success" style="width: 100%;" onclick="submitAuthCode()">⚡ Complete Connection</button>
                </div>
            </div>
        </div>
    </div>

    <script>
        let currentOAuthState = '';

        async function fetchAccounts() {
            try {
                const res = await fetch('/api/accounts');
                const data = await res.json();
                renderAccounts(data.accounts || []);
                document.getElementById('lastUpdated').innerText = 'Last updated: ' + new Date().toLocaleTimeString();
            } catch (e) {
                console.error('Failed to fetch accounts', e);
            }
        }

        function renderAccounts(accounts) {
            const container = document.getElementById('accountList');
            if (accounts.length === 0) {
                container.innerHTML = \`
                    <div class="empty-state" style="grid-column: 1 / -1;">
                        <h3>No Accounts Connected</h3>
                        <p>Connect your Google accounts to monitor model quotas in real time and switch active sessions.</p>
                        <button class="btn-primary" onclick="openAuthModal()">➕ Connect First Account</button>
                    </div>
                \`;
                return;
            }

            container.innerHTML = accounts.map(acc => {
                const quota = acc.quota?.quota;
                const models = quota?.models || [];
                const tierName = quota?.tierName || 'Standard';
                
                const quotaItemsHtml = models.length > 0 ? models.map(m => {
                    const pct = m.usedPercent || 0;
                    const available = Math.max(0, Math.min(100, 100 - Math.round(pct)));
                    let colorClass = 'fill-green';
                    if (available <= 20) colorClass = 'fill-red';
                    else if (available <= 50) colorClass = 'fill-yellow';

                    const resetInfo = m.resetAt ? 'Resets: ' + new Date(m.resetAt).toLocaleTimeString() : '';

                    return \`
                        <div class="quota-item">
                            <div class="quota-label-row">
                                <span class="model-name">\${m.displayName}</span>
                                <span class="quota-meta">\${available}%/100% available \${resetInfo ? '· ' + resetInfo : ''}</span>
                            </div>
                            <div class="progress-bar-bg">
                                <div class="progress-bar-fill \${colorClass}" style="width: \${available}%"></div>
                            </div>
                        </div>
                    \`;
                }).join('') : \`<p style="color: var(--text-muted); font-size: 0.8rem; margin: 0.75rem 0;">No quota data fetched yet. Click refresh below.</p>\`;

                const hourlyPercent = quota?.geminiHourlyPercent ?? 100;
                const weeklyPercent = quota?.weeklyPercent ?? 100;
                const hourlyReset = quota?.geminiHourlyReset;
                let hourlyResetDisplay = '';
                if (hourlyReset) {
                    const diffH = new Date(hourlyReset).getTime() - Date.now();
                    if (diffH > 0) {
                        const mins = Math.floor(diffH / 60000);
                        const h = Math.floor(mins / 60);
                        const m = mins % 60;
                        hourlyResetDisplay = \`Resets in \${h > 0 ? h + 'h ' : ''}\${m}m\`;
                    }
                }

                let weeklyDisplay = 'Not set';
                if (acc.effectiveWeeklyExpiry) {
                    const diffMs = new Date(acc.effectiveWeeklyExpiry).getTime() - Date.now();
                    if (diffMs > 0) {
                        const totalMins = Math.floor(diffMs / 60000);
                        const hours = Math.floor(totalMins / 60);
                        const days = Math.floor(hours / 24);
                        const remHours = hours % 24;
                        const mins = totalMins % 60;
                        const rel = days > 0 ? \`\${days}d \${remHours}h\` : (hours > 0 ? \`\${hours}h \${mins}m\` : \`\${mins}m\`);
                        const dateStr = new Date(acc.effectiveWeeklyExpiry).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
                        weeklyDisplay = \`in \${rel} (\${dateStr})\`;
                    } else {
                        weeklyDisplay = 'Resetting soon';
                    }
                }

                return \`
                    <div class="card \${acc.isActive ? 'active' : ''}">
                        <div class="card-header">
                            <div class="account-info">
                                <div class="account-name">\${acc.name}</div>
                                <div class="account-email">\${acc.email}</div>
                            </div>
                            <div class="badge-group">
                                <span class="badge badge-tier">\${tierName}</span>
                                \${acc.isActive ? '<span class="badge badge-active">Active</span>' : ''}
                            </div>
                        </div>

                        <div style="background: rgba(255,255,255,0.04); border: 1px solid var(--border); padding: 0.6rem 0.75rem; border-radius: 8px; margin: 0.6rem 0; display: flex; flex-direction: column; gap: 0.4rem; font-size: 0.78rem;">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <div><span style="color: var(--text-muted);">Gemini 5-Hour:</span> <strong>\${hourlyPercent}%/100%</strong></div>
                                <div style="color: var(--text-muted); font-size: 0.75rem;">\${hourlyResetDisplay}</div>
                            </div>
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <div><span style="color: var(--text-muted);">Gemini Weekly:</span> <strong>\${weeklyPercent}%/100%</strong></div>
                                <div style="display: flex; align-items: center; gap: 0.35rem; font-size: 0.75rem;">
                                    <strong>\${weeklyDisplay}</strong>
                                    <button class="btn-secondary" style="padding: 1px 5px; font-size: 0.7rem; cursor: pointer;" onclick="promptSetWeekly('\${acc.id}', '\${acc.name}')" title="Set weekly reset date">✏️</button>
                                </div>
                            </div>
                        </div>

                        <div class="quota-list">
                            \${quotaItemsHtml}
                        </div>

                        <div class="card-footer">
                            <div style="display: flex; gap: 0.4rem;">
                                \${!acc.isActive ? \`<button class="btn-secondary" onclick="activateAccount('\${acc.id}')">⚡ Set Active</button>\` : '<span style="color: var(--success); font-size: 0.8rem; font-weight: 600;">✓ Active</span>'}
                                <button class="btn-secondary" onclick="refreshSingle('\${acc.id}')">🔄</button>
                            </div>
                            <button class="btn-danger" onclick="deleteAccount('\${acc.id}')">Remove</button>
                        </div>
                    </div>
                \`;
            }).join('');
        }

        async function openAuthModal() {
            document.getElementById('authCodeInput').value = '';
            document.getElementById('authModal').classList.add('open');
            try {
                const res = await fetch('/api/auth-url');
                const data = await res.json();
                if (data.success) {
                    currentOAuthState = data.state;
                    document.getElementById('googleAuthLink').href = data.authUrl;
                }
            } catch (e) {
                console.error('Failed to get auth URL', e);
            }
        }

        function closeAuthModal() {
            document.getElementById('authModal').classList.remove('open');
        }

        async function submitAuthCode() {
            const raw = document.getElementById('authCodeInput').value.trim();
            if (!raw) {
                alert('Please paste the authorization code or redirect URL');
                return;
            }

            const btn = document.getElementById('completeBtn');
            btn.disabled = true;
            btn.innerText = 'Connecting...';

            try {
                const res = await fetch('/api/auth-complete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code: raw, state: currentOAuthState }),
                });
                const data = await res.json();
                if (data.success) {
                    closeAuthModal();
                    fetchAccounts();
                } else {
                    alert('Failed to connect account: ' + (data.error || 'Unknown error'));
                }
            } catch (e) {
                alert('Network error connecting account: ' + e.message);
            } finally {
                btn.disabled = false;
                btn.innerText = '⚡ Complete Connection';
            }
        }

        async function activateAccount(id) {
            await fetch(\`/api/accounts/\${id}/activate\`, { method: 'POST' });
            fetchAccounts();
        }

        async function refreshSingle(id) {
            await fetch(\`/api/accounts/\${id}/quota\`);
            fetchAccounts();
        }

        async function refreshAll() {
            document.getElementById('lastUpdated').innerText = 'Refreshing...';
            await fetch('/api/refresh', { method: 'POST' });
            fetchAccounts();
        }

        async function deleteAccount(id) {
            if (confirm('Disconnect this account from AG Switchboard?')) {
                await fetch('/api/accounts/' + id, { method: 'DELETE' });
                fetchAccounts();
            }
        }

        async function promptSetWeekly(id, name) {
            const input = prompt('Enter weekly reset day/date for ' + name + ' (e.g. "18-Sep", "Friday", "2026-09-20", "+3d", or "clear"):');
            if (input === null) return;
            try {
                const res = await fetch('/api/accounts/' + id + '/weekly', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ weeklyExpiry: input.trim() })
                });
                const data = await res.json();
                if (data.success) {
                    fetchAccounts();
                } else {
                    alert('Error: ' + (data.error || 'Failed to set weekly expiry'));
                }
            } catch (e) {
                alert('Network error: ' + e.message);
            }
        }

        // Initial fetch and 30-second interval
        fetchAccounts();
        setInterval(fetchAccounts, 30000);
    </script>
</body>
</html>`;
    res.send(html);
});

app.listen(DASHBOARD_PORT, '0.0.0.0', () => {
    console.log(`\n🚀 AG Switchboard dashboard running on all interfaces at: http://0.0.0.0:${DASHBOARD_PORT}`);
});

// Refresh quotas in background
accountManager.refreshAllQuotas().catch(() => {});
