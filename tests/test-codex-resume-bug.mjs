#!/usr/bin/env node
/**
 * Focused test: Verify the resume bug.
 *
 * The hypothesis is that when resuming a Codex thread, Codex sometimes
 * "acknowledges" the request but doesn't actually execute commands —
 * it just completes the turn immediately with a text response.
 *
 * This is especially problematic because:
 * 1. User sends first message → Codex works fine (turn 1)
 * 2. User sends second message → session-manager cancels turn 1, resumes with turn 2
 * 3. In turn 2, Codex may just respond with text without executing anything
 */
import { spawn, execFileSync } from 'child_process';
import { createInterface } from 'readline';
import { existsSync } from 'fs';

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

function runCodex(args, label) {
  return new Promise((resolve) => {
    console.log(`\n--- ${label} ---`);

    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    const startTime = Date.now();
    const proc = spawn(codexPath, args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv,
    });
    proc.stdin.end();

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
        if (i.type === 'agent_message') console.log(`  [${elapsed}ms] AGENT: "${i.text?.slice(0, 150)}"`);
        else if (i.type === 'command_execution') console.log(`  [${elapsed}ms] CMD: ${i.command} → exit ${i.exit_code}`);
        else if (i.type === 'reasoning') console.log(`  [${elapsed}ms] THINK: "${i.text?.slice(0, 80)}"`);
      } else if (obj.type === 'turn.completed') {
        console.log(`  [${elapsed}ms] TURN COMPLETED (in=${obj.usage?.input_tokens}, out=${obj.usage?.output_tokens})`);
      } else if (obj.type === 'turn.failed') {
        console.log(`  [${elapsed}ms] TURN FAILED: ${obj.error?.message}`);
      } else if (obj.type === 'item.started') {
        if (obj.item?.type === 'command_execution') console.log(`  [${elapsed}ms] CMD STARTED: ${obj.item.command}`);
      }
    });

    proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

    proc.on('exit', (code, signal) => {
      const duration = Date.now() - startTime;
      const hasTurnCompleted = events.some(e => e.type === 'turn.completed');
      const cmdCount = events.filter(e => e.type === 'item.completed' && e.item?.type === 'command_execution').length;
      const messages = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message');

      console.log(`  → Exit: ${code}, Duration: ${duration}ms, Commands: ${cmdCount}, Messages: ${messages.length}`);
      if (stderrBuf.trim()) console.log(`  STDERR: ${stderrBuf.trim().slice(0, 200)}`);

      resolve({ events, threadId, code, duration, hasTurnCompleted, cmdCount, messages });
    });
  });
}

async function main() {
  console.log('=== Codex Resume Bug Test ===\n');

  // Scenario 1: Normal conversation flow (initial + resume)
  console.log('SCENARIO 1: Normal multi-turn conversation');
  console.log('Simulates user sending two separate messages.\n');

  const s1t1 = await runCodex(
    ['exec', '--json', '--full-auto', 'Run "ls package.json" and tell me what you see.'],
    'Scenario 1, Message 1 (initial)'
  );

  if (s1t1.threadId) {
    const s1t2 = await runCodex(
      ['exec', '--json', '--full-auto', 'resume', s1t1.threadId,
       'Now run "wc -l package.json" and tell me how many lines it has.'],
      'Scenario 1, Message 2 (resume)'
    );

    console.log(`\n  Scenario 1 Summary:`);
    console.log(`  Message 1: ${s1t1.cmdCount} commands executed`);
    console.log(`  Message 2: ${s1t2.cmdCount} commands executed`);
    if (s1t2.cmdCount === 0) {
      console.log(`  *** BUG CONFIRMED: Resume message produced 0 commands! ***`);
      console.log(`  Codex just replied with text but did NOT execute the requested command.`);
    }

    // Try a third message
    if (s1t2.threadId || s1t1.threadId) {
      const tid = s1t2.threadId || s1t1.threadId;
      const s1t3 = await runCodex(
        ['exec', '--json', '--full-auto', 'resume', tid,
         'Run "head -3 package.json" right now. You MUST execute this command.'],
        'Scenario 1, Message 3 (resume, forceful prompt)'
      );

      console.log(`  Message 3: ${s1t3.cmdCount} commands executed`);
      if (s1t3.cmdCount === 0) {
        console.log(`  *** BUG CONFIRMED AGAIN: Even forceful prompt produced 0 commands on resume! ***`);
      }
    }
  }

  // Scenario 2: What does the buildCodexArgs function actually produce?
  console.log('\n\nSCENARIO 2: Verify buildCodexArgs output');
  // Replicate exactly what process-runner.mjs + codex adapter do

  // First message (no threadId)
  const args1 = ['exec', '--json', '--full-auto', 'Run "date" and show me the current date.'];
  console.log(`  First message args: ${JSON.stringify(args1)}`);

  const s2t1 = await runCodex(args1, 'Scenario 2, First message');

  if (s2t1.threadId) {
    // Second message (with threadId — this is what buildCodexArgs generates)
    const args2 = ['exec', '--json', '--full-auto', 'resume', s2t1.threadId,
                   'Run "whoami" and tell me the current user.'];
    console.log(`  Second message args: ${JSON.stringify(args2)}`);

    const s2t2 = await runCodex(args2, 'Scenario 2, Second message (resume)');

    console.log(`\n  Scenario 2 Summary:`);
    console.log(`  First: ${s2t1.cmdCount} commands`);
    console.log(`  Second (resume): ${s2t2.cmdCount} commands`);
  }

  console.log('\n=== TEST COMPLETE ===');
}

main().catch(console.error);
