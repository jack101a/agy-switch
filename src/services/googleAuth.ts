import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';
import {
    CLIENT_ID,
    CLIENT_SECRET,
    TOKEN_URL,
    AUTH_URL,
    USERINFO_URL,
    OAUTH_SCOPES,
    OAUTH_CALLBACK_PORT,
    OAUTH_CALLBACK_TIMEOUT_MS,
} from '../constants.js';
import { HttpError } from '../types.js';

export interface OAuthResult {
    accessToken: string;
    refreshToken: string;
    expiryTimestamp: number;
    email: string;
    name: string;
}

export interface PendingOAuthSession {
    state: string;
    codeVerifier: string;
    codeChallenge: string;
    redirectUri: string;
    authUrl: string;
    createdAt: number;
}

export class GoogleAuthService {
    private pendingSessions = new Map<string, PendingOAuthSession>();

    public generateCodeVerifier(): string {
        return crypto.randomBytes(32).toString('base64url');
    }

    public generateCodeChallenge(verifier: string): string {
        return crypto.createHash('sha256').update(verifier).digest('base64url');
    }

    public createOAuthSession(): PendingOAuthSession {
        const state = crypto.randomBytes(16).toString('hex');
        const codeVerifier = this.generateCodeVerifier();
        const codeChallenge = this.generateCodeChallenge(codeVerifier);
        const redirectUri = `http://localhost:${OAUTH_CALLBACK_PORT}/callback`;

        const authUrl = this.getAuthUrl(redirectUri, codeChallenge, state);

        const session: PendingOAuthSession = {
            state,
            codeVerifier,
            codeChallenge,
            redirectUri,
            authUrl,
            createdAt: Date.now(),
        };

        this.pendingSessions.set(state, session);

        // Cleanup old sessions after 15 mins
        setTimeout(() => {
            this.pendingSessions.delete(state);
        }, 15 * 60 * 1000);

        return session;
    }

    public getPendingSession(state?: string): PendingOAuthSession | undefined {
        if (state && this.pendingSessions.has(state)) {
            return this.pendingSessions.get(state);
        }
        // Return most recent session if state not provided
        let latest: PendingOAuthSession | undefined;
        for (const s of this.pendingSessions.values()) {
            if (!latest || s.createdAt > latest.createdAt) {
                latest = s;
            }
        }
        return latest;
    }

