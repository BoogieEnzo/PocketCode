#!/bin/bash
echo "Starting RemoteLab services..."
systemctl --user start remotelab-chat.service
systemctl --user start remotelab-proxy.service
if systemctl --user list-unit-files remotelab-tunnel.service &>/dev/null; then
  systemctl --user start remotelab-tunnel.service
fi
echo "Services started!"
echo ""
echo "Check status with:"
echo "  systemctl --user status remotelab-chat remotelab-proxy"
echo ""
echo "View logs:"
echo "  journalctl --user -u remotelab-chat -f"
echo "  journalctl --user -u remotelab-proxy -f"
