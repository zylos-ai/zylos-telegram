#!/usr/bin/env node
/**
 * zylos-telegram upgrade script
 * Usage: node upgrade.js
 */

const path = require('path');
const { execSync } = require('child_process');

const HOME = process.env.HOME;
const SKILL_DIR = path.join(HOME, '.claude/skills/telegram');

console.log('=== Upgrading zylos-telegram ===\n');

process.chdir(SKILL_DIR);

// 1. Pull latest code
console.log('Pulling latest code...');
execSync('git pull', { stdio: 'inherit' });

// 2. Update dependencies
console.log('\nUpdating dependencies...');
execSync('npm install --production', { stdio: 'inherit' });

// 3. Restart service
console.log('\nRestarting service...');
execSync('pm2 restart zylos-telegram', { stdio: 'inherit' });

console.log('\n=== Upgrade complete ===');
