#!/usr/bin/env node
/**
 * Test: Verify if Codex's turn-based model causes "stop mid-execution" behavior,
 * and whether resume can continue the conversation.
 *
 * Hypothesis: Codex completes one turn and exits. The current chat UI code
 * does NOT automatically resume — it just shows "idle", making it appear
 * like Codex stopped working.
 *
 * Test plan:
 * 1. Give Codex a complex multi-step task
 * 2. See if it completes in one turn or stops partway
 * 3. If it stops, try resuming with the thread_id
 * 4. Check if the resumed turn continues the work
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
    console.log(`Args: ${JSON.stringify(args)}`);

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

      if (obj.type === 'thread.started' && obj.thread_id) {
        threadId = obj.thread_id;
      }

      events.push(obj);

      // Compact log
      if (obj.type === 'item.completed' && obj.item) {
        const i = obj.item;
        if (i.type === 'agent_message') {
          console.log(`  [${elapsed}ms] AGENT: "${i.text?.slice(0, 120)}"`);
        } else if (i.type === 'command_execution') {
          console.log(`  [${elapsed}ms] CMD: ${i.command} → exit ${i.exit_code}`);
        } else if (i.type === 'reasoning') {
          console.log(`  [${elapsed}ms] THINK: "${i.text?.slice(0, 80)}"`);
        } else {
          console.log(`  [${elapsed}ms] ${i.type}`);
        }
      } else if (obj.type === 'turn.completed') {
        console.log(`  [${elapsed}ms] TURN COMPLETED (in=${obj.usage?.input_tokens}, out=${obj.usage?.output_tokens})`);
      } else if (obj.type === 'turn.started') {
        console.log(`  [${elapsed}ms] TURN STARTED`);
      } else if (obj.type === 'thread.started') {
        console.log(`  [${elapsed}ms] THREAD: ${obj.thread_id}`);
      } else if (obj.type === 'item.started' && obj.item?.type === 'command_execution') {
        console.log(`  [${elapsed}ms] CMD STARTED: ${obj.item.command}`);
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
    });

    proc.on('exit', (code) => {
      const duration = Date.now() - startTime;
      const hasTurnCompleted = events.some(e => e.type === 'turn.completed');
      const cmdCount = events.filter(e => e.type === 'item.completed' && e.item?.type === 'command_execution').length;
      const lastMessage = [...events].reverse().find(e => e.type === 'item.completed' && e.item?.type === 'agent_message');

      console.log(`\n  Duration: ${duration}ms, Exit: ${code}, Commands: ${cmdCount}, Turn completed: ${hasTurnCompleted}`);
      if (lastMessage) {
        console.log(`  Last message: "${lastMessage.item.text?.slice(0, 150)}"`);
      }
      if (stderrBuf.trim()) {
        console.log(`  STDERR: ${stderrBuf.trim().slice(0, 200)}`);
      }

      resolve({ events, threadId, code, duration, hasTurnCompleted, cmdCount, lastMessage });
    });
  });
}

async function main() {
  console.log('=== Codex Resume / Multi-Turn Test ===');
  console.log(`Codex: ${codexPath}`);
  console.log(`CWD: ${process.cwd()}`);

  // Step 1: Give a complex task
  const prompt = 'Please do ALL of the following steps, one by one:\n' +
    '1. Run "ls -la" to show the project root\n' +
    '2. Run "cat package.json" to read the package file\n' +
    '3. Run "ls lib/" to list library files\n' +
    '4. Run "wc -l lib/*.mjs" to count lines in library files\n' +
    '5. Give me a full summary of the project based on all of the above\n' +
    'Do NOT skip any step. Do NOT modify any files.';

  console.log(`\nPrompt: ${prompt.slice(0, 200)}`);

  const r1 = await runCodex(['exec', '--json', '--full-auto', prompt], 'TURN 1 (initial)');

  if (r1.cmdCount < 4) {
    console.log(`\n*** Codex only executed ${r1.cmdCount}/4 commands in the first turn ***`);

    if (r1.threadId) {
      console.log(`Thread ID captured: ${r1.threadId}`);
      console.log('Attempting resume...');

      // Test resume with "continue" message
      const r2 = await runCodex(
        ['exec', '--json', '--full-auto', 'resume', r1.threadId, 'Continue with the remaining steps please.'],
        'TURN 2 (resume)'
      );

      if (r2.cmdCount < (4 - r1.cmdCount)) {
        console.log(`\n*** Still incomplete after resume. Only ${r1.cmdCount + r2.cmdCount}/4 total commands ***`);

        if (r2.threadId || r1.threadId) {
          const tid = r2.threadId || r1.threadId;
          const r3 = await runCodex(
            ['exec', '--json', '--full-auto', 'resume', tid, 'Please continue. You still have steps left.'],
            'TURN 3 (resume again)'
          );
          console.log(`\nTotal commands across 3 turns: ${r1.cmdCount + r2.cmdCount + r3.cmdCount}`);
        }
      } else {
        console.log(`\nResume completed the remaining work. Total commands: ${r1.cmdCount + r2.cmdCount}`);
      }
    } else {
      console.log('No thread_id captured — cannot resume!');
    }
  } else {
    console.log(`\nCodex completed all ${r1.cmdCount} commands in a single turn.`);
  }

  console.log('\n=== CONCLUSION ===');
  console.log('If Codex needed multiple turns to finish, this confirms the issue:');
  console.log('The chat UI only sends ONE turn per user message and marks the session');
  console.log('as "idle" when the turn ends. The remaining work is lost/abandoned.');
}

main().catch(console.error);
