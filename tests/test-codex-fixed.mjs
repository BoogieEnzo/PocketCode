#!/usr/bin/env node
/**
 * Test the full fix: auto-continue when Codex turn ends prematurely.
 * Uses the actual process-runner.mjs to verify end-to-end behavior.
 */
import { spawnTool } from './chat/process-runner.mjs';
import { existsSync, mkdirSync, rmSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';

const testDir = '/tmp/codex-autofix-test';

function setupDir() {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  mkdirSync(testDir, { recursive: true });
  execFileSync('git', ['init'], { cwd: testDir });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: testDir });
}

function runTest(prompt, label) {
  return new Promise((resolve) => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`TEST: ${label}`);
    console.log(`Prompt: ${prompt.slice(0, 120)}`);
    console.log('='.repeat(60));

    setupDir();
    const startTime = Date.now();
    const events = [];

    const runner = spawnTool('codex', testDir, prompt,
      (evt) => {
        events.push(evt);
        const elapsed = Date.now() - startTime;
        if (evt.type === 'message' && evt.role === 'assistant') {
          console.log(`  [${elapsed}ms] MSG: "${evt.content?.slice(0, 100)}"`);
        } else if (evt.type === 'tool_use') {
          console.log(`  [${elapsed}ms] TOOL: ${evt.toolName} ${evt.toolInput?.slice(0, 60)}`);
        } else if (evt.type === 'file_change') {
          console.log(`  [${elapsed}ms] FILE: ${evt.changeType} ${evt.filePath}`);
        } else if (evt.type === 'status') {
          console.log(`  [${elapsed}ms] STATUS: ${evt.content}`);
        }
      },
      (code) => {
        const duration = Date.now() - startTime;
        const dirContents = readdirSync(testDir).filter(f => !f.startsWith('.'));
        const msgCount = events.filter(e => e.type === 'message' && e.role === 'assistant').length;
        const fileCount = events.filter(e => e.type === 'file_change').length;
        const statusEvents = events.filter(e => e.type === 'status').map(e => e.content);
        const autoContinues = statusEvents.filter(s => s.includes('auto-continuing')).length;

        console.log(`\n  --- Result ---`);
        console.log(`  Exit: ${code}, Duration: ${duration}ms`);
        console.log(`  Messages: ${msgCount}, FileEvents: ${fileCount}`);
        console.log(`  Auto-continues triggered: ${autoContinues}`);
        console.log(`  Files on disk: ${dirContents.join(', ') || '(none)'}`);

        const success = dirContents.length > 0;
        console.log(`  ${success ? 'SUCCESS' : 'FAILED'}: ${success ? 'Files created!' : 'No files created'}`);

        try { rmSync(testDir, { recursive: true }); } catch {}
        resolve({ label, code, duration, dirContents, autoContinues, success });
      },
      {}
    );
  });
}

async function main() {
  console.log('=== Test: Auto-Continue Fix for Codex ===\n');

  const results = [];

  results.push(await runTest(
    'Create a file called "hello.js" with a simple function that adds two numbers and exports it. Then create a test file "hello.test.js" that tests the function.',
    'Create files (previously failed)'
  ));

  results.push(await runTest(
    'Create two files: 1) "calc.js" with add(a,b) and subtract(a,b) functions exported, and 2) "calc.test.js" that tests both functions using assert. Then run the tests with "node calc.test.js".',
    'Multi-file + run tests'
  ));

  results.push(await runTest(
    'Create a file "data.json" with {"items": [1,2,3,4,5]}. Then create "sum.js" that reads data.json and prints the sum of all items. Then run "node sum.js" to verify it works.',
    'Read + write + verify'
  ));

  console.log(`\n${'='.repeat(60)}`);
  console.log('SUMMARY');
  console.log('='.repeat(60));
  for (const r of results) {
    console.log(`  [${r.success ? 'OK' : 'FAIL'}] ${r.label} (${r.duration}ms, auto-continues: ${r.autoContinues}, files: ${r.dirContents.join(', ') || 'none'})`);
  }

  const allOk = results.every(r => r.success);
  console.log(allOk
    ? '\nAll tests passed! Auto-continue fix is working.'
    : '\nSome tests still failed. Need further investigation.');
}

main().catch(console.error);
