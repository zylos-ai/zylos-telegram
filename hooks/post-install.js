#!/usr/bin/env node
/**
 * Post-install hook for zylos-telegram
 *
 * Called by zylos CLI after standard installation steps:
 * - git clone
 * - npm install
 * - create data_dir
 * - register PM2 service
 *
 * This hook handles telegram-specific setup:
 * - Create subdirectories (media, logs)
 * - Create default config.json
 * - Check for required environment variables
 */

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME;
const SKILL_DIR = path.dirname(__dirname);
const DATA_DIR = path.join(HOME, 'zylos/components/telegram');
const ENV_FILE = path.join(HOME, 'zylos/.env');

const DEFAULT_CONFIG = {
  enabled: true,
  owner: { chat_id: null, username: null, bound_at: null },
  whitelist: { chat_ids: [], usernames: [] },
  smart_groups: [],
  features: {
    auto_split_messages: true,
    max_message_length: 4000,
    download_media: true
  }
};

console.log('[post-install] Running telegram-specific setup...\n');

// 1. Create subdirectories
console.log('Creating subdirectories...');
fs.mkdirSync(path.join(DATA_DIR, 'media'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
console.log('  - media/');
console.log('  - logs/');

// 2. Create default config if not exists
const configPath = path.join(DATA_DIR, 'config.json');
if (!fs.existsSync(configPath)) {
  console.log('\nCreating default config.json...');
  fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
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

if (!envContent.includes('TELEGRAM_BOT_TOKEN')) {
  console.log('\n[!] TELEGRAM_BOT_TOKEN not found in ' + ENV_FILE);
  console.log('    Please add it before starting the service:');
  console.log('    echo "TELEGRAM_BOT_TOKEN=your_token" >> ' + ENV_FILE);
} else {
  console.log('  - TELEGRAM_BOT_TOKEN found');
}

console.log('\n[post-install] Complete!');
console.log('\nNext steps:');
console.log('  1. Ensure TELEGRAM_BOT_TOKEN is set in ~/zylos/.env');
console.log('  2. Start service: pm2 restart zylos-telegram');
