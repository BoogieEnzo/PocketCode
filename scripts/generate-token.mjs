#!/usr/bin/env node
import { randomBytes } from 'crypto';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

const authFile = join(homedir(), '.config', 'claude-web', 'auth.json');
const authDir = dirname(authFile);

mkdirSync(authDir, { recursive: true });

const token = randomBytes(32).toString('hex');

writeFileSync(authFile, JSON.stringify({ token }, null, 2), 'utf8');

// Try to read real domain from cloudflared config
let domain = null;
const cfConfig = join(homedir(), '.cloudflared', 'config.yml');
if (existsSync(cfConfig)) {
  try {
    const content = readFileSync(cfConfig, 'utf8');
    const match = content.match(/hostname:\s+(\S+)/);
    if (match) domain = match[1];
  } catch {}
}

console.log(`Auth token generated and written to: ${authFile}`);
console.log(`\nYour access token: ${token}`);

if (domain) {
  console.log(`\nAccess URL:`);
  console.log(`  https://${domain}/?token=${token}`);
} else {
  console.log(`\nAccess URL (local):`);
  console.log(`  http://127.0.0.1:7681/?token=${token}`);
}
