import { WebSocketServer } from 'ws';
import { isAuthenticated, parseCookies } from '../lib/auth.mjs';
import {
  createSession, deleteSession, getSession, listSessions,
  subscribe, unsubscribe, sendMessage, cancelSession, getHistory,
  renameSession, compactSession, dropToolUse,
} from './session-manager.mjs';
import * as ocLive from './opencode-live.mjs';

/**
 * Attach WebSocket handling to an HTTP server.
 */
export function attachWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    // Only handle /ws path
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    // Authenticate via cookie
    if (!isAuthenticated(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    let attachedSessionId = null;
    console.log('[ws] Client connected');

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        wsSend(ws, { type: 'error', message: 'Invalid JSON' });
        return;
      }

      console.log(`[ws] ← ${JSON.stringify(msg).slice(0, 200)}`);

      try {
        handleMessage(ws, msg, {
          getAttached: () => attachedSessionId,
          setAttached: (id) => { attachedSessionId = id; },
        });
      } catch (err) {
        console.error(`[ws] handleMessage error: ${err.message}`);
        wsSend(ws, { type: 'error', message: err.message });
      }
    });

    ws.on('close', () => {
      console.log(`[ws] Client disconnected (was attached to ${attachedSessionId?.slice(0,8) || 'none'})`);
      if (attachedSessionId) {
        if (ocLive.isBridgeSession(attachedSessionId)) {
          ocLive.unsubscribe(attachedSessionId, ws);
        } else {
          unsubscribe(attachedSessionId, ws);
        }
      }
    });
  });

  return wss;
}

function wsSend(ws, data) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

