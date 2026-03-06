#!/usr/bin/env node
/**
 * Integration test for chat server.
 *
 * Usage:
 *   node test-chat.mjs                    # test codex (default)
 *   node test-chat.mjs claude             # test claude
 *   node test-chat.mjs codex              # test codex
 *
 * Requires chat-server to be running on CHAT_PORT (default 7690).
 */
import http from 'http';
import WebSocket from 'ws';
import { CHAT_PORT } from './lib/config.mjs';
import { readFileSync } from 'fs';
import { AUTH_FILE } from './lib/config.mjs';

const TOOL = process.argv[2] || 'codex';
const BASE = `http://127.0.0.1:${CHAT_PORT}`;
const FOLDER = process.cwd();

// ---- Helpers ----

function log(tag, ...args) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}]`, ...args);
}

function fail(msg) {
  console.error(`\n❌ FAIL: ${msg}`);
  process.exit(1);
}

function pass(msg) {
  console.log(`\n✅ PASS: ${msg}`);
}

/** HTTP GET/POST with cookie support */
function request(method, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const reqOpts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { ...opts.headers },
    };
    if (opts.cookie) reqOpts.headers.Cookie = opts.cookie;

    const req = http.request(reqOpts, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/**
 * Wait for a WS message matching a predicate, with timeout.
 * Returns all collected messages up to and including the match.
 */
function waitFor(ws, predicate, description, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const collected = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout (${timeout}ms) waiting for: ${description}\nCollected ${collected.length} messages: ${collected.map(m => m.type + (m.event ? ':' + m.event.type + ':' + m.event.role : '')).join(', ')}`));
    }, timeout);

    function onMsg(raw) {
      const msg = JSON.parse(raw.toString());
      collected.push(msg);

      const summary = msg.type === 'event' && msg.event
        ? `event:${msg.event.type}:${msg.event.role || ''}`
        : msg.type;
      log('ws:in', `${summary} ${JSON.stringify(msg).slice(0, 150)}`);

      if (predicate(msg)) {
        cleanup();
        resolve(collected);
      }
    }

    function cleanup() {
      clearTimeout(timer);
      ws.removeListener('message', onMsg);
    }

    ws.on('message', onMsg);
  });
}

function wsSend(ws, msg) {
  log('ws:out', JSON.stringify(msg).slice(0, 150));
  ws.send(JSON.stringify(msg));
}

// ---- Test Flow ----

async function main() {
  log('test', `Testing tool=${TOOL}, server=${BASE}, folder=${FOLDER}`);

  // Step 1: Authenticate — get session cookie
  log('test', 'Step 1: Authenticating...');
  const auth = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
  const authRes = await request('GET', `/?token=${auth.token}`);
  if (authRes.status !== 302) fail(`Auth failed: status=${authRes.status}`);

  const setCookie = authRes.headers['set-cookie'];
  if (!setCookie) fail('No Set-Cookie header');
  const cookie = setCookie[0].split(';')[0];
  log('test', `Got cookie: ${cookie.slice(0, 30)}...`);

  // Step 2: Connect WebSocket
  log('test', 'Step 2: Connecting WebSocket...');
  const ws = new WebSocket(`ws://127.0.0.1:${CHAT_PORT}/ws`, {
    headers: { Cookie: cookie },
  });

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 5000);
  });
  log('test', 'WebSocket connected');

  // Step 3: Create session
  log('test', 'Step 3: Creating session...');
  wsSend(ws, { action: 'create', folder: FOLDER, tool: TOOL });
  const createMsgs = await waitFor(ws,
    m => m.type === 'session' && m.session?.id,
    'session creation', 5000);
  const session = createMsgs.find(m => m.type === 'session')?.session;
  if (!session?.id) fail('No session created');
  log('test', `Session created: id=${session.id.slice(0, 8)}, tool=${session.tool}`);

  // Step 4: Attach to session
  log('test', 'Step 4: Attaching to session...');
  wsSend(ws, { action: 'attach', sessionId: session.id });
  await waitFor(ws, m => m.type === 'history', 'history replay', 5000);
  log('test', 'Attached, got history replay');

  // Step 5: Send first message
  log('test', 'Step 5: Sending first message...');
  wsSend(ws, { action: 'send', text: '记住这个数字：42。只回复"已记住"两个字。' });

  log('test', 'Waiting for assistant response...');
  const firstMsgs = await waitFor(ws,
    m => m.type === 'event' && m.event?.type === 'message' && m.event?.role === 'assistant',
    'assistant message (1st)', 120000);
  const firstReply = firstMsgs.find(m => m.type === 'event' && m.event?.type === 'message' && m.event?.role === 'assistant');
  log('test', `First reply: "${firstReply.event.content?.slice(0, 100)}"`);
  pass('First message got a response');

  // Wait for process to fully exit (session goes idle)
  log('test', 'Waiting for process to complete...');
  await waitFor(ws,
    m => m.type === 'session' && m.session?.status === 'idle',
    'session idle', 120000);
  log('test', 'Process completed, session idle');

  // Step 6: Send follow-up message to test context
  log('test', 'Step 6: Sending follow-up (context test)...');
  wsSend(ws, { action: 'send', text: '我让你记住的数字是什么？只回复那个数字本身。' });

  log('test', 'Waiting for second response...');
  const secondMsgs = await waitFor(ws,
    m => m.type === 'event' && m.event?.type === 'message' && m.event?.role === 'assistant',
    'assistant message (2nd)', 120000);
  const secondReply = secondMsgs.find(m => m.type === 'event' && m.event?.type === 'message' && m.event?.role === 'assistant');
  log('test', `Second reply: "${secondReply.event.content?.slice(0, 100)}"`);

  const has42 = secondReply.event.content?.includes('42');
  if (has42) {
    pass('Context preserved! AI remembered "42" from previous message.');
  } else {
    fail(`Context lost. Reply was: "${secondReply.event.content?.slice(0, 200)}"\nExpected it to contain "42".`);
  }

  // Cleanup
  log('test', 'Step 7: Cleanup...');
  wsSend(ws, { action: 'delete', sessionId: session.id });
  await new Promise(r => setTimeout(r, 1000));
  ws.close();

  log('test', 'Done!');
  process.exit(0);
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
