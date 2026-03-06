#!/usr/bin/env node
import { createInterface } from 'readline';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { hashPassword } from '../lib/auth.mjs';

const authFile = join(homedir(), '.config', 'claude-web', 'auth.json');
const authDir = dirname(authFile);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

const username = (await ask('Username: ')).trim();
const password = (await ask('Password: ')).trim();
rl.close();

if (!username || !password) {
  console.error('Error: username and password cannot be empty.');
  process.exit(1);
}

mkdirSync(authDir, { recursive: true });

let existing = {};
if (existsSync(authFile)) {
  try { existing = JSON.parse(readFileSync(authFile, 'utf8')); } catch {}
}

existing.username = username;
existing.passwordHash = hashPassword(password);

writeFileSync(authFile, JSON.stringify(existing, null, 2), 'utf8');
console.log(`Password set for user "${username}".`);
