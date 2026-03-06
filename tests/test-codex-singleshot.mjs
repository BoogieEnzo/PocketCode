#!/usr/bin/env node
/**
 * Focused test: Does Codex complete a coding task in a single turn?
 * Or does it plan in turn 1 and execute in turn 2?
 *
 * We test this WITHOUT resume — just a single codex exec invocation
 * with a task that requires creating files.
 */
import { spawn, execFileSync } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, mkdirSync, rmSync, readdirSync } from 'fs';

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

function runCodexSingle(prompt, label, cwd) {
  return new Promise((resolve) => {
    console.log(`\n--- ${label} ---`);
    console.log(`  Prompt: ${prompt.slice(0, 150)}`);

    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    const startTime = Date.now();
    const proc = spawn(codexPath, ['exec', '--json', '--full-auto', prompt], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv,
    });
    proc.stdin.end();

    const safetyTimer = setTimeout(() => {
      console.log(`  ** TIMEOUT **`);
      proc.kill('SIGTERM');
    }, 180000);

    const rl = createInterface({ input: proc.stdout });
    const events = [];
    let threadId = null;

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
      }
    });

    proc.stderr.on('data', () => {});

    proc.on('exit', (code) => {
      clearTimeout(safetyTimer);
      const duration = Date.now() - startTime;
      const cmds = events.filter(e => e.type === 'item.completed' && e.item?.type === 'command_execution').length;
      const files = events.filter(e => e.type === 'item.completed' && e.item?.type === 'file_change').length;
      const completed = events.some(e => e.type === 'turn.completed');

      console.log(`  → Duration: ${duration}ms, Cmds: ${cmds}, Files: ${files}, Completed: ${completed}`);

      // Check what files actually exist in the directory
      const dirContents = readdirSync(cwd).filter(f => !f.startsWith('.'));
      console.log(`  → Files on disk: ${dirContents.join(', ') || '(none)'}`);

      resolve({ threadId, code, duration, cmds, files, completed, dirContents });
    });
  });
}

async function main() {
  console.log('=== Codex Single-Shot Completion Test ===\n');

  const tests = [
    {
      name: 'Simple file creation',
      prompt: 'Create a file called "greet.js" that exports a function greet(name) which returns "Hello, <name>!".',
    },
    {
      name: 'Multi-file coding task',
      prompt: 'Create two files: 1) "calc.js" with add(a,b) and subtract(a,b) functions exported, and 2) "calc.test.js" that tests both functions using assert. Then run the tests with "node calc.test.js".',
    },
    {
      name: 'Read + write task',
      prompt: 'First create a file "data.json" with {"items": [1,2,3,4,5]}. Then create "sum.js" that reads data.json and prints the sum of all items. Then run "node sum.js" to verify it works.',
    },
  ];

  const results = [];

  for (let i = 0; i < tests.length; i++) {
    const dir = `/tmp/codex-single-test-${i}`;
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir });

    const r = await runCodexSingle(tests[i].prompt, tests[i].name, dir);
    results.push({ ...r, name: tests[i].name });

    try { rmSync(dir, { recursive: true }); } catch {}
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('SUMMARY');
  console.log('='.repeat(60));
  for (const r of results) {
    const taskDone = r.files > 0 || r.dirContents.length > 0;
    const status = r.completed ? (taskDone ? 'COMPLETE' : 'TURN-OK-BUT-NO-FILES') : 'INCOMPLETE';
    console.log(`  [${status}] ${r.name}`);
    console.log(`    cmds=${r.cmds}, fileChanges=${r.files}, filesOnDisk=${r.dirContents.length}, duration=${r.duration}ms`);
  }

  const problematic = results.filter(r => r.completed && r.files === 0 && r.dirContents.length === 0);
  if (problematic.length > 0) {
    console.log(`\n*** ${problematic.length} test(s) completed turn but produced NO files ***`);
    console.log('This confirms: Codex sometimes "plans" in turn 1 without executing.');
    console.log('The user sees the turn end (status=idle) and thinks Codex stopped working.');
  }
}

main().catch(console.error);
