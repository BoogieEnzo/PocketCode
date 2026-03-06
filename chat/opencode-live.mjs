import {
  checkHealth, listSessions, getSessionStatus, getMessages,
  sendMessageAsync, abortSession, connectSSE,
} from './opencode-bridge.mjs';
import {
  messageEvent, toolUseEvent, toolResultEvent,
  reasoningEvent, statusEvent, usageEvent,
} from './normalizer.mjs';

const TAG = '[oc-live]';
const MAX_BRIDGE_SESSIONS = 10;

let bridgeUrl = null;
let sseConnection = null;

// OpenCode session ID -> Set<ws>
const listeners = new Map();
// OpenCode session ID -> cached session info
const sessionCache = new Map();
// OpenCode message ID -> role(user/assistant), filled from message.updated events
const messageRoleCache = new Map();
// OpenCode session ID -> { model?: {providerID, modelID}, agent?: string }
const sessionRoutingCache = new Map();

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
  messageRoleCache.clear();
  sessionRoutingCache.clear();
  console.log(`${TAG} Disconnected`);
}

export async function refreshSessions() {
  if (!bridgeUrl) return [];

  const [sessions, statuses] = await Promise.all([
    listSessions(bridgeUrl),
    getSessionStatus(bridgeUrl).catch(() => ({})),
  ]);

  // Keep only the most recent sessions for mobile readability.
  const recentSessions = [...sessions]
    .sort((a, b) => {
      const ta = a?.time?.updated || a?.time?.created || 0;
      const tb = b?.time?.updated || b?.time?.created || 0;
      return tb - ta;
    })
    .slice(0, MAX_BRIDGE_SESSIONS);

  sessionCache.clear();
  for (const s of recentSessions) {
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

  const cached = sessionCache.get(ocId);
  if (cached) {
    cached.status = 'running';
    broadcast(ocId, { type: 'session', session: cached });
  }

  const routing = await getSessionRouting(ocId);
  return sendMessageAsync(bridgeUrl, ocId, text, {
    model: routing.model,
    agent: routing.agent,
  });
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
  if (!data || typeof data !== 'object') return;
  const busType = data.type || eventType;
  const properties = data.properties || {};

  if (busType === 'server.connected' || busType === 'server.heartbeat') {
    return;
  }

  console.log(`${TAG} SSE: ${busType} ${JSON.stringify(properties).slice(0, 200)}`);

  if (busType.startsWith('session.')) {
    handleSessionEvent(busType, properties);
    return;
  }

  // Cache message role so subsequent part updates can render with correct side.
  if (busType === 'message.updated' && properties.info?.id && properties.info?.role) {
    messageRoleCache.set(properties.info.id, properties.info.role);
    updateSessionRoutingFromInfo(properties.info);
    return;
  }

  // OpenCode streams message parts through message.part.updated events.
  if (busType === 'message.part.updated') {
    const part = properties.part;
    const sessionId = part?.sessionID;
    if (!sessionId || !part) return;
    const events = convertPartEvent(part);
    for (const evt of events) {
      broadcast(sessionId, { type: 'event', event: evt });
    }
  }
}

function handleSessionEvent(eventType, data) {
  const id = data.info?.id || data.id || data.sessionID;
  if (!id) return;

  const cached = sessionCache.get(id);
  if (!cached) return; // ignore sessions outside recent-10 list

  if (eventType === 'session.updated') {
    if (data.info?.title) cached.name = data.info.title;
  }

  if (eventType === 'session.status') {
    const st = data.status?.type || data.status;
    cached.status = (st === 'busy' || st === 'running') ? 'running' : 'idle';
  }

  if (eventType === 'session.completed' || eventType === 'session.idle') {
    cached.status = 'idle';
  }

  if (eventType === 'session.error') {
    const msg = data.error?.data?.message || data.error?.message || 'Unknown OpenCode error';
    broadcast(id, { type: 'event', event: statusEvent(`error: ${msg}`) });
    cached.status = 'idle';
  }

  broadcast(id, { type: 'session', session: cached });
}

function convertPartEvent(data) {
  const events = [];
  const type = data.type;
  const inferredRole = messageRoleCache.get(data.messageID) || 'assistant';

  if (!type) return events;

  switch (type) {
    case 'text':
      if (data.text) events.push(messageEvent(inferredRole, data.text));
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

function modelFromInfo(info) {
  if (!info) return undefined;
  if (info.model && typeof info.model === 'object' && info.model.providerID && info.model.modelID) {
    return { providerID: info.model.providerID, modelID: info.model.modelID };
  }
  if (info.providerID && info.modelID) {
    return { providerID: info.providerID, modelID: info.modelID };
  }
  return undefined;
}

function updateSessionRoutingFromInfo(info) {
  const sessionID = info?.sessionID;
  if (!sessionID) return;
  const routing = sessionRoutingCache.get(sessionID) || {};
  const model = modelFromInfo(info);
  if (model) routing.model = model;
  if (info.agent) routing.agent = info.agent;
  if (routing.model || routing.agent) sessionRoutingCache.set(sessionID, routing);
}

async function getSessionRouting(ocId) {
  const cached = sessionRoutingCache.get(ocId);
  if (cached?.model || cached?.agent) return cached;

  // Bootstrap from recent history. Prefer assistant model first.
  const msgs = await getMessages(bridgeUrl, ocId, 20).catch(() => []);
  let chosenInfo = null;

  for (const m of msgs) {
    if (m?.info?.role === 'assistant' && modelFromInfo(m.info)) {
      chosenInfo = m.info;
      break;
    }
  }
  if (!chosenInfo) {
    for (const m of msgs) {
      if (modelFromInfo(m?.info)) {
        chosenInfo = m.info;
        break;
      }
    }
  }

  const routing = {};
  if (chosenInfo) {
    const model = modelFromInfo(chosenInfo);
    if (model) routing.model = model;
    if (chosenInfo.agent) routing.agent = chosenInfo.agent;
  }
  sessionRoutingCache.set(ocId, routing);
  return routing;
}

export function isBridgeSession(sessionId) {
  return sessionId.startsWith('oc:');
}
