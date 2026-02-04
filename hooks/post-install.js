#!/usr/bin/env node
/**
 * Post-install hook for zylos-telegram
 *
 * Called by zylos CLI after standard installation steps:
 * - git clone
 * - npm install
 * - create data_dir
 * - register PM2 service (basic)
 *
 * This hook handles telegram-specific setup:
 * - Create subdirectories (media, logs)
 * - Create default config.json
 * - Check for required environment variables
 * - Restart service with ecosystem.config.js (for custom PM2 options)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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

const hasToken = envContent.includes('TELEGRAM_BOT_TOKEN');
if (!hasToken) {
  console.log('\n[!] TELEGRAM_BOT_TOKEN not found in ' + ENV_FILE);
  console.log('    Add it before starting:');
  console.log('    echo "TELEGRAM_BOT_TOKEN=your_token" >> ' + ENV_FILE);
}

// 4. Restart service with ecosystem.config.js (for custom log paths, restart policy)
console.log('\nConfiguring PM2 service with ecosystem.config.js...');
const ecosystemPath = path.join(SKILL_DIR, 'ecosystem.config.js');
if (fs.existsSync(ecosystemPath)) {
  try {
    // Stop the basic service started by zylos CLI
    execSync('pm2 delete zylos-telegram 2>/dev/null || true', { stdio: 'pipe' });
    // Start with full ecosystem config
    execSync(`pm2 start "${ecosystemPath}"`, { stdio: 'inherit' });
    execSync('pm2 save', { stdio: 'pipe' });
    console.log('  - Service configured with custom PM2 options');
  } catch (err) {
    console.error('  - PM2 restart failed:', err.message);
  }
} else {
  console.log('  - No ecosystem.config.js found, using default PM2 config');
}

console.log('\n[post-install] Complete!');

if (!hasToken) {
  console.log('\nNext: Add TELEGRAM_BOT_TOKEN and restart:');
  console.log('  pm2 restart zylos-telegram');
}
