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

import fs from 'fs';
import path from 'path';

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

    // Migration 1: Ensure features object and active fields
    if (!config.features) {
      config.features = { download_media: true };
      migrated = true;
      migrations.push('Added features object');
    }
    if (config.features.download_media === undefined) {
      config.features.download_media = true;
      migrated = true;
      migrations.push('Added features.download_media');
    }
    // Clean up dead config fields
    if (config.features.auto_split_messages !== undefined) {
      delete config.features.auto_split_messages;
      migrated = true;
      migrations.push('Removed dead features.auto_split_messages');
    }
    if (config.features.max_message_length !== undefined) {
      delete config.features.max_message_length;
      migrated = true;
      migrations.push('Removed dead features.max_message_length');
    }

    // Migration 2: Add allowed_groups if missing
    if (config.allowed_groups === undefined) {
      config.allowed_groups = [];
      migrated = true;
      migrations.push('Added allowed_groups array');
    }

    // Migration 3: Add smart_groups if missing
    if (config.smart_groups === undefined) {
      config.smart_groups = [];
      migrated = true;
      migrations.push('Added smart_groups array');
    }

    // Migration 4: Ensure whitelist structure
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

    // Migration 5: Ensure owner structure
    if (!config.owner) {
      config.owner = { chat_id: null, username: null, bound_at: null };
      migrated = true;
      migrations.push('Added owner structure');
    }

    // Migration 6: Ensure enabled field
    if (config.enabled === undefined) {
      config.enabled = true;
      migrated = true;
      migrations.push('Added enabled field');
    }

    // Migration 7: Ensure message object with context_messages
    if (!config.message) {
      config.message = { context_messages: 10 };
      migrated = true;
      migrations.push('Added message.context_messages');
    } else if (config.message.context_messages === undefined) {
      config.message.context_messages = 10;
      migrated = true;
      migrations.push('Added message.context_messages');
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
