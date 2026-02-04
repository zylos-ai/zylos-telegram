#!/usr/bin/env node
/**
 * Post-upgrade hook for zylos-telegram
 *
 * Called by zylos CLI after standard upgrade steps:
 * - git pull
 * - npm install
 *
 * This hook handles telegram-specific migrations:
 * - Config schema migrations
 * - Data format updates
 *
 * Note: Service restart is handled by zylos CLI after this hook.
 */

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/telegram');
const configPath = path.join(DATA_DIR, 'config.json');

console.log('[post-upgrade] Running telegram-specific migrations...\n');

// Config migrations
if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    let migrated = false;
    const migrations = [];

    // Migration 1: Add features.download_media if missing
    if (config.features && config.features.download_media === undefined) {
      config.features.download_media = true;
      migrated = true;
      migrations.push('Added features.download_media');
    }

    // Migration 2: Add smart_groups if missing
    if (config.smart_groups === undefined) {
      config.smart_groups = [];
      migrated = true;
      migrations.push('Added smart_groups array');
    }

    // Migration 3: Ensure whitelist structure
    if (!config.whitelist) {
      config.whitelist = { chat_ids: [], usernames: [] };
      migrated = true;
      migrations.push('Added whitelist structure');
    } else {
      if (!config.whitelist.chat_ids) {
        config.whitelist.chat_ids = [];
        migrated = true;
        migrations.push('Added whitelist.chat_ids');
      }
      if (!config.whitelist.usernames) {
        config.whitelist.usernames = [];
        migrated = true;
        migrations.push('Added whitelist.usernames');
      }
    }

    // Save if migrated
    if (migrated) {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log('Config migrations applied:');
      migrations.forEach(m => console.log('  - ' + m));
    } else {
      console.log('No config migrations needed.');
    }
  } catch (err) {
    console.error('Config migration failed:', err.message);
    process.exit(1);
  }
} else {
  console.log('No config file found, skipping migrations.');
}

console.log('\n[post-upgrade] Complete!');
