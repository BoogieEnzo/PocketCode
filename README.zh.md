# RemoteLab

[English](README.md) | 中文

**用手机或任意浏览器，远程控制你 Mac/Linux 上的 AI 编程工具。**  
**OpenCode 也能在手机上用了** —— 同时支持 OpenCode、Claude Code、Codex、Cline。一条 HTTPS 链接，不用 SSH 和 VPN，随时随地聊天、会话、看历史。

**亮点：** 手机一条链接即用，无需 SSH · 断线不丢会话，历史落盘可回溯 · 多会话并行，多文件夹、多工具同时跑 · 支持 OpenCode / Claude Code / Codex / Cline

![Chat UI](docs/demo.gif)

---

## 快速开始

### 它能做什么

RemoteLab 在你的 **Mac 或 Linux** 上跑一个 Web 服务，配上 Cloudflare Tunnel 得到 HTTPS 地址，用手机或任意浏览器打开就能和本机的 **OpenCode**、Claude Code、Codex、Cline 对话。断线不丢会话，历史落盘，多文件夹、多会话可并行。

### 5 分钟配置（交给 AI）

把下面这段 prompt 粘贴到本机的 Claude Code，AI 会自动完成配置；你只需在浏览器里登录一次 Cloudflare（证明域名是你的）。

**事前准备：** macOS（Homebrew + Node.js 18+）或 Linux（Node.js 18+，向导可装 dtach/ttyd）· 已装一个 AI 工具（`opencode` / `claude` / `codex` / `cline`）· 域名已接入 Cloudflare（[免费](https://cloudflare.com)，域名约 ¥10–90/年）。

**粘贴到 Claude Code：**

```
我想在这台 Mac/Linux 上配置 RemoteLab，用手机远程控制 AI 编程工具。

我的域名：[YOUR_DOMAIN]（如 example.com）
子域名：[SUBDOMAIN]（如 chat → chat.example.com）

请按本仓库 docs/setup.md 执行。能自动做的都做；遇到 [HUMAN] 步骤停下来告诉我该做什么，我确认后再继续。
```

---

### 配置完成后

在手机等设备打开 `https://[subdomain].[domain]/?token=YOUR_TOKEN`：新建会话（选文件夹 + AI 工具）、发消息（实时流式）、粘贴截图；关掉标签页再回来，会话还在。

![Dashboard](docs/new-dashboard.png)

**获取访问地址并自测：** 执行 `node cli.js generate-token`（全局安装 CLI 则用 `remotelab generate-token`）。Token 会写入 `~/.config/claude-web/auth.json`，终端会打印 **Access URL**，用浏览器打开即可验证登录和聊天是否正常。

**日常：** 服务开机自启。需要时用 `remotelab start` / `remotelab stop` / `remotelab restart chat`。

**手动启动 Chat 服务（服务被停掉或调试时）：** 进入项目目录执行 `node chat-server.mjs`（默认监听 7690）。然后打开你的访问地址（即 Tunnel 对应的 HTTPS，例如 `https://chat.enzoding.com`）。首次访问需在地址后加 `?token=你的token`，用 `node cli.js generate-token` 可生成并打印 Access URL；登录过一次后浏览器会记住，之后直接打开该网址即可，不必再带 token。

---

## 架构

| 服务 | 端口 | 职责 |
|------|------|------|
| `chat-server.mjs` | 7690 | **主服务**。Chat UI、拉起 CLI、WebSocket 流式 |
| `auth-proxy.mjs` | 7681 | **备用**。ttyd 原始终端，仅应急用 |

流量经 Tunnel 到 chat server。每个会话是一个子进程：断线后进程还在，重连后继续看历史 + 实时流。

---

## CLI 命令

```
remotelab setup                运行交互式配置向导
remotelab start                启动所有服务
remotelab stop                 停止所有服务
remotelab restart [service]    重启：chat | proxy | tunnel | all
remotelab chat                 前台运行 chat server（调试用）
remotelab server               前台运行 auth proxy（调试用）
remotelab generate-token       生成新的访问 token
remotelab set-password         设置用户名和密码（token 的替代方案）
remotelab --help               显示帮助
```

## 配置项

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CHAT_PORT` | `7690` | Chat server 端口 |
| `LISTEN_PORT` | `7681` | Auth proxy 端口 |
| `SESSION_EXPIRY` | `86400000` | Cookie 有效期（毫秒，24h） |
| `SECURE_COOKIES` | `1` | 本地不走 HTTPS 时设为 `0` |

## 文件位置

| 路径 | 内容 |
|------|------|
| `~/.config/claude-web/auth.json` | 访问 token + 密码哈希 |
| `~/.config/claude-web/chat-sessions.json` | Chat 会话元数据 |
| `~/.config/claude-web/chat-history/` | 每个会话的事件日志（JSONL） |
| `~/Library/Logs/chat-server.log` | Chat server 标准输出 **(macOS)** |
| `~/Library/Logs/auth-proxy.log` | Auth proxy 标准输出 **(macOS)** |
| `~/Library/Logs/cloudflared.log` | Tunnel 标准输出 **(macOS)** |
| `~/.local/share/remotelab/logs/chat-server.log` | Chat server 标准输出 **(Linux)** |
| `~/.local/share/remotelab/logs/auth-proxy.log` | Auth proxy 标准输出 **(Linux)** |
| `~/.local/share/remotelab/logs/cloudflared.log` | Tunnel 标准输出 **(Linux)** |

## 安全

HTTPS 走 Cloudflare；256 位 token（或可选密码）；安全 Cookie；登录失败限流。服务只监听 127.0.0.1。

## 故障排查

- **起不来：** macOS 看 `~/Library/Logs/chat-server.error.log` · Linux：`journalctl --user -u remotelab-chat -n 50`
- **DNS 没生效：** 配置后等 5–30 分钟，用 `dig 子域名.域名 +short` 检查
- **端口占用：** `lsof -i :7690` 或 `:7681`，再用 `remotelab restart chat` / `remotelab restart proxy`

---

## License

MIT
