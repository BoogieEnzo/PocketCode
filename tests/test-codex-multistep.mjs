#!/usr/bin/env node
/**
 * Test script: simulates the exact flow that chat UI uses for Codex.
 * Tests multi-step tasks that require multiple command executions.
 *
 * This mimics process-runner.mjs behavior exactly:
 * - spawn with stdio: ['pipe', 'pipe', 'pipe']
 * - immediately call proc.stdin.end()
 * - read stdout via readline
 *
 * Usage: node test-codex-multistep.mjs
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

// Multiple test prompts of increasing complexity
const testCases = [
  {
    name: 'Simple (no commands)',
    prompt: 'Say "hello world" and nothing else.',
  },
  {
    name: 'Single command',
    prompt: 'Run "ls -la package.json" and tell me the file size.',
  },
  {
    name: 'Multi-step commands',
    prompt: 'First run "cat package.json" to read the file. Then run "ls lib/" to list files in the lib directory. Then summarize what this project does based on the information.',
  },
  {
    name: 'Complex task (like real usage)',
    prompt: 'Look at the project structure by running "ls -la" first. Then read the package.json with "cat package.json". Then look at what files are in the lib/ directory. Finally, give me a brief summary of the project architecture. Do NOT write or modify any files.',
  },
];

const codexPath = resolveCommand('codex');

async function runTest(testCase, index) {
  return new Promise((resolve) => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`TEST ${index + 1}: ${testCase.name}`);
    console.log(`Prompt: ${testCase.prompt.slice(0, 100)}...`);
    console.log(`${'='.repeat(60)}`);

    const args = ['exec', '--json', '--full-auto', testCase.prompt];
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    const startTime = Date.now();
    const proc = spawn(codexPath, args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv,
    });

    // Immediately close stdin — this is what process-runner.mjs does
    proc.stdin.end();

    const rl = createInterface({ input: proc.stdout });
    let lineCount = 0;
    const timeline = [];
    let stderrBuf = '';

    rl.on('line', (line) => {
      lineCount++;
      const elapsed = Date.now() - startTime;
      let obj;
      try { obj = JSON.parse(line.trim()); } catch { return; }
      timeline.push({ elapsed, type: obj.type, item: obj.item?.type, detail: getDetail(obj) });
      console.log(`  [${elapsed}ms] ${obj.type}${obj.item ? ` (${obj.item.type})` : ''} ${getDetail(obj)}`);
    });

    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
    });

    proc.on('exit', (code, signal) => {
      const totalTime = Date.now() - startTime;
      const hasTurnCompleted = timeline.some(t => t.type === 'turn.completed');
      const commandsStarted = timeline.filter(t => t.type === 'item.started' && t.item === 'command_execution').length;
      const commandsCompleted = timeline.filter(t => t.type === 'item.completed' && t.item === 'command_execution').length;
      const hasAgentMessage = timeline.some(t => t.type === 'item.completed' && t.item === 'agent_message');

      console.log(`\n  --- Result ---`);
      console.log(`  Exit code: ${code}, Signal: ${signal}`);
      console.log(`  Duration: ${totalTime}ms`);
      console.log(`  JSONL lines: ${lineCount}`);
      console.log(`  Commands started/completed: ${commandsStarted}/${commandsCompleted}`);
      console.log(`  Has agent message: ${hasAgentMessage}`);
      console.log(`  turn.completed received: ${hasTurnCompleted}`);

      if (stderrBuf.trim()) {
        console.log(`  STDERR: ${stderrBuf.trim().slice(0, 200)}`);
      }

      if (!hasTurnCompleted) {
        console.log(`  *** INCOMPLETE: Codex exited without completing the turn! ***`);
      }
      if (code !== 0 && code !== null) {
        console.log(`  *** Non-zero exit code! ***`);
      }

      resolve({
        name: testCase.name,
        exitCode: code,
        signal,
        totalTime,
        lineCount,
        hasTurnCompleted,
        commandsStarted,
        commandsCompleted,
        hasAgentMessage,
        stderr: stderrBuf.trim(),
      });
    });
  });
}

function getDetail(obj) {
  if (obj.item?.text) return `"${obj.item.text.slice(0, 60)}"`;
  if (obj.item?.command) return `cmd: ${obj.item.command.slice(0, 60)}`;
  if (obj.thread_id) return `thread=${obj.thread_id.slice(0, 12)}`;
  if (obj.usage) return `tokens: in=${obj.usage.input_tokens}, out=${obj.usage.output_tokens}`;
  if (obj.error) return `error: ${obj.error.message?.slice(0, 60)}`;
  return '';
}

async function main() {
  console.log('=== Codex Multi-Step Spawn Test ===');
  console.log(`Codex path: ${codexPath}`);
  console.log(`Working directory: ${process.cwd()}`);

  const results = [];
  for (let i = 0; i < testCases.length; i++) {
    const result = await runTest(testCases[i], i);
    results.push(result);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('=== SUMMARY ===');
  console.log(`${'='.repeat(60)}`);
  for (const r of results) {
    const status = r.hasTurnCompleted ? 'OK' : 'INCOMPLETE';
    console.log(`  [${status}] ${r.name}: exit=${r.exitCode}, ${r.totalTime}ms, cmds=${r.commandsStarted}/${r.commandsCompleted}, msg=${r.hasAgentMessage}`);
  }

  const failures = results.filter(r => !r.hasTurnCompleted);
  if (failures.length > 0) {
    console.log(`\n*** ${failures.length}/${results.length} tests had INCOMPLETE execution ***`);
    console.log('This confirms the reported issue: Codex stops mid-execution.');
  } else {
    console.log(`\nAll ${results.length} tests completed successfully.`);
  }
}

main().catch(console.error);
