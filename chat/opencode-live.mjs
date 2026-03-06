import {
  checkHealth, listSessions, getSessionStatus, getMessages,
  sendMessageAsync, abortSession, connectSSE,
} from './opencode-bridge.mjs';
import {
  messageEvent, toolUseEvent, toolResultEvent,
  reasoningEvent, statusEvent, usageEvent,
} from './normalizer.mjs';

const TAG = '[oc-live]';

let bridgeUrl = null;
let sseConnection = null;

// OpenCode session ID -> Set<ws>
const listeners = new Map();
// OpenCode session ID -> cached session info
const sessionCache = new Map();

export function isConnected() { return !!bridgeUrl; }
export function getUrl() { return bridgeUrl; }

export async function connect(url) {
  if (sseConnection) disconnect();

  const healthy = await checkHealth(url);
  if (!healthy) throw new Error('OpenCode server not reachable at ' + url);

  bridgeUrl = url;
  await refreshSessions();

  sseConnection = connectSSE(url, handleSSEEvent, (err) => {
    console.error(`${TAG} SSE error: ${err.message}`);
  });

  console.log(`${TAG} Connected to ${url}, ${sessionCache.size} sessions`);
  return getCachedSessions();
}

export function disconnect() {
  if (sseConnection) { sseConnection.close(); sseConnection = null; }
  bridgeUrl = null;
  sessionCache.clear();
  listeners.clear();
  console.log(`${TAG} Disconnected`);
}

export async function refreshSessions() {
  if (!bridgeUrl) return [];

  const [sessions, statuses] = await Promise.all([
    listSessions(bridgeUrl),
    getSessionStatus(bridgeUrl).catch(() => ({})),
  ]);

  sessionCache.clear();
  for (const s of sessions) {
    const st = statuses[s.id];
    sessionCache.set(s.id, {
      id: `oc:${s.id}`,
      ocId: s.id,
      name: s.title || s.slug || 'OpenCode Session',
      tool: 'opencode-live',
      folder: s.directory || '~',
      status: st?.active ? 'running' : 'idle',
      bridge: true,
      created: s.time?.created ? new Date(s.time.created).toISOString() : new Date().toISOString(),
    });
  }
  return getCachedSessions();
}

export function getCachedSessions() {
  return [...sessionCache.values()];
}

export function getSession(sessionId) {
  const ocId = toOcId(sessionId);
  return sessionCache.get(ocId) || null;
}

export function subscribe(sessionId, ws) {
  const ocId = toOcId(sessionId);
  if (!listeners.has(ocId)) listeners.set(ocId, new Set());
  listeners.get(ocId).add(ws);
}

export function unsubscribe(sessionId, ws) {
  const ocId = toOcId(sessionId);
  const set = listeners.get(ocId);
  if (set) { set.delete(ws); if (set.size === 0) listeners.delete(ocId); }
}

function broadcast(ocId, msg) {
  const set = listeners.get(ocId);
  if (!set) return;
  const data = JSON.stringify(msg);
  for (const ws of set) {
    try { if (ws.readyState === 1) ws.send(data); } catch {}
  }
}

/**
 * Fetch message history from OpenCode API and convert to RemoteLab events.
 */
export async function getHistory(sessionId) {
  if (!bridgeUrl) return [];
  const ocId = toOcId(sessionId);

  const messages = await getMessages(bridgeUrl, ocId);
  const events = [];

  for (const msg of messages) {
    const role = msg.info?.role === 'user' ? 'user' : 'assistant';

    for (const part of (msg.parts || [])) {
      switch (part.type) {
        case 'text':
          if (part.text) events.push(messageEvent(role, part.text));
          break;
        case 'reasoning':
          if (part.text) events.push(reasoningEvent(part.text));
          break;
        case 'tool-use':
        case 'tool_use': {
          const tool = part.tool || part.name || 'tool';
          const input = typeof part.input === 'string'
            ? part.input
            : JSON.stringify(part.input || part.state?.input || {}, null, 2);
          events.push(toolUseEvent(tool, input));
          if (part.output || part.state?.output) {
            events.push(toolResultEvent(tool, part.output || part.state?.output));
          } else if (part.state?.title) {
            events.push(toolResultEvent(tool, part.state.title));
          }
          break;
        }
        case 'tool-result':
        case 'tool_result': {
          const tool = part.tool || part.name || 'tool';
          events.push(toolResultEvent(tool, part.output || part.text || ''));
          break;
        }
        case 'step-start':
          break;
        case 'step-finish':
          if (part.tokens) {
            events.push(usageEvent(part.tokens.input || 0, part.tokens.output || 0));
          }
          break;
      }
    }
  }

  return events;
}

