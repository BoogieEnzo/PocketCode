# remotelab

Access any AI coding CLI tool — Claude Code, GitHub Copilot, Codex, Cline, and more — from any browser on any device via HTTPS.

## Features

- **Any CLI tool** — built-in support for Claude Code, GitHub Copilot, OpenAI Codex, Cline, and Kilo Code; add any custom CLI tool from the dashboard
- **Multi-session dashboard** — create and manage multiple concurrent sessions, each pointing at a different project folder and tool
- **Session persistence** — dtach keeps your tool running through browser disconnects; reconnecting reattaches to the same session
- **Token-based auth** — high-entropy random token link, no username/password needed; HttpOnly session cookies after login
- **Mobile-friendly** — works in iOS Safari, Android Chrome, and any modern browser

## Prerequisites

- **macOS** with **Homebrew** installed
- **Node.js 18+**
- **A domain managed by Cloudflare** (free plan works)
- At least one CLI tool installed (e.g. `claude`, `copilot`, etc.)

## Quick Start

### Option 1: Interactive Setup

```bash
git clone https://github.com/Ninglo/remotelab.git
cd remotelab
npm link
remotelab setup
```

### Option 2: Non-Interactive Setup (for automation / Claude Code)

```bash
git clone https://github.com/Ninglo/remotelab.git
cd remotelab
npm link

# Install dependencies
brew install dtach ttyd cloudflared

# Authenticate cloudflared (opens browser - do this manually once)
cloudflared tunnel login

# Create tunnel and route DNS
cloudflared tunnel create my-tunnel
cloudflared tunnel route dns my-tunnel claude.yourdomain.com

# Create cloudflared config
cat > ~/.cloudflared/config.yml << EOF
tunnel: my-tunnel
credentials-file: ~/.cloudflared/<tunnel-id>.json
protocol: http2

ingress:
  - hostname: claude.yourdomain.com
    service: http://localhost:7681
  - service: http_status:404
EOF

# Generate access token
remotelab generate-token

# Create LaunchAgent plists and start services
remotelab start
```

## Authentication

remotelab uses **token-based authentication**. After setup, you get a URL like:

```
https://claude.yourdomain.com/?token=<64-char-hex-token>
```

Open this URL to log in. The token is exchanged for a session cookie and stripped from the URL. Subsequent visits use the cookie — no need to keep the token in the URL.

### Regenerate token

```bash
remotelab generate-token
```

The new token takes effect immediately (no restart needed).

## CLI Commands

```
remotelab setup              Run interactive setup
remotelab start              Start auth proxy + ttyd
remotelab stop               Stop all services
remotelab server             Run auth proxy in foreground
remotelab generate-token     Generate a new access token
remotelab --help             Show help
remotelab --version          Show version
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LISTEN_PORT` | `7681` | Port auth-proxy listens on |
| `TTYD_PORT_RANGE_START` | `7700` | Start of per-session ttyd port range |
| `TTYD_PORT_RANGE_END` | `7799` | End of per-session ttyd port range |
| `SESSION_EXPIRY` | `86400000` | Auth cookie lifetime in ms (24h) |
| `SECURE_COOKIES` | `1` | Set to `0` for localhost (no HTTPS) |

## View Logs

```bash
tail -f ~/Library/Logs/auth-proxy.log
tail -f ~/Library/Logs/auth-proxy.error.log
tail -f ~/Library/Logs/cloudflared.log
```

## File Locations

| Path | Description |
|------|-------------|
| `generate-token.mjs` | Token generation utility |
| `auth-proxy.mjs` | Authentication proxy server |
| `claude-ttyd-session` | dtach wrapper script (zsh) |
| `~/.config/claude-web/auth.json` | Access token |
| `~/.config/claude-web/auth-sessions.json` | Active sessions |
| `~/.config/claude-web/sessions.json` | Session metadata |
| `~/.config/claude-web/sockets/` | dtach socket files |
| `~/Library/LaunchAgents/com.authproxy.claude.plist` | auth-proxy service |
| `~/Library/LaunchAgents/com.cloudflared.tunnel.plist` | Cloudflare tunnel service |

## Security

1. HTTPS via Cloudflare Tunnel
2. 256-bit random access token with timing-safe comparison
3. HttpOnly, Secure, SameSite=Strict session cookies
4. Per-IP rate limiting with exponential backoff
5. Localhost-only service binding
6. CSP headers with nonce-based script allowlist

## License

MIT
