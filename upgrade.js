#!/usr/bin/env node
/**
 * zylos-telegram upgrade script
 *
 * Called by zylos-pm after pulling latest code.
 * Handles: dependency updates, config migration, service restart.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const HOME = process.env.HOME;
const SKILL_DIR = path.join(HOME, '.claude/skills/telegram');
const DATA_DIR = path.join(HOME, 'zylos/components/telegram');

console.log('=== Post-upgrade tasks for zylos-telegram ===\n');

process.chdir(SKILL_DIR);

// 1. Update dependencies
console.log('Updating dependencies...');
try {
  execSync('npm install --production', { stdio: 'inherit' });
} catch (err) {
  console.error('Failed to update dependencies:', err.message);
}

// 2. Run any config migrations if needed
const configPath = path.join(DATA_DIR, 'config.json');
if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    let migrated = false;

    // Example migration: add features.download_media if missing
    if (config.features && config.features.download_media === undefined) {
      config.features.download_media = true;
      migrated = true;
    }

    if (migrated) {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log('Config migrated successfully.');
    }
  } catch (err) {
    console.error('Config migration failed:', err.message);
  }
}

// 3. Restart service
console.log('\nRestarting service...');
try {
  execSync('pm2 restart zylos-telegram', { stdio: 'inherit' });
} catch (err) {
  console.error('Failed to restart service:', err.message);
}

console.log('\n=== Upgrade complete ===');