/**
 * Send a message to an OpenCode session.
 */
export async function send(sessionId, text) {
  if (!bridgeUrl) throw new Error('Not connected to OpenCode');
  const ocId = toOcId(sessionId);

  const userEvt = messageEvent('user', text);
  broadcast(ocId, { type: 'event', event: userEvt });

  const cached = sessionCache.get(ocId);
  if (cached) {
    cached.status = 'running';
    broadcast(ocId, { type: 'session', session: cached });
  }

  return sendMessageAsync(bridgeUrl, ocId, text);
}

/**
 * Cancel/abort a running OpenCode session.
 */
export async function cancel(sessionId) {
  if (!bridgeUrl) throw new Error('Not connected to OpenCode');
  const ocId = toOcId(sessionId);
  const ok = await abortSession(bridgeUrl, ocId);

  const cached = sessionCache.get(ocId);
  if (cached) {
    cached.status = 'idle';
    broadcast(ocId, { type: 'session', session: cached });
  }
  broadcast(ocId, { type: 'event', event: statusEvent('cancelled') });

  return ok;
}

// --- SSE event handling ---

function handleSSEEvent(eventType, data) {
  if (eventType === 'server.connected') {
    console.log(`${TAG} SSE server.connected`);
    return;
  }

  console.log(`${TAG} SSE: ${eventType} ${JSON.stringify(data).slice(0, 200)}`);

  if (!data || typeof data !== 'object') return;

  const properties = data.properties || data;
  const sessionId = properties.sessionID || properties.session_id || data.sessionID;

  // Session status changes
  if (eventType.startsWith('session.')) {
    handleSessionEvent(eventType, properties);
    return;
  }

  // Message/part events → convert and broadcast
  if (sessionId) {
    const events = convertPartEvent(eventType, properties);
    for (const evt of events) {
      broadcast(sessionId, { type: 'event', event: evt });
    }
  }
}

function handleSessionEvent(eventType, data) {
  const id = data.id || data.sessionID;
  if (!id) return;

  const cached = sessionCache.get(id);
  if (!cached) return;

  if (eventType === 'session.updated' || eventType === 'session.status') {
    if (data.title) cached.name = data.title;
    if (data.status !== undefined) {
      cached.status = (data.status === 'busy' || data.status === 'running') ? 'running' : 'idle';
    }
  }

  if (eventType === 'session.completed' || eventType === 'session.idle') {
    cached.status = 'idle';
  }

  broadcast(id, { type: 'session', session: cached });
}

function convertPartEvent(eventType, data) {
  const events = [];
  const type = data.type;

  if (!type) return events;

  switch (type) {
    case 'text':
      if (data.text) events.push(messageEvent('assistant', data.text));
      break;
    case 'reasoning':
      if (data.text) events.push(reasoningEvent(data.text));
      break;
    case 'tool-use':
    case 'tool_use': {
      const tool = data.tool || data.name || 'tool';
      const input = typeof data.input === 'string'
        ? data.input
        : JSON.stringify(data.input || data.state?.input || {}, null, 2);
      events.push(toolUseEvent(tool, input));
      if (data.output || data.state?.output) {
        events.push(toolResultEvent(tool, data.output || data.state.output));
      }
      break;
    }
    case 'tool-result':
    case 'tool_result': {
      const tool = data.tool || data.name || 'tool';
      events.push(toolResultEvent(tool, data.output || data.text || ''));
      break;
    }
    case 'step-start':
      events.push(statusEvent('thinking...'));
      break;
    case 'step-finish':
      if (data.reason === 'stop') {
        events.push(statusEvent('completed'));
        const sid = data.sessionID;
        if (sid && sessionCache.has(sid)) {
          const c = sessionCache.get(sid);
          c.status = 'idle';
          broadcast(sid, { type: 'session', session: c });
        }
      }
      if (data.tokens) {
        events.push(usageEvent(data.tokens.input || 0, data.tokens.output || 0));
      }
      break;
  }

  return events;
}

function toOcId(sessionId) {
  return sessionId.startsWith('oc:') ? sessionId.slice(3) : sessionId;
}

export function isBridgeSession(sessionId) {
  return sessionId.startsWith('oc:');
}
