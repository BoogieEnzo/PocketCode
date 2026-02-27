# Prompt: 给女朋友的 Claude Code 一键配置指南

## 使用方式

把下面的 prompt 完整发给女朋友，让她在自己电脑的 Claude Code 里粘贴执行。

---

## Prompt（复制以下全部内容）

```
帮我在这台电脑上配置 remotelab，实现从浏览器远程访问 Claude Code。

请按以下步骤执行：

### 第一阶段：安装依赖和仓库

1. 安装 brew 依赖：`brew install dtach ttyd cloudflared`
2. 克隆仓库到 ~/code/remotelab：`git clone https://github.com/Ninglo/remotelab.git ~/code/remotelab`
3. 进入目录执行 `npm link` 注册全局命令

### 第二阶段：Cloudflare 认证

这一步需要我手动操作。请运行 `cloudflared tunnel login`，它会打开浏览器让我登录 Cloudflare 并选择域名 `jiujianian-dev-world.win`。等我操作完成后告诉你继续。

### 第三阶段：创建 Tunnel 和配置服务

等我确认 Cloudflare 认证完成后，继续执行：

1. 创建 tunnel：`cloudflared tunnel create remotelab`
2. 从输出中获取 tunnel ID（UUID 格式），然后配置 DNS：
   `cloudflared tunnel route dns remotelab gf-claude.jiujianian-dev-world.win`
3. 创建 cloudflared 配置文件 `~/.cloudflared/config.yml`，内容为：
   ```
   tunnel: remotelab
   credentials-file: /Users/<当前用户>/.cloudflared/<tunnel-id>.json
   protocol: http2

   ingress:
     - hostname: gf-claude.jiujianian-dev-world.win
       service: http://localhost:7681
     - service: http_status:404
   ```
   注意用实际的用户名和 tunnel ID 替换占位符。

4. 创建 auth-proxy 的 LaunchAgent plist 文件 `~/Library/LaunchAgents/com.authproxy.claude.plist`：
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
     "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
       <key>Label</key>
       <string>com.authproxy.claude</string>
       <key>ProgramArguments</key>
       <array>
           <string>node的绝对路径(用which node获取)</string>
           <string>/Users/<当前用户>/code/remotelab/auth-proxy.mjs</string>
       </array>
       <key>RunAtLoad</key>
       <true/>
       <key>KeepAlive</key>
       <true/>
       <key>WorkingDirectory</key>
       <string>/Users/<当前用户></string>
       <key>StandardOutPath</key>
       <string>/Users/<当前用户>/Library/Logs/auth-proxy.log</string>
       <key>StandardErrorPath</key>
       <string>/Users/<当前用户>/Library/Logs/auth-proxy.error.log</string>
   </dict>
   </plist>
   ```

5. 创建 cloudflared 的 LaunchAgent plist 文件 `~/Library/LaunchAgents/com.cloudflared.tunnel.plist`：
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
     "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
       <key>Label</key>
       <string>com.cloudflared.tunnel</string>
       <key>ProgramArguments</key>
       <array>
           <string>cloudflared的绝对路径(用which cloudflared获取)</string>
           <string>tunnel</string>
           <string>run</string>
       </array>
       <key>RunAtLoad</key>
       <true/>
       <key>KeepAlive</key>
       <true/>
       <key>WorkingDirectory</key>
       <string>/Users/<当前用户></string>
       <key>StandardOutPath</key>
       <string>/Users/<当前用户>/Library/Logs/cloudflared.log</string>
       <key>StandardErrorPath</key>
       <string>/Users/<当前用户>/Library/Logs/cloudflared.error.log</string>
   </dict>
   </plist>
   ```

6. 创建 dtach wrapper 脚本。把仓库里的 `claude-ttyd-session` 文件链接到 `~/.local/bin/`：
   ```bash
   mkdir -p ~/.local/bin
   cp ~/code/remotelab/claude-ttyd-session ~/.local/bin/claude-ttyd-session
   chmod +x ~/.local/bin/claude-ttyd-session
   ```
   然后检查 `~/.local/bin/claude-ttyd-session` 的第一行是 `#!/bin/zsh`（不是 bash），并且在 source zshrc 之前有一行 `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"`。

7. 生成 access token：`remotelab generate-token`

8. 启动所有服务：
   ```bash
   launchctl load ~/Library/LaunchAgents/com.authproxy.claude.plist
   launchctl load ~/Library/LaunchAgents/com.cloudflared.tunnel.plist
   ```

9. 等几秒后验证服务状态：
   - `launchctl list | grep -E 'authproxy|cloudflared'` 应该都有 PID
   - `tail -5 ~/Library/Logs/auth-proxy.log` 应该看到 "Auth proxy listening"
   - `tail -5 ~/Library/Logs/cloudflared.error.log` 应该看到 "Registered tunnel connection"

10. 最后把 generate-token 输出的 Access URL 告诉我，我用浏览器打开就能用了。

所有 plist 文件中的路径都必须是绝对路径，用 `which node`、`which cloudflared` 和 `whoami` 获取真实值，不要用 ~ 或相对路径。
```