    public getAuthUrl(redirectUri: string, codeChallenge: string, state?: string): string {
        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: OAUTH_SCOPES.join(' '),
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            access_type: 'offline',
            prompt: 'consent',
        });
        if (state) {
            params.set('state', state);
        }
        return `${AUTH_URL}?${params.toString()}`;
    }

    async completeOAuthWithCode(
        rawInput: string,
        state?: string
    ): Promise<OAuthResult> {
        let code = rawInput.trim().replace(/^["'`]|["'`]$/g, '');
        let redirectUri = `http://localhost:${OAUTH_CALLBACK_PORT}/callback`;

        // If the user pasted the entire callback URL e.g. http://localhost:42001/callback?code=...
        if (code.includes('code=')) {
            try {
                const parsedUrl = new URL(code.startsWith('http') ? code : `http://${code}`);
                const extractedCode = parsedUrl.searchParams.get('code');
                const extractedState = parsedUrl.searchParams.get('state');
                if (extractedCode) {
                    code = extractedCode;
                }
                // Prioritize state extracted from the actual callback URL
                if (extractedState) {
                    state = extractedState;
                }
            } catch {
                // Fallback regex match
                const match = code.match(/code=([^&]+)/);
                if (match && match[1]) {
                    code = decodeURIComponent(match[1]);
                }
                const stateMatch = code.match(/state=([^&]+)/);
                if (stateMatch && stateMatch[1]) {
                    state = decodeURIComponent(stateMatch[1]);
                }
            }
        }
        code = code.trim().replace(/^["'`]|["'`]$/g, '');

        const session = this.getPendingSession(state);
        const codeVerifier = session?.codeVerifier;
        if (session?.redirectUri) {
            redirectUri = session.redirectUri;
        }

        const tokens = await this.exchangeCode(code, redirectUri, codeVerifier);
        const userInfo = await this.fetchUserInfo(tokens.access_token);

        if (state) {
            this.pendingSessions.delete(state);
        }

        return {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiryTimestamp: Math.floor(Date.now() / 1000) + (tokens.expires_in || 3600),
            email: userInfo.email,
            name: userInfo.name,
        };
    }

    async startOAuthFlow(): Promise<OAuthResult> {
        const session = this.createOAuthSession();
        const { codeVerifier, redirectUri, authUrl } = session;

        return new Promise<OAuthResult>((resolve, reject) => {
            let timer: NodeJS.Timeout | null = null;

            const server = http.createServer(async (req, res) => {
                try {
                    const reqUrl = new URL(req.url || '', `http://localhost:${OAUTH_CALLBACK_PORT}`);
                    if (reqUrl.pathname !== '/callback') {
                        res.writeHead(404, { 'Content-Type': 'text/plain' });
                        res.end('Not Found');
                        return;
                    }

                    const code = reqUrl.searchParams.get('code');
                    const error = reqUrl.searchParams.get('error');

                    if (error) {
                        res.writeHead(400, { 'Content-Type': 'text/html' });
                        res.end(`<h1>Authentication Failed</h1><p>${error}</p>`);
                        cleanup();
                        reject(new Error(`OAuth error: ${error}`));
                        return;
                    }

                    if (!code) {
                        res.writeHead(400, { 'Content-Type': 'text/html' });
                        res.end('<h1>Missing authorization code</h1>');
                        cleanup();
                        reject(new Error('Missing authorization code'));
                        return;
                    }

                    // Exchange code
                    const tokens = await this.exchangeCode(code, redirectUri, codeVerifier);
                    const userInfo = await this.fetchUserInfo(tokens.access_token);

                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(`
                        <!DOCTYPE html>
                        <html>
                        <head><title>AG Switchboard - Auth Successful</title></head>
                        <body style="font-family: sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
                            <div style="text-align: center; background: #1e293b; padding: 2rem 3rem; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.5);">
                                <h1 style="color: #22c55e; margin-bottom: 0.5rem;">Authentication Successful!</h1>
                                <p style="font-size: 1.1rem; color: #94a3b8;">Account <b>${userInfo.email}</b> connected to AG Switchboard.</p>
                                <p style="font-size: 0.9rem; color: #64748b;">You can close this tab and return to Antigravity.</p>
                            </div>
                        </body>
                        </html>
                    `);

                    cleanup();
                    resolve({
                        accessToken: tokens.access_token,
                        refreshToken: tokens.refresh_token,
                        expiryTimestamp: Math.floor(Date.now() / 1000) + (tokens.expires_in || 3600),
                        email: userInfo.email,
                        name: userInfo.name,
                    });
                } catch (e) {
                    cleanup();
                    reject(e);
                }
            });

            const cleanup = () => {
                if (timer) clearTimeout(timer);
                try {
                    server.close();
                } catch {}
            };

            server.on('error', (err: any) => {
                cleanup();
                // If port is already in use, don't fail hard, user can still use manual code entry
                if (err.code !== 'EADDRINUSE') {
                    reject(err);
                }
            });

            try {
                server.listen(OAUTH_CALLBACK_PORT, () => {
                    console.log(`\n🔗 Open this URL in your browser to sign in:\n${authUrl}\n`);
                });
            } catch (err: any) {
                if (err.code !== 'EADDRINUSE') {
                    reject(err);
                }
            }

            timer = setTimeout(() => {
                cleanup();
                reject(new Error('OAuth flow timed out waiting for callback'));
            }, OAUTH_CALLBACK_TIMEOUT_MS);
        });
    }

    async exchangeCode(
        code: string,
        redirectUri: string,
        codeVerifier?: string
    ): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
        const bodyParams: Record<string, string> = {
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
        };
        if (codeVerifier) {
            bodyParams.code_verifier = codeVerifier;
        }

        const body = new URLSearchParams(bodyParams).toString();
        return this.postForm(TOKEN_URL, body);
    }

    async refreshAccessToken(
        refreshToken: string
    ): Promise<{ access_token: string; expires_in: number; refresh_token?: string; expiryTimestamp: number }> {
        const body = new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
        }).toString();

        const res = await this.postForm(TOKEN_URL, body);
        const expires_in = res.expires_in || 3600;
        return {
            access_token: res.access_token,
            expires_in,
            refresh_token: res.refresh_token,
            expiryTimestamp: Math.floor(Date.now() / 1000) + expires_in,
        };
    }

    async fetchUserInfo(accessToken: string): Promise<{ email: string; name: string }> {
        return new Promise((resolve, reject) => {
            const req = https.get(
                USERINFO_URL,
                {
                    headers: { Authorization: `Bearer ${accessToken}` },
                    timeout: 10_000,
                },
                (res) => {
                    let data = '';
                    res.on('data', (chunk) => (data += chunk));
                    res.on('end', () => {
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            try {
                                const parsed = JSON.parse(data);
                                resolve({
                                    email: parsed.email || 'unknown',
                                    name: parsed.name || parsed.email || 'User',
                                });
                            } catch (e) {
                                reject(e);
                            }
                        } else {
                            reject(new HttpError(res.statusCode || 500, data));
                        }
                    });
                }
            );
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Userinfo request timed out'));
            });
        });
    }

    private async postForm(url: string, body: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(url);
            const req = https.request(
                {
                    hostname: urlObj.hostname,
                    path: urlObj.pathname,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Content-Length': Buffer.byteLength(body),
                    },
                    timeout: 10_000,
                },
                (res) => {
                    let data = '';
                    res.on('data', (chunk) => (data += chunk));
                    res.on('end', () => {
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            try {
                                resolve(JSON.parse(data));
                            } catch (e) {
                                reject(e);
                            }
                        } else {
                            reject(new HttpError(res.statusCode || 500, data));
                        }
                    });
                }
            );
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timed out'));
            });
            req.write(body);
            req.end();
        });
    }
}
