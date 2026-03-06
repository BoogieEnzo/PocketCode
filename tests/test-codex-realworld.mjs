#!/usr/bin/env node
/**
 * Real-world simulation: Test the exact flow that chat UI uses,
 * including the session-manager's cancel-and-resume behavior.
 *
 * Simulates:
 * 1. User sends a complex coding task (message 1)
 * 2. Wait for Codex to finish
 * 3. User sends a follow-up message (message 2, resume)
 * 4. Check if message 2 actually executes or just replies with text
 *
 * Also tests: what happens with a real coding task that requires file creation/editing.
 */
import { spawn, execFileSync } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, mkdirSync, rmSync } from 'fs';

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
const testDir = '/tmp/codex-test-workspace';

// Setup test workspace
if (existsSync(testDir)) rmSync(testDir, { recursive: true });
mkdirSync(testDir, { recursive: true });
execFileSync('git', ['init'], { cwd: testDir });
execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: testDir });

function runCodex(args, label, { cwd = testDir, maxMs = 180000 } = {}) {
  return new Promise((resolve) => {
    console.log(`\n--- ${label} ---`);

    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    const startTime = Date.now();
    const proc = spawn(codexPath, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv,
    });
    proc.stdin.end();

    const safetyTimer = setTimeout(() => {
      console.log(`  ** SAFETY TIMEOUT after ${maxMs}ms **`);
      proc.kill('SIGTERM');
    }, maxMs);

    const rl = createInterface({ input: proc.stdout });
    const events = [];
    let threadId = null;
    let stderrBuf = '';

    rl.on('line', (line) => {
      const elapsed = Date.now() - startTime;
      let obj;
      try { obj = JSON.parse(line.trim()); } catch { return; }
      if (obj.type === 'thread.started' && obj.thread_id) threadId = obj.thread_id;
      events.push(obj);

      if (obj.type === 'item.completed' && obj.item) {
        const i = obj.item;
        if (i.type === 'agent_message') console.log(`  [${elapsed}ms] MSG: "${i.text?.slice(0, 120)}"`);
        else if (i.type === 'command_execution') console.log(`  [${elapsed}ms] CMD: ${i.command?.slice(0, 80)} → exit ${i.exit_code}`);
        else if (i.type === 'file_change') console.log(`  [${elapsed}ms] FILE: ${i.changes?.map(c => `${c.kind} ${c.path}`).join(', ')}`);
        else if (i.type === 'reasoning') console.log(`  [${elapsed}ms] THINK: "${i.text?.slice(0, 60)}"`);
      } else if (obj.type === 'turn.completed') {
        console.log(`  [${elapsed}ms] TURN COMPLETED`);
      } else if (obj.type === 'turn.failed') {
        console.log(`  [${elapsed}ms] TURN FAILED: ${obj.error?.message}`);
      } else if (obj.type === 'item.started' && obj.item?.type === 'command_execution') {
        console.log(`  [${elapsed}ms] CMD START: ${obj.item.command?.slice(0, 80)}`);
      }
    });

    proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

    proc.on('exit', (code, signal) => {
      clearTimeout(safetyTimer);
      const duration = Date.now() - startTime;
      const hasTurnCompleted = events.some(e => e.type === 'turn.completed');
      const hasTurnFailed = events.some(e => e.type === 'turn.failed');
      const cmdCount = events.filter(e => e.type === 'item.completed' && e.item?.type === 'command_execution').length;
      const fileChanges = events.filter(e => e.type === 'item.completed' && e.item?.type === 'file_change').length;
      const messages = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message');
      const lastMsg = messages.length > 0 ? messages[messages.length - 1].item.text : null;

      console.log(`\n  Exit: code=${code}, signal=${signal}, duration=${duration}ms`);
      console.log(`  Cmds: ${cmdCount}, Files: ${fileChanges}, Msgs: ${messages.length}`);
      console.log(`  TurnCompleted: ${hasTurnCompleted}, TurnFailed: ${hasTurnFailed}`);
      if (stderrBuf.trim()) console.log(`  STDERR: ${stderrBuf.trim().slice(0, 200)}`);

      resolve({ events, threadId, code, signal, duration, hasTurnCompleted, hasTurnFailed, cmdCount, fileChanges, lastMsg });
    });
  });
}

async function main() {
  console.log('=== Codex Real-World Simulation ===');
  console.log(`Test workspace: ${testDir}`);
  console.log(`Codex: ${codexPath}\n`);

  // Test 1: Coding task with file creation
  console.log('TEST 1: Create a file (coding task)');
  const t1 = await runCodex(
    ['exec', '--json', '--full-auto',
     'Create a file called "hello.js" with a simple function that adds two numbers and exports it. Then create a test file "hello.test.js" that tests the function.'],
    'Create hello.js + test',
  );

  if (t1.threadId) {
    // Test 2: Follow-up that requires reading + modifying
    console.log('\n\nTEST 2: Follow-up - modify the file (resume)');
    const t2 = await runCodex(
      ['exec', '--json', '--full-auto', 'resume', t1.threadId,
       'Now modify hello.js to also include a subtract function. Update the test file to test both functions. Then run the tests with node.'],
      'Modify + test (resume)',
    );

    console.log(`\n\nSUMMARY:`);
    console.log(`  Test 1 (create): completed=${t1.hasTurnCompleted}, cmds=${t1.cmdCount}, files=${t1.fileChanges}`);
    console.log(`  Test 2 (modify+test): completed=${t2.hasTurnCompleted}, cmds=${t2.cmdCount}, files=${t2.fileChanges}`);

    if (t2.cmdCount === 0 && t2.fileChanges === 0) {
      console.log(`\n  *** PROBLEM: Resume produced NO commands and NO file changes! ***`);
      console.log(`  Last message: "${t2.lastMsg?.slice(0, 150)}"`);
    }
  }

  // Cleanup
  try { rmSync(testDir, { recursive: true }); } catch {}

  console.log('\n=== DONE ===');
}

main().catch(console.error);
