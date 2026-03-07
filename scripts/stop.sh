#!/bin/bash
echo "Stopping RemoteLab services..."
systemctl --user stop remotelab-chat.service 2>/dev/null || echo "chat-server not running"
systemctl --user stop remotelab-proxy.service 2>/dev/null || echo "auth-proxy not running"
systemctl --user stop remotelab-tunnel.service 2>/dev/null || true
echo "Services stopped!"
