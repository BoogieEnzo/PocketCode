import http from 'http';

const TAG = '[oc-bridge]';

function request(baseUrl, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        'Accept': 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 204) return resolve({ status: 204, data: null });
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

export async function checkHealth(baseUrl) {
  try {
    const { status, data } = await request(baseUrl, '/global/health');
    return status === 200 && data?.healthy;
  } catch {
    return false;
  }
}

export async function listSessions(baseUrl) {
  const { data } = await request(baseUrl, '/session');
  return Array.isArray(data) ? data : [];
}

export async function getSessionStatus(baseUrl) {
  const { data } = await request(baseUrl, '/session/status');
  return data || {};
}

export async function getMessages(baseUrl, sessionId, limit) {
  const q = limit ? `?limit=${limit}` : '';
  const { data } = await request(baseUrl, `/session/${sessionId}/message${q}`);
  return Array.isArray(data) ? data : [];
}

export async function sendMessageAsync(baseUrl, sessionId, text) {
  const { status } = await request(baseUrl, `/session/${sessionId}/prompt_async`, {
    method: 'POST',
    body: { parts: [{ type: 'text', text }] },
  });
  return status === 204 || status === 200;
}

export async function abortSession(baseUrl, sessionId) {
  const { status } = await request(baseUrl, `/session/${sessionId}/abort`, {
    method: 'POST',
  });
  return status === 200;
}

/**
 * Subscribe to SSE event stream. Auto-reconnects on disconnect.
 * Returns { close }.
 */
export function connectSSE(baseUrl, onEvent, onError) {
  const url = new URL('/event', baseUrl);
  let destroyed = false;
  let currentReq = null;

  function connect() {
    if (destroyed) return;
    console.log(`${TAG} SSE connecting to ${url.href}`);

    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: { 'Accept': 'text/event-stream', 'Cache-Control': 'no-cache' },
    }, (res) => {
      let buffer = '';
      let eventType = '';
      let dataLines = [];

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5));
          } else if (line === '' || line === '\r') {
            if (dataLines.length > 0) {
              const raw = dataLines.join('\n').trim();
              let parsed;
              try { parsed = JSON.parse(raw); } catch { parsed = raw; }
              try { onEvent(eventType || 'message', parsed); } catch (e) {
                console.error(`${TAG} onEvent error:`, e.message);
              }
            }
            eventType = '';
            dataLines = [];
          }
        }
      });

      res.on('end', () => {
        if (!destroyed) {
          console.log(`${TAG} SSE ended, reconnecting in 3s`);
          setTimeout(connect, 3000);
        }
      });

      res.on('error', (err) => {
        if (!destroyed) {
          console.error(`${TAG} SSE error: ${err.message}`);
          setTimeout(connect, 3000);
        }
      });
    });

    req.on('error', (err) => {
      if (!destroyed) {
        console.error(`${TAG} SSE connect error: ${err.message}`);
        setTimeout(connect, 3000);
      }
    });

    currentReq = req;
    req.end();
  }

  connect();

  return {
    close() {
      destroyed = true;
      try { currentReq?.destroy(); } catch {}
    },
  };
}
