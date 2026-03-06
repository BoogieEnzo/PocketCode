# CLAUDE.md

## 产品定位

RemoteLab 是一个让用户通过手机浏览器远程操控 macOS/Linux 上 AI 编程工具的 Web 应用，**适配 OpenCode、Claude Code、Codex、Cline**。核心场景是：用户不在电脑前，但想用手机指挥 AI 帮忙写代码、处理任务。

**目标用户**：有 macOS 或 Linux 开发机/服务器的程序员，需要在移动端（通勤、外出）远程控制 AI 编程工具。

**核心价值**：不在电脑前也能让 AI 干活。

## 架构概览

```
手机浏览器 ──HTTPS──→ Cloudflare Tunnel ──→ auth-proxy (Node.js :7681)
                                                  │
                                          ┌───────┼───────┐
                                          ↓       ↓       ↓
                                       ttyd:7700 ttyd:7701 ttyd:77xx  (每个 session 一个)
                                          │       │       │
                                       dtach    dtach   dtach  (会话持久化)
                                          │       │       │
                                       opencode / claude / codex / cline  (实际 CLI 工具)
```

### 核心组件

| 组件 | 职责 |
|------|------|
| `auth-proxy.mjs` | HTTP 服务入口，监听 127.0.0.1:7681 |
| `lib/router.mjs` | 所有 HTTP 路由和 API 处理 |
| `lib/auth.mjs` | Token 验证、Cookie 会话管理 |
| `lib/sessions.mjs` | Session CRUD、ttyd 进程生命周期（spawn/kill/respawn） |
| `lib/proxy.mjs` | HTTP/WebSocket 反向代理，将 `/terminal/{id}` 转发到对应 ttyd 端口 |
| `lib/tools.mjs` | CLI 工具发现（which）、自定义工具注册 |
| `lib/config.mjs` | 端口、超时等环境变量配置 |
| `lib/templates.mjs` | HTML 模板加载 |
| `scripts/claude-ttyd-session` | shell 脚本，ttyd 的 wrapper，负责 source 环境变量 → cd 工作目录 → dtach 启动工具 |

### 数据流

1. **认证**：用户访问 `?token=xxx` → 验证 token → 种 HttpOnly Cookie → 后续请求用 Cookie
2. **创建 Session**：POST `/api/sessions` → 分配端口 → spawn ttyd 进程 → ttyd 执行 wrapper → dtach 启动 CLI 工具
3. **终端交互**：浏览器 iframe 加载 `/terminal/{id}` → auth-proxy 代理到 ttyd → WebSocket 双向传输终端 I/O
4. **会话持久**：dtach 保持进程不死，浏览器断开再连时 ttyd 重新 attach 到同一个 dtach socket

### 关键外部依赖

| 工具 | 用途 | 安装方式 |
|------|------|----------|
| ttyd | 将终端暴露为 HTTP/WebSocket 服务 | `brew install ttyd` |
| dtach | 终端会话持久化（类似 tmux 但更轻量） | `brew install dtach` |
| cloudflared | Cloudflare Tunnel，提供 HTTPS 公网访问 | `brew install cloudflared` |

### 文件存储

所有运行时数据存在 `~/.config/claude-web/`：

- `auth.json` — 访问 token
- `sessions.json` — 所有 session 元数据
- `tools.json` — 自定义工具配置
- `auth-sessions.json` — 浏览器会话 cookie
- `sockets/` — dtach socket 文件

## 当前 UI 结构

三个页面，全部是 Vanilla JS + HTML，无框架：

| 页面 | 路径 | 模板文件 | 用途 |
|------|------|----------|------|
| 登录页 | `/login` | `templates/login.html` | Token 输入/跳转 |
| 仪表盘 | `/` | `templates/dashboard.html` | 文件夹列表、新建 session、工具管理 |
| 文件夹视图 | `/folder/{path}` | `templates/folder-view.html` | 多 tab 终端，每个 tab 是一个 session 的 iframe |

终端展示方式：ttyd 自带的 xterm.js 前端，通过 iframe 嵌入到 folder-view 页面。

