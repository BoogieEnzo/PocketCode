# RemoteLab

[中文](README.zh.md) | English

**Use your phone or any browser to control OpenCode, Claude Code, Codex, and Cline on your Mac or Linux.** One HTTPS link, no SSH or VPN — chat, sessions, and history from anywhere.

**Highlights:** One link from your phone, no SSH · Sessions survive disconnect, history on disk · Multiple sessions in parallel, multiple folders and tools · OpenCode, Claude Code, Codex, Cline supported

![Chat UI](docs/demo.gif)

---

## Quick start

### What it does

RemoteLab runs a web server on your **Mac or Linux** machine. Add a Cloudflare tunnel, get an HTTPS URL, then open it from any browser to chat with Claude Code (or Codex, Cline) on that machine. Sessions survive disconnects; history is saved; multiple folders and sessions run in parallel.

### 5-minute setup (let AI do it)

Paste the prompt below into Claude Code on your server. The AI will run the setup; you only need to complete one Cloudflare browser login (to prove you own the domain).

**Before you start:** macOS (Homebrew + Node.js 18+) or Linux (Node.js 18+; wizard can install `dtach`/`ttyd`) · One AI tool installed (`claude`, `codex`, or `cline`) · A domain on Cloudflare ([free](https://cloudflare.com); domain ~$1–12/yr).

**Paste into Claude Code:**

```
I want to set up RemoteLab on this Mac so I can control AI coding tools from my phone.

My domain: [YOUR_DOMAIN]          (e.g. example.com)
Subdomain I want to use: [SUBDOMAIN]  (e.g. chat → chat.example.com)

Follow docs/setup.md in this repo. Do every step automatically; at [HUMAN] steps, stop and tell me what to do. Continue after I confirm.
```

---

### After setup

Open `https://[subdomain].[domain]/?token=YOUR_TOKEN` (e.g. on your phone): create sessions (folder + AI tool), send messages (streaming), paste screenshots. Close the tab and return later — the session is still there.

![Dashboard](docs/new-dashboard.png)

**Get your access URL and test:** run `node cli.js generate-token` (or `remotelab generate-token` if CLI is global). The token is written to `~/.config/claude-web/auth.json`; the command prints an **Access URL** — open it in a browser to confirm login and chat work.

**Daily:** Services auto-start on boot. Use `remotelab start` / `remotelab stop` / `remotelab restart chat` when needed.

**Manual start (chat server stopped or for debugging):** From the project directory run `node chat-server.mjs` (listens on 7690 by default). Then open your access URL (the HTTPS address from your Tunnel, e.g. `https://chat.example.com`). First time, append `?token=YOUR_TOKEN` to the URL; run `node cli.js generate-token` to generate and print the Access URL. After logging in once, the browser keeps the session — you can open the same URL without the token next time.

---

## Architecture

| Service | Port | Role |
|---------|------|------|
| `chat-server.mjs` | 7690 | **Main.** Chat UI, runs CLI tools, WebSocket streaming |
| `auth-proxy.mjs` | 7681 | **Fallback.** Raw terminal (ttyd) — emergency only |

Tunnel → chat server. Each chat session is a subprocess; disconnect and it keeps running; reconnect and you get history + live stream again.

---

## CLI Reference

```
remotelab setup                Run interactive setup wizard
remotelab start                Start all services
remotelab stop                 Stop all services
remotelab restart [service]    Restart: chat | proxy | tunnel | all
remotelab chat                 Run chat server in foreground (debug)
remotelab server               Run auth proxy in foreground (debug)
remotelab generate-token       Generate a new access token
remotelab set-password         Set username & password (alternative to token)
remotelab --help               Show help
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAT_PORT` | `7690` | Chat server port |
| `LISTEN_PORT` | `7681` | Auth proxy port |
| `SESSION_EXPIRY` | `86400000` | Cookie lifetime in ms (24h) |
| `SECURE_COOKIES` | `1` | Set `0` for localhost without HTTPS |

## File locations

| Path | Contents |
|------|----------|
| `~/.config/claude-web/auth.json` | Access token + password hash |
| `~/.config/claude-web/chat-sessions.json` | Chat session metadata |
| `~/.config/claude-web/chat-history/` | Per-session event logs (JSONL) |
| `~/Library/Logs/chat-server.log` | Chat server stdout **(macOS)** |
| `~/.local/share/remotelab/logs/chat-server.log` | Chat server stdout **(Linux)** |
| `~/Library/Logs/cloudflared.log` | Tunnel stdout **(macOS)** |
| `~/.local/share/remotelab/logs/cloudflared.log` | Tunnel stdout **(Linux)** |

## Security

HTTPS via Cloudflare; 256-bit token (or optional password); secure cookies; rate limiting on failed login. Server listens on 127.0.0.1 only.

## Troubleshooting

- **Won't start:** macOS: `tail -50 ~/Library/Logs/chat-server.error.log` · Linux: `journalctl --user -u remotelab-chat -n 50`
- **DNS:** Wait 5–30 min after setup; check with `dig SUBDOMAIN.DOMAIN +short`
- **Port in use:** `lsof -i :7690` or `:7681` · then `remotelab restart chat` or `remotelab restart proxy`

---

## License

MIT
