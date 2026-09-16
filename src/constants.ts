// Runtime credential loader for Antigravity's public loopback client
const _K = 0x2a;
const _CID_BYTES = [27,26,29,27,26,26,28,26,28,26,31,19,27,7,94,71,66,89,89,67,68,24,66,24,27,70,73,88,79,24,25,31,92,94,69,70,69,64,66,30,77,30,26,25,79,90,4,75,90,90,89,4,77,69,69,77,70,79,95,89,79,88,73,69,68,94,79,68,94,4,73,69,71];
const _CSEC_BYTES = [109,101,105,121,122,114,7,97,31,18,108,125,120,30,18,28,102,78,102,96,27,71,102,104,18,89,114,105,30,80,28,91,110,107,76];

function _decode(bytes: number[]): string {
    return Buffer.from(bytes.map(b => b ^ _K)).toString('utf-8');
}

export const CLIENT_ID = process.env.AG_CLIENT_ID || _decode(_CID_BYTES);
export const CLIENT_SECRET = process.env.AG_CLIENT_SECRET || _decode(_CSEC_BYTES);

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

export const OAUTH_SCOPES = [
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/aicode',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
];

export const QUOTA_API_ENDPOINTS = [
    'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
    'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
];

export const LOAD_CODE_ASSIST_ENDPOINTS = [
    'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
    'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
];

export const MODEL_DISPLAY_NAMES: Record<string, string> = {
    'claude-opus-4-6-thinking': 'Claude Opus 4.6 (Thinking)',
    'claude-sonnet-4-6': 'Claude Sonnet 4.6',
    'claude-sonnet-4-6-thinking': 'Claude Sonnet 4.6 (Thinking)',
    'gemini-3-flash': 'Gemini 3 Flash',
    'gemini-3.7-flash': 'Gemini 3.7 Flash',
    'gemini-3.1-pro-high': 'Gemini 3.1 Pro (High)',
    'gemini-3.1-pro-low': 'Gemini 3.1 Pro (Low)',
    'gpt-oss-120b-medium': 'GPT-OSS 120B (Medium)',
};

export const DATA_DIR = `${process.env.HOME || '/home/ubuntu'}/.ag-switchboard`;
export const ACCOUNTS_FILE = `${DATA_DIR}/accounts.json`;
export const ACTIVE_ACCOUNT_FILE = `${DATA_DIR}/active.json`;
export const ROTATOR_PID_FILE = `${DATA_DIR}/rotator.pid`;
export const ROTATOR_LOG_FILE = `${DATA_DIR}/rotator.log`;
export const ROTATOR_CHECK_INTERVAL_MS = 60 * 1000;

export const USER_AGENT = 'Antigravity/4.1.29 Chrome/132.0.6834.160 Electron/39.2.3';
export const POLL_INTERVAL_MS = 60 * 1000;
export const TOKEN_REFRESH_BUFFER_SECS = 300;
export const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const OAUTH_CALLBACK_PORT = 42001;
export const DASHBOARD_PORT = 7823;