## API 列表

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/folders` | 获取按文件夹分组的 sessions |
| GET | `/api/sessions?folder=` | 获取 sessions（可按文件夹过滤） |
| POST | `/api/sessions` | 创建新 session |
| DELETE | `/api/sessions/{id}` | 删除 session |
| GET | `/api/tools` | 获取所有可用工具 |
| POST | `/api/tools` | 添加自定义工具 |
| DELETE | `/api/tools/{id}` | 删除自定义工具 |
| GET | `/api/autocomplete?q=` | 文件夹路径自动补全 |
| GET | `/api/browse?path=` | 目录浏览 |
| GET | `/api/diff?folder=` | 获取 Git diff |
| POST | `/api/clipboard-image` | 将图片写入 macOS 剪贴板 |
| ALL | `/terminal/{sessionId}/*` | 代理到 ttyd（HTTP + WebSocket） |

## 安全机制

- Token：256-bit 随机 hex，timing-safe 比较
- Cookie：HttpOnly + Secure + SameSite=Strict，默认 24h 过期
- 限流：登录失败指数退避（最长 15min），API 写操作 30次/分钟
- 网络：服务只监听 127.0.0.1，外部通过 Cloudflare Tunnel 访问
- CSP：nonce-based script allowlist
- 输入校验：工具命令禁止 shell 元字符，文件夹必须存在

## 已知问题与技术债

详见 `notes/体验问题与需求思考.md`，核心问题：

1. **手机上看终端体验差** — 终端原始输出在小屏幕上难以阅读，需要考虑做 chat UI 封装
2. **移动端无法新建 tab** — 功能缺失
3. **切换文件夹成本高** — 操作繁琐
4. **Login 流程不完善** — PWA 场景下异常兜底不足
5. **部分功能仅限 macOS** — 剪贴板（osascript）等功能依赖 macOS 特有工具；核心服务已支持 Linux
6. **HTML 模板巨大** — login.html 1500+ 行，folder-view.html 2000+ 行，全是 inline JS

## 开发约定

- **语言**：Node.js ES Modules（`"type": "module"`），纯 Node.js 内置模块，不用 Express
- **前端**：Vanilla JS，无构建工具，无框架
- **平台**：macOS 和 Linux（`"os": ["darwin", "linux"]`）
- **CLI 入口**：`cli.js` → `remotelab` 命令
- **服务管理**：macOS LaunchAgent plist / Linux systemd user service
- **代码风格**：模板用 `{{PLACEHOLDER}}` 占位符，nonce 注入防 XSS

## 迭代方向（已决定）

**路线 B 已选定**：chat server (`chat-server.mjs` + `chat/`) 是主线，终端架构是备用。

### 三服务架构（永久规范）

永远维持三个服务同时运行：

| 服务 | 端口 | 域名 | 状态 |
|------|------|------|------|
| `chat-server.mjs` | 7690 | `claude-v2.jiujianian-dev-world.win` | **生产稳定服务，已发布的版本** |
| `chat-server.mjs` | 7692 | `ttest.jiujianian-dev-world.win` | **测试服务，当前开发版本** |
| `auth-proxy.mjs` | 7681 | `claude.jiujianian-dev-world.win` | **终端应急通道，冻结不改** |

**工作流程**：
- 所有代码改动先在 `ttest` 服务（7692）上验证
- 验证通过后，重启生产服务（7690）使其生效
- `ttest` 服务用 `CHAT_PORT=7692 node chat-server.mjs` 启动，手动管理
- 生产服务（7690）由 LaunchAgent `com.chatserver.claude` 管理

终端服务（auth-proxy + lib/ + ttyd）**不做功能迭代，不做改动**。它存在的唯一价值是：chat server 崩了的时候，还有一条路能接触到终端去修问题。

`lib/` 目录下的公共模块（`auth.mjs`、`config.mjs`、`tools.mjs`、`utils.mjs`）两个服务都可以使用，不需要复制。

## 项目原则

1. **单用户项目，速度优先**：只有一个用户（自己），搞崩了可以慢慢修。不要让完美主义阻碍迭代速度。
2. **终端服务冻结**：`auth-proxy.mjs`、`lib/router.mjs`、`lib/sessions.mjs`、`lib/proxy.mjs` 这些文件不做改动，不做功能演进。
3. **必要的抽象可以做**：公共实现（如认证、安全中间件）可以提取复用，但不过度抽象。
4. **不引外部框架**：Node.js 内置模块 + `ws` 包，保持依赖最小。
5. **每次改动立即 commit**：每完成一个任务就提交一个新 commit，永远不用 `--amend`，只增加新 commit。
6. **始终保持三服务运行**：生产（7690）+ 测试（7692）+ 终端应急（7681），每次开发前先确认测试服务（7692）在跑，改完在测试服务验证，再视情况重启生产服务。
