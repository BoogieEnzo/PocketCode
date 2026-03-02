import { existsSync, statSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve, dirname, basename } from 'path';
import { parse as parseUrl, fileURLToPath } from 'url';
import { SESSION_EXPIRY, CHAT_IMAGES_DIR } from '../lib/config.mjs';
import {
  sessions, saveAuthSessions,
  verifyToken, generateToken,
  parseCookies, setCookie, clearCookie,
} from '../lib/auth.mjs';
import { getAvailableTools } from '../lib/tools.mjs';
import { listSessions, getSession, createSession, deleteSession } from './session-manager.mjs';
import { getSidebarState } from './summarizer.mjs';
import { readBody } from '../lib/utils.mjs';
import {
  getClientIp, isRateLimited, recordFailedAttempt, clearFailedAttempts,
  setSecurityHeaders, generateNonce, requireAuth,
} from './middleware.mjs';

// Paths (files are read from disk on each request for hot-reload)
const __dirname = dirname(fileURLToPath(import.meta.url));
const chatTemplatePath = join(__dirname, '..', 'templates', 'chat.html');
const staticDir = join(__dirname, '..', 'static');

const staticMimeTypes = {
  'manifest.json': 'application/manifest+json',
  'icon.svg': 'image/svg+xml',
  'apple-touch-icon.png': 'image/png',
  'chat.js': 'application/javascript',
  'marked.min.js': 'application/javascript',
};

export async function handleRequest(req, res) {
  const parsedUrl = parseUrl(req.url, true);
  const pathname = parsedUrl.pathname;

  // Static assets (read from disk each time for hot-reload)
  const staticName = pathname.slice(1); // strip leading /
  if (staticMimeTypes[staticName]) {
    try {
      const content = readFileSync(join(staticDir, staticName));
      res.writeHead(200, { 'Content-Type': staticMimeTypes[staticName], 'Cache-Control': 'no-cache' });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
    return;
  }

  const nonce = generateNonce();
  setSecurityHeaders(res, nonce);

  // Token auth via query
  const queryToken = parsedUrl.query.token;
  if (queryToken) {
    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
      res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '60' });
      res.end('Too many failed attempts. Please try again later.');
      return;
    }
    if (verifyToken(queryToken)) {
      clearFailedAttempts(ip);
      const sessionToken = generateToken();
      sessions.set(sessionToken, { expiry: Date.now() + SESSION_EXPIRY });
      saveAuthSessions();
      res.writeHead(302, { 'Location': '/', 'Set-Cookie': setCookie(sessionToken) });
      res.end();
    } else {
      recordFailedAttempt(ip);
      res.writeHead(302, { 'Location': '/login' });
      res.end();
    }
    return;
  }

  // Login page (minimal)
  if (pathname === '/login') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RemoteLab Chat - Login</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#e5e5e5}
.box{text-align:center;padding:2rem}h1{font-size:1.5rem;margin-bottom:1rem}
p{color:#888}a{color:#60a5fa}</style></head>
<body><div class="box"><h1>RemoteLab Chat</h1><p>Append <code>?token=YOUR_TOKEN</code> to the URL to log in.</p></div></body></html>`);
    return;
  }

  // Logout
  if (pathname === '/logout') {
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies.session_token;
    if (token) { sessions.delete(token); saveAuthSessions(); }
    res.writeHead(302, { 'Location': '/login', 'Set-Cookie': clearCookie() });
    res.end();
    return;
  }

  // Auth required from here on
  if (!requireAuth(req, res)) return;

  // ---- API endpoints ----

  if (pathname === '/api/sessions' && req.method === 'GET') {
    const sessionList = listSessions();
    const folderFilter = parsedUrl.query.folder;
    const filtered = folderFilter
      ? sessionList.filter(s => s.folder === folderFilter)
      : sessionList;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: filtered }));
    return;
  }

  if (pathname === '/api/sessions' && req.method === 'POST') {
    let body;
    try { body = await readBody(req, 10240); } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        return;
      }
      throw err;
    }
    try {
      const { folder, tool } = JSON.parse(body);
      if (!folder || !tool) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'folder and tool are required' }));
        return;
      }
      const resolvedFolder = folder.startsWith('~')
        ? join(homedir(), folder.slice(1))
        : resolve(folder);
      if (!existsSync(resolvedFolder) || !statSync(resolvedFolder).isDirectory()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Folder does not exist' }));
        return;
      }
      const session = createSession(resolvedFolder, tool);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
    return;
  }

  if (pathname.startsWith('/api/sessions/') && req.method === 'DELETE') {
    const id = pathname.split('/').pop();
    const ok = deleteSession(id);
    if (ok) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
    }
    return;
  }

  if (pathname === '/api/tools' && req.method === 'GET') {
    const tools = getAvailableTools();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tools }));
    return;
  }

  if (pathname === '/api/sidebar' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getSidebarState()));
    return;
  }

  if (pathname === '/api/autocomplete' && req.method === 'GET') {
    const query = parsedUrl.query.q || '';
    const suggestions = [];
    try {
      const resolvedQuery = query.startsWith('~') ? join(homedir(), query.slice(1)) : query;
      const parentDir = dirname(resolvedQuery);
      const prefix = basename(resolvedQuery);
      if (existsSync(parentDir) && statSync(parentDir).isDirectory()) {
        for (const entry of readdirSync(parentDir)) {
          if (!prefix.startsWith('.') && entry.startsWith('.')) continue;
          const fullPath = join(parentDir, entry);
          if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
            if (entry.toLowerCase().startsWith(prefix.toLowerCase())) {
              suggestions.push(fullPath);
            }
          }
        }
      }
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ suggestions: suggestions.slice(0, 20) }));
    return;
  }

  if (pathname === '/api/browse' && req.method === 'GET') {
    const pathQuery = parsedUrl.query.path || '~';
    try {
      const resolvedPath = pathQuery === '~' || pathQuery === ''
        ? homedir()
        : pathQuery.startsWith('~')
          ? join(homedir(), pathQuery.slice(1))
          : resolve(pathQuery);
      const children = [];
      let parent = null;
      if (existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) {
        const parentPath = dirname(resolvedPath);
        parent = parentPath !== resolvedPath ? parentPath : null;
        for (const entry of readdirSync(resolvedPath)) {
          if (entry.startsWith('.')) continue;
          const fullPath = join(resolvedPath, entry);
          try {
            if (statSync(fullPath).isDirectory()) children.push({ name: entry, path: fullPath });
          } catch {}
        }
        children.sort((a, b) => a.name.localeCompare(b.name));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: resolvedPath, parent, children }));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to browse directory' }));
    }
    return;
  }

  // Serve uploaded images
  if (pathname.startsWith('/api/images/') && req.method === 'GET') {
    const filename = pathname.slice('/api/images/'.length);
    // Sanitize: only allow alphanumeric, dash, underscore, dot
    if (!/^[a-zA-Z0-9_-]+\.[a-z]+$/.test(filename)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid filename');
      return;
    }
    const filepath = join(CHAT_IMAGES_DIR, filename);
    if (!existsSync(filepath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = filename.split('.').pop();
    const mimeTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    res.end(readFileSync(filepath));
    return;
  }

  // Main page (chat UI) — read from disk each time for hot-reload
  if (pathname === '/') {
    try {
      const chatPage = readFileSync(chatTemplatePath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
      res.end(chatPage.replace(/\{\{NONCE\}\}/g, nonce));
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Failed to load chat page');
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}
