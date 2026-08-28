# ⚡ agy-switch

> **The modern multi-account controller, live AI quota monitor, and MCP server for Google Antigravity.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-blueviolet.svg)](https://modelcontextprotocol.io)

---

## ✨ Features

- 📱 **Mobile & Desktop Responsive TUI**: Automatically adapts to narrow mobile viewports (< 55 cols) on Termux, SSH, and web terminals with zero distortion.
- 👆 **Mouse & Touch Tap Support**: Click or tap directly on any account card in terminal to switch instantly.
- ⚡ **Single-Key Quick Switch**: Press `1`-`9` to switch active profiles in a single keypress.
- ⏱️ **Live Relative Reset Countdowns**: View exact time remaining until quota refresh (e.g. `↳ Resets in 4h 38m (Sat 05:03 AM)`).
- 🔌 **Native Antigravity MCP Server**: Ask Antigravity in chat to switch accounts or check remaining quota.
- 🌐 **Mobile-Friendly Web Dashboard**: Optional browser dashboard (`http://0.0.0.0:7823`) with remote QR/browser sign-in.
- 🛠️ **Scriptable CLI**: Full command-line interface with `--json` support for piping into shell scripts.

---

## 📸 TUI Preview

```text
╭────────────────────────────────────────────────────────╮
│ ⚡ AG SWITCHBOARD — Multi-Account AI Quota Controller   │
│ Select account to activate • Press [a] to add, [d] to remove
╰────────────────────────────────────────────────────────╯
╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮
│ ★ ACTIVE ACCOUNT ★  [1] Zero One (user@gmail.com) [Google AI Pro]
├┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┤
│   Claude Sonnet 4.6    ████████░░  54%   Resets: in 4h 38m (Sat 05:03 AM)
│   Gemini 3.7 Flash     █░░░░░░░░░   6%   Resets: in 4h 22m (Sat 04:47 AM)
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯
╭────────────────────────────────────────────────────────╮
│ ▶ SELECTED  [2] Work Account (work@domain.com) [Google AI Pro] [Press 2/ENTER to Switch]
├┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┤
│   Claude Sonnet 4.6    ██████████ 100% ⚠ Resets: in 18h 59m (Sat 07:26 PM)
│   Gemini 3.7 Flash     █████████░  92%   Resets: in 4d 11h (Wed 11:58 AM)
╰────────────────────────────────────────────────────────╯
╭────────────────────────────────────────────────────────╮
│  [1-9] Quick Switch   [a] Add Account   [d] Remove Account   [r] Refresh   [w] Web Dashboard   [q] Exit
╰────────────────────────────────────────────────────────╯
```

---

## 🚀 Installation & Usage

### 1. Install Globally (Direct from GitHub)
```bash
npm install -g jack101a/agy-switch
```
Then run anytime:
```bash
agy-switch
```

### 2. Run Directly with NPX (Zero install)
```bash
npx github:jack101a/agy-switch
```

### 3. Install from Source
```bash
git clone https://github.com/jack101a/agy-switch.git
cd agy-switch
npm install
npm run build
./bin/agy-auth.js
```

---

## 🎮 Interactive TUI Controls

| Hotkey | Action |
| :--- | :--- |
| **`1` - `9`** | **Instant 1-key switch** to account `1`, `2`... |
| **`↑` / `↓`** | Navigate between accounts |
| **Click / Tap** | Select and activate account directly with mouse or touch |
| **`Enter` / `Space`** | Activate highlighted account |
| **`a`** | **Add new Google account** (in-terminal OAuth prompt) |
| **`d`** or **`x`** | **Disconnect / remove** highlighted account |
| **`r`** | Live refresh quotas from Google Cloud |
| **`w`** | Launch local web dashboard on `http://0.0.0.0:7823` |
| **`q`** / **`Esc`** | Exit |

---

## 💻 CLI Commands

| Command | Usage | Description |
| :--- | :--- | :--- |
| `agy-switch` | `agy-switch` | Launch full interactive TUI dashboard |
| `agy-switch list` | `agy-switch list [--json]` | List connected accounts & active status |
| `agy-switch switch` | `agy-switch switch <name\|#>` | Switch active account instantly |
| `agy-switch quota` | `agy-switch quota [name\|#]` | Detailed model quota table with reset countdowns |
| `agy-switch add` | `agy-switch add` | Connect a new Google account via OAuth |
| `agy-switch remove` | `agy-switch remove <name\|#>` | Disconnect an account |
| `agy-switch dashboard` | `agy-switch dashboard` | Start local web dashboard on port `7823` |
| `agy-switch help` | `agy-switch help` | Display CLI help menu |

---

## 🔌 Antigravity 2.0 MCP Integration

Add `agy-switch` to your `~/.gemini/config/mcp_config.json` (or Claude Desktop / Cursor):

```json
{
  "mcpServers": {
    "agy-switch": {
      "command": "node",
      "args": ["/path/to/agy-switch/dist/mcp-server.js"]
    }
  }
}
```

Now you can control accounts directly in your AI chat:
- *"What is my remaining quota on Claude and Gemini?"*
- *"Switch active account to Zero One"*
- *"List all connected accounts"*

---

## 📄 License

MIT © 2026 Antigravity Community
