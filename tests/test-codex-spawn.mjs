#!/usr/bin/env node
/**
 * Test script: spawns codex exec --json --full-auto exactly like process-runner.mjs does,
 * to diagnose if Codex stops mid-execution.
 *
 * Usage: node test-codex-spawn.mjs [prompt]
 */
import { spawn, execFileSync } from 'child_process';
import { createInterface } from 'readline';
import { existsSync } from 'fs';
import { homedir } from 'os';

const prompt = process.argv[2] || 'Read the package.json in the current directory, list all dependencies, then create a summary. Do not write any files.';
const cwd = process.cwd();

// Resolve codex command (same logic as process-runner.mjs)
function resolveCommand(cmd) {
  const home = process.env.HOME || '';
  const preferred = [
    `${home}/.local/bin/${cmd}`,
    `${home}/Library/pnpm/${cmd}`,
    `/opt/homebrew/bin/${cmd}`,
    `/usr/local/bin/${cmd}`,
  ];
  for (const p of preferred) {
    if (p && existsSync(p)) return p;
  }
  try {
    return execFileSync('which', [cmd], { encoding: 'utf8', timeout: 3000 }).trim();
  } catch {
    return cmd;
  }
}

const codexPath = resolveCommand('codex');
const args = ['exec', '--json', '--full-auto', prompt];

console.log('=== Codex Spawn Test ===');
console.log(`Command: ${codexPath}`);
console.log(`Args: ${JSON.stringify(args)}`);
console.log(`CWD: ${cwd}`);
console.log(`Prompt: ${prompt}`);
console.log('');

// Clean env (same as process-runner.mjs)
const cleanEnv = { ...process.env };
delete cleanEnv.CLAUDECODE;
delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

const proc = spawn(codexPath, args, {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: cleanEnv,
});

console.log(`Process spawned, pid=${proc.pid}`);
console.log('---');

const rl = createInterface({ input: proc.stdout });
let lineCount = 0;
let lastEventTime = Date.now();
const events = [];

rl.on('line', (line) => {
  lineCount++;
  const now = Date.now();
  const elapsed = now - lastEventTime;
  lastEventTime = now;

  let obj;
  try {
    obj = JSON.parse(line.trim());
  } catch {
    console.log(`[line#${lineCount}] (not JSON) ${line.slice(0, 200)}`);
    return;
  }

  const summary = summarizeEvent(obj);
  console.log(`[line#${lineCount}] +${elapsed}ms | ${summary}`);
  events.push({ lineNum: lineCount, elapsed, obj });
});

proc.stderr.on('data', (chunk) => {
  const text = chunk.toString().trim();
  if (text) {
    console.log(`[STDERR] ${text.slice(0, 500)}`);
  }
});

proc.on('error', (err) => {
  console.error(`[ERROR] Process error: ${err.message}`);
});

// KEY: also close stdin immediately (same as process-runner.mjs does)
proc.stdin.end();
console.log('[INFO] stdin closed (proc.stdin.end())');

proc.on('exit', (code, signal) => {
  console.log('---');
  console.log(`Process exited: code=${code}, signal=${signal}`);
  console.log(`Total JSONL lines received: ${lineCount}`);
  console.log('');

  // Analyze the event stream
  console.log('=== Event Analysis ===');
  let hasThreadStarted = false;
  let hasTurnStarted = false;
  let hasTurnCompleted = false;
  let hasAgentMessage = false;
  let commandCount = 0;
  let lastEventType = null;

  for (const { obj } of events) {
    if (obj.type === 'thread.started') hasThreadStarted = true;
    if (obj.type === 'turn.started') hasTurnStarted = true;
    if (obj.type === 'turn.completed') hasTurnCompleted = true;
    if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') hasAgentMessage = true;
    if (obj.type === 'item.completed' && obj.item?.type === 'command_execution') commandCount++;
    lastEventType = obj.type;
  }

  console.log(`thread.started: ${hasThreadStarted}`);
  console.log(`turn.started: ${hasTurnStarted}`);
  console.log(`turn.completed: ${hasTurnCompleted}`);
  console.log(`agent_message received: ${hasAgentMessage}`);
  console.log(`command_executions completed: ${commandCount}`);
  console.log(`Last event type: ${lastEventType}`);

  if (!hasTurnCompleted) {
    console.log('');
    console.log('*** WARNING: turn.completed was NOT received! ***');
    console.log('This means Codex exited before completing the turn.');
    console.log('Possible causes:');
    console.log('  1. stdin.end() caused Codex to exit prematurely');
    console.log('  2. Codex timed out');
    console.log('  3. Codex hit an internal error');
  }

  if (code !== 0 && code !== null) {
    console.log(`\n*** WARNING: Non-zero exit code: ${code} ***`);
  }
});

function summarizeEvent(obj) {
  switch (obj.type) {
    case 'thread.started':
      return `thread.started (thread_id=${obj.thread_id?.slice(0, 12)}...)`;
    case 'turn.started':
      return 'turn.started';
    case 'turn.completed': {
      const u = obj.usage || {};
      return `turn.completed (in=${u.input_tokens}, out=${u.output_tokens})`;
    }
    case 'turn.failed':
      return `turn.failed: ${obj.error?.message || 'unknown'}`;
    case 'item.started':
      return `item.started [${obj.item?.type}] ${(obj.item?.command || obj.item?.text || '').slice(0, 80)}`;
    case 'item.updated':
      return `item.updated [${obj.item?.type}]`;
    case 'item.completed': {
      const item = obj.item || {};
      switch (item.type) {
        case 'agent_message':
          return `item.completed [agent_message] "${item.text?.slice(0, 100)}"`;
        case 'reasoning':
          return `item.completed [reasoning] "${item.text?.slice(0, 80)}"`;
        case 'command_execution':
          return `item.completed [command] "${item.command}" exit=${item.exit_code}`;
        case 'file_change':
          return `item.completed [file_change] ${item.changes?.map(c => c.path).join(', ')}`;
        default:
          return `item.completed [${item.type}]`;
      }
    }
    case 'error':
      return `error: ${obj.message}`;
    default:
      return `${obj.type}: ${JSON.stringify(obj).slice(0, 100)}`;
  }
}
