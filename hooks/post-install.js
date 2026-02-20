#!/usr/bin/env node
/**
 * Post-install hook for zylos-telegram
 *
 * Called by Claude after CLI installation (zylos add --json).
 * CLI handles: download, npm install, manifest, registration.
 * Claude handles: config collection, this hook, service start.
 *
 * This hook handles telegram-specific setup:
 * - Create subdirectories (media, logs)
 * - Create default config.json
 * - Check for required environment variables
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/telegram');
const ENV_FILE = path.join(HOME, 'zylos/.env');

// Minimal initial config - full defaults are in src/lib/config.js
const INITIAL_CONFIG = {
  enabled: true
};

console.log('[post-install] Running telegram-specific setup...\n');

// 1. Create subdirectories
console.log('Creating subdirectories...');
fs.mkdirSync(path.join(DATA_DIR, 'media'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'typing'), { recursive: true });
console.log('  - media/');
console.log('  - logs/');
console.log('  - typing/');

// 2. Create default config if not exists
const configPath = path.join(DATA_DIR, 'config.json');
if (!fs.existsSync(configPath)) {
  console.log('\nCreating default config.json...');
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(INITIAL_CONFIG, null, 2));
  fs.renameSync(tmpPath, configPath);
  console.log('  - config.json created');
} else {
  console.log('\nConfig already exists, skipping.');
}

// 3. Check environment variables
console.log('\nChecking environment variables...');
let envContent = '';
try {
  envContent = fs.readFileSync(ENV_FILE, 'utf8');
} catch (e) {
  // .env file doesn't exist yet
}

const hasToken = envContent.includes('TELEGRAM_BOT_TOKEN');
if (!hasToken) {
  console.log('\n[!] TELEGRAM_BOT_TOKEN not found in ' + ENV_FILE);
  console.log('    Add it before starting:');
  console.log('    echo "TELEGRAM_BOT_TOKEN=your_token" >> ' + ENV_FILE);
}

// Note: PM2 service is started by Claude after this hook completes.

console.log('\n[post-install] Complete!');

console.log('\n========================================');
console.log('  Telegram Bot Setup Checklist');
console.log('========================================');
console.log('');
console.log('1. Create a bot via @BotFather on Telegram:');
console.log('   - Send /newbot to @BotFather');
console.log('   - Follow prompts to get your Bot Token');
console.log('');
if (!hasToken) {
  console.log('2. Add Bot Token to ~/zylos/.env:');
  console.log('   echo "TELEGRAM_BOT_TOKEN=your_token" >> ~/zylos/.env');
} else {
  console.log('2. Bot Token: already configured');
}
console.log('');
console.log('3. (Optional) If behind a firewall/proxy, add to ~/zylos/.env:');
console.log('   TELEGRAM_PROXY_URL=http://your-proxy:port');
console.log('');
console.log('4. Restart the bot:');
console.log('   pm2 restart zylos-telegram');
console.log('');
console.log('5. Send a message to your bot on Telegram.');
console.log('   First user to interact becomes the owner (admin).');
console.log('========================================');
