#!/usr/bin/env node
/**
 * zylos-telegram uninstall script
 * Usage: node uninstall.js [--purge]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const HOME = process.env.HOME;
const SKILL_DIR = path.join(HOME, '.claude/skills/telegram');
const DATA_DIR = path.join(HOME, 'zylos/components/telegram');

const purge = process.argv.includes('--purge');

console.log('=== Uninstalling zylos-telegram ===\n');

// 1. Stop PM2 service
console.log('Stopping PM2 service...');
try {
  execSync('pm2 stop zylos-telegram', { stdio: 'pipe' });
  execSync('pm2 delete zylos-telegram', { stdio: 'pipe' });
  execSync('pm2 save', { stdio: 'pipe' });
} catch (e) {
  // Ignore errors if service doesn't exist
}

// 2. Remove skill directory
console.log('Removing skill directory...');
fs.rmSync(SKILL_DIR, { recursive: true, force: true });

// 3. Optionally remove data
if (purge) {
  console.log('Removing data directory...');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
} else {
  console.log('Data preserved: ' + DATA_DIR);
}

console.log('\n=== Uninstall complete ===');
