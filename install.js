#!/usr/bin/env node
/**
 * zylos-telegram install script
 * Usage: node install.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const HOME = process.env.HOME;
const SKILL_DIR = path.join(HOME, '.claude/skills/telegram');
const DATA_DIR = path.join(HOME, 'zylos/components/telegram');
const ENV_FILE = path.join(HOME, 'zylos/.env');

const DEFAULT_CONFIG = {
  enabled: true,
  owner: { chat_id: null, username: null, bound_at: null },
  whitelist: { chat_ids: [], usernames: [] },
  smart_groups: [],
  features: { auto_split_messages: true, max_message_length: 4000, download_media: true }
};

console.log('=== Installing zylos-telegram ===\n');

// 1. Create data directories
console.log('Creating data directories...');
fs.mkdirSync(path.join(DATA_DIR, 'media'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });

// 2. Install dependencies
console.log('Installing dependencies...');
process.chdir(SKILL_DIR);
execSync('npm install --omit=dev', { stdio: 'inherit' });

// 3. Create default config (don't overwrite)
const configPath = path.join(DATA_DIR, 'config.json');
if (!fs.existsSync(configPath)) {
  console.log('Creating default config.json...');
  fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
}

// 4. Check environment variables
let envContent = '';
try {
  envContent = fs.readFileSync(ENV_FILE, 'utf8');
} catch (e) {}

if (!envContent.includes('TELEGRAM_BOT_TOKEN')) {
  console.log('\n[!] Add TELEGRAM_BOT_TOKEN to ' + ENV_FILE);
}

// 5. Start PM2 service
console.log('\nStarting PM2 service...');
try {
  execSync(`pm2 start "${SKILL_DIR}/ecosystem.config.js"`, { stdio: 'inherit' });
  execSync('pm2 save', { stdio: 'inherit' });
} catch (e) {
  console.error('PM2 start failed:', e.message);
}

console.log('\n=== Installation complete ===');
console.log('Next: Add TELEGRAM_BOT_TOKEN to ~/zylos/.env and run: pm2 restart zylos-telegram');