function handleMessage(ws, msg, ctx) {
  switch (msg.action) {
    case 'list': {
      const sessions = listSessions();
      const bridgeSessions = ocLive.isConnected() ? ocLive.getCachedSessions() : [];
      wsSend(ws, { type: 'sessions', sessions: [...sessions, ...bridgeSessions] });
      break;
    }

    case 'create': {
      if (!msg.tool) {
        wsSend(ws, { type: 'error', message: 'tool is required' });
        return;
      }
      // If OpenCode bridge is connected, creating an "opencode" session should
      // create a real OpenCode server session (oc:...), not a local CLI one.
      if (msg.tool === 'opencode' && ocLive.isConnected()) {
        ocLive.createSession({
          directory: typeof msg.folder === 'string' ? msg.folder : undefined,
          title: typeof msg.name === 'string' ? msg.name : undefined,
        }).then((session) => {
          wsSend(ws, { type: 'session', session });
          wsSend(ws, { type: 'sessions', sessions: [...listSessions(), ...ocLive.getCachedSessions()] });
        }).catch((err) => {
          wsSend(ws, { type: 'error', message: 'OpenCode create failed: ' + err.message });
        });
        return;
      }
      const folder = msg.folder || process.env.HOME || '/home/fengde';
      const session = createSession(folder, msg.tool, msg.name || '');
      wsSend(ws, { type: 'session', session });
      break;
    }

    case 'rename': {
      if (!msg.sessionId || typeof msg.name !== 'string') {
        wsSend(ws, { type: 'error', message: 'sessionId and name are required' });
        return;
      }
      const updated = renameSession(msg.sessionId, msg.name.trim());
      if (!updated) {
        wsSend(ws, { type: 'error', message: 'Session not found' });
      }
      break;
    }

    case 'delete': {
      if (!msg.sessionId) {
        wsSend(ws, { type: 'error', message: 'sessionId is required' });
        return;
      }
      const ok = deleteSession(msg.sessionId);
      if (ok) {
        wsSend(ws, { type: 'deleted', sessionId: msg.sessionId });
      } else {
        wsSend(ws, { type: 'error', message: 'Session not found' });
      }
      break;
    }

    case 'attach': {
      if (!msg.sessionId) {
        wsSend(ws, { type: 'error', message: 'sessionId is required' });
        return;
      }
      // Detach from previous session
      const prev = ctx.getAttached();
      if (prev) {
        if (ocLive.isBridgeSession(prev)) ocLive.unsubscribe(prev, ws);
        else unsubscribe(prev, ws);
      }

      ctx.setAttached(msg.sessionId);

      if (ocLive.isBridgeSession(msg.sessionId)) {
        ocLive.subscribe(msg.sessionId, ws);
        const session = ocLive.getSession(msg.sessionId);
        if (session) wsSend(ws, { type: 'session', session });
        ocLive.getHistory(msg.sessionId).then(events => {
          wsSend(ws, { type: 'history', events });
          if (session && session.status === 'running') {
            wsSend(ws, { type: 'session', session });
          }
        }).catch(err => {
          console.error('[ws] bridge getHistory error:', err.message);
          wsSend(ws, { type: 'history', events: [] });
        });
      } else {
        subscribe(msg.sessionId, ws);
        const session = getSession(msg.sessionId);
        if (session) wsSend(ws, { type: 'session', session });
        const events = getHistory(msg.sessionId);
        wsSend(ws, { type: 'history', events });
        if (session && session.status === 'running') {
          wsSend(ws, { type: 'session', session });
        }
      }
      break;
    }

    case 'send': {
      const sessionId = ctx.getAttached();
      if (!sessionId) {
        wsSend(ws, { type: 'error', message: 'Not attached to a session. Send "attach" first.' });
        return;
      }
      if (!msg.text || typeof msg.text !== 'string') {
        wsSend(ws, { type: 'error', message: 'text is required' });
        return;
      }
      if (ocLive.isBridgeSession(sessionId)) {
        // Bridge mode: defer model selection to OpenCode session itself.
        // This keeps /models choice in OpenCode TUI authoritative.
        ocLive.send(sessionId, msg.text.trim()).catch(err => {
          wsSend(ws, { type: 'error', message: 'OpenCode send failed: ' + err.message });
        });
      } else {
        const session = getSession(sessionId);
        const effectiveTool = msg.tool || session?.tool;
        const isOpencode = effectiveTool === 'opencode';
        sendMessage(sessionId, msg.text.trim(), msg.images, {
          tool: msg.tool || undefined,
          thinking: !!msg.thinking,
          model: isOpencode ? undefined : (msg.model || undefined),
          effort: msg.effort || undefined,
        });
      }
      break;
    }

    case 'cancel': {
      const sessionId = ctx.getAttached();
      if (!sessionId) {
        wsSend(ws, { type: 'error', message: 'Not attached to a session' });
        return;
      }
      if (ocLive.isBridgeSession(sessionId)) {
        ocLive.cancel(sessionId).catch(err => {
          wsSend(ws, { type: 'error', message: 'OpenCode cancel failed: ' + err.message });
        });
      } else {
        cancelSession(sessionId);
      }
      break;
    }

    case 'compact': {
      const sessionId = ctx.getAttached();
      if (!sessionId) {
        wsSend(ws, { type: 'error', message: 'Not attached to a session' });
        return;
      }
      compactSession(sessionId);
      break;
    }

    case 'drop_tools': {
      const sessionId = ctx.getAttached();
      if (!sessionId) {
        wsSend(ws, { type: 'error', message: 'Not attached to a session' });
        return;
      }
      dropToolUse(sessionId);
      break;
    }

    case 'opencode_connect': {
      const url = msg.url || 'http://127.0.0.1:4096';
      ocLive.connect(url).then(sessions => {
        wsSend(ws, { type: 'opencode_connected', url, sessions });
        wsSend(ws, { type: 'sessions', sessions: [...listSessions(), ...sessions] });
      }).catch(err => {
        wsSend(ws, { type: 'error', message: 'OpenCode connect failed: ' + err.message });
      });
      break;
    }

    case 'opencode_disconnect': {
      ocLive.disconnect();
      wsSend(ws, { type: 'opencode_disconnected' });
      wsSend(ws, { type: 'sessions', sessions: listSessions() });
      break;
    }

    case 'opencode_refresh': {
      if (!ocLive.isConnected()) {
        wsSend(ws, { type: 'error', message: 'Not connected to OpenCode' });
        return;
      }
      ocLive.refreshSessions().then(sessions => {
        wsSend(ws, { type: 'sessions', sessions: [...listSessions(), ...sessions] });
      }).catch(err => {
        wsSend(ws, { type: 'error', message: 'OpenCode refresh failed: ' + err.message });
      });
      break;
    }

    default:
      wsSend(ws, { type: 'error', message: `Unknown action: ${msg.action}` });
  }
}
