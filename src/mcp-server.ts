import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { AccountManager } from './managers/accountManager.js';
import { GoogleAuthService } from './services/googleAuth.js';
import { QuotaApiService } from './services/quotaApi.js';
import { DASHBOARD_PORT } from './constants.js';

const authService = new GoogleAuthService();
const quotaApi = new QuotaApiService();
const accountManager = new AccountManager(authService, quotaApi);

await accountManager.initialize();

const server = new Server(
    {
        name: 'ag-switchboard',
        version: '1.0.0',
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

// Define tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: 'list_accounts',
                description: 'List all connected Google accounts in AG Switchboard with active status and current quota summaries.',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            {
                name: 'get_quota',
                description: 'Fetch live model quota (Claude, Gemini, GPT-OSS) and usage percentage from the Antigravity API for an account.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        account_id: {
                            type: 'string',
                            description: 'Optional account ID. If omitted, fetches quotas for all connected accounts.',
                        },
                    },
                },
            },
            {
                name: 'switch_account',
                description: 'Switch the active Antigravity account in AG Switchboard.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        account_id: {
                            type: 'string',
                            description: 'The ID of the account to set as active.',
                        },
                    },
                    required: ['account_id'],
                },
            },
            {
                name: 'add_account',
                description: 'Start Google OAuth flow to connect a new Google account to AG Switchboard.',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            {
                name: 'remove_account',
                description: 'Remove a Google account from AG Switchboard.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        account_id: {
                            type: 'string',
                            description: 'The ID of the account to remove.',
                        },
                    },
                    required: ['account_id'],
                },
            },
            {
                name: 'open_dashboard',
                description: 'Get the URL for the AG Switchboard web dashboard.',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
        ],
    };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        if (name === 'list_accounts') {
            const accounts = accountManager.getAccounts();
            const active = await accountManager.getActiveAccount();
            const cache = accountManager.getQuotaCache();

            if (accounts.length === 0) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: 'No accounts connected in AG Switchboard. Use `add_account` to connect your Google account.',
                        },
                    ],
                };
            }

            let text = '### Connected Antigravity Accounts\n\n';
            for (const acc of accounts) {
                const isActive = active?.id === acc.id;
                const cachedQuota = cache.get(acc.id)?.quota;
                const tier = cachedQuota?.tierName || 'Standard';

                text += `* **${acc.name}** (\`${acc.email}\`) ${isActive ? '⚡ **[ACTIVE]**' : ''}\n`;
                text += `  - ID: \`${acc.id}\`\n`;
                text += `  - Tier: **${tier}**\n`;

                if (cachedQuota?.models && cachedQuota.models.length > 0) {
                    text += `  - Quotas:\n`;
                    for (const m of cachedQuota.models.slice(0, 4)) {
                        text += `    - ${m.displayName}: **${m.usedPercent}% used**\n`;
                    }
                }
                text += '\n';
            }

            return {
                content: [{ type: 'text', text }],
            };
        }

        if (name === 'get_quota') {
            const accountId = args?.account_id as string | undefined;
            const accounts = accountManager.getAccounts();

            if (accounts.length === 0) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: 'No accounts connected in AG Switchboard. Use `add_account` to connect one first.',
                        },
                    ],
                };
            }

            const targetAccounts = accountId
                ? accounts.filter((a) => a.id === accountId)
                : accounts;

            if (targetAccounts.length === 0) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Account with ID \`${accountId}\` not found.`,
                        },
                    ],
                };
            }

            let text = '';
            for (const acc of targetAccounts) {
                text += `### Quota for ${acc.name} (\`${acc.email}\`)\n\n`;
                try {
                    const result = await accountManager.refreshQuotaForAccount(acc);
                    const quota = result.quota;

                    if (quota.isForbidden) {
                        text += `> ⚠️ **Access Forbidden (403)**: Token does not have Cloud AI Companion permissions.\n\n`;
                        continue;
                    }
                    if (quota.isError) {
                        text += `> ❌ **Error**: ${quota.errorMessage || 'Failed to fetch quota'}\n\n`;
                        continue;
                    }

                    text += `**Tier**: ${quota.tierName || 'Standard'}\n\n`;
                    text += `| Model | Used % | Reset Time |\n`;
                    text += `| :--- | :--- | :--- |\n`;

                    for (const m of quota.models) {
                        const resetStr = m.resetAt ? new Date(m.resetAt).toLocaleString() : 'N/A';
                        text += `| ${m.displayName} | **${m.usedPercent}%** | ${resetStr} |\n`;
                    }
                    text += '\n';
                } catch (e: any) {
                    text += `> ❌ Failed to refresh quota: ${e.message}\n\n`;
                }
            }

            return {
                content: [{ type: 'text', text }],
            };
        }

        if (name === 'switch_account') {
            const accountId = args?.account_id as string;
            const ok = await accountManager.setActiveAccount(accountId);
            if (!ok) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Account with ID \`${accountId}\` not found.`,
                        },
                    ],
                };
            }
            const acc = accountManager.getAccount(accountId);
            return {
                content: [
                    {
                        type: 'text',
                        text: `✅ Successfully switched active account in AG Switchboard to **${acc?.name}** (\`${acc?.email}\`).`,
                    },
                ],
            };
        }

        if (name === 'add_account') {
            // Trigger oauth flow
            accountManager.addAccount().then((res) => {
                console.log('[MCP add_account] result:', res);
            }).catch(console.error);

            return {
                content: [
                    {
                        type: 'text',
                        text: `🔗 OAuth listener started on port 42001. Please open the dashboard at http://localhost:${DASHBOARD_PORT} or check server logs to authenticate with your Google account.`,
                    },
                ],
            };
        }

        if (name === 'remove_account') {
            const accountId = args?.account_id as string;
            await accountManager.removeAccount(accountId);
            return {
                content: [
                    {
                        type: 'text',
                        text: `✅ Removed account \`${accountId}\` from AG Switchboard.`,
                    },
                ],
            };
        }

        if (name === 'open_dashboard') {
            return {
                content: [
                    {
                        type: 'text',
                        text: `🌐 AG Switchboard Web Dashboard is available at:\n\n**http://localhost:${DASHBOARD_PORT}**\n\nOpen this in your browser to view real-time quota gauges, manage accounts, and switch active profiles.`,
                    },
                ],
            };
        }

        return {
            content: [
                {
                    type: 'text',
                    text: `Unknown tool: ${name}`,
                },
            ],
            isError: true,
        };
    } catch (error: any) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error executing ${name}: ${error.message}`,
                },
            ],
            isError: true,
        };
    }
});

// Start the server on stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
