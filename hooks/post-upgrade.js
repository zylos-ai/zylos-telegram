#!/usr/bin/env node
/**
 * Post-upgrade hook for zylos-telegram
 *
 * Called by Claude after CLI upgrade completes (zylos upgrade --json).
 * CLI handles: stop service, backup, file sync, npm install, manifest.
 *
 * This hook handles telegram-specific migrations:
 * - Config schema migrations
 * - Data format updates
 *
 * Note: Service restart is handled by Claude after this hook.
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

    // Migration 2: Add allowed_groups if missing (skip if already using v0.2 groups map)
    if (config.allowed_groups === undefined && !config.groups) {
      config.allowed_groups = [];
      migrated = true;
      migrations.push('Added allowed_groups array');
    }

    // Migration 3: Add smart_groups if missing (skip if already using v0.2 groups map)
    if (config.smart_groups === undefined && !config.groups) {
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

    // Migration 5b: Fix legacy owner.chat_id that may be a group chat ID
    // v0.1.x bindOwner used ctx.chat.id which could be a group ID (negative).
    // v0.2.0 uses ctx.from.id (always positive user ID). Reset invalid owner so re-binding triggers.
    if (config.owner && config.owner.chat_id !== null) {
      const ownerId = Number(config.owner.chat_id);
      if (ownerId < 0) {
        config.owner = { chat_id: null, username: null, bound_at: null };
        migrated = true;
        migrations.push('Reset legacy owner with group chat_id (negative ID) for re-binding');
      }
    }

    // Migration 6: Ensure enabled field
    if (config.enabled === undefined) {
      config.enabled = true;
      migrated = true;
      migrations.push('Added enabled field');
    }

    // Migration 7: Ensure message object with context_messages
    if (!config.message) {
      config.message = { context_messages: 5 };
      migrated = true;
      migrations.push('Added message.context_messages');
    } else if (config.message.context_messages === undefined) {
      config.message.context_messages = 5;
      migrated = true;
      migrations.push('Added message.context_messages');
    }

    // Migration 8: Migrate legacy group arrays to unified groups map
    if ((config.allowed_groups || config.smart_groups) && !config.groups) {
      config.groups = {};
      config.groupPolicy = config.group_whitelist?.enabled !== false ? 'allowlist' : 'open';

      for (const g of (config.allowed_groups || [])) {
        config.groups[String(g.chat_id)] = {
          name: g.name,
          mode: 'mention',
          allowFrom: ['*'],
          historyLimit: config.message?.context_messages || 5,
          added_at: g.added_at || new Date().toISOString()
        };
      }
      for (const g of (config.smart_groups || [])) {
        config.groups[String(g.chat_id)] = {
          name: g.name,
          mode: 'smart',
          allowFrom: ['*'],
          historyLimit: config.message?.context_messages || 5,
          added_at: g.added_at || new Date().toISOString()
        };
      }

      // Remove legacy fields
      delete config.allowed_groups;
      delete config.smart_groups;
      delete config.group_whitelist;

      migrated = true;
      migrations.push(`Migrated ${Object.keys(config.groups).length} groups to unified groups map`);
    }

    // Migration 9: Ensure groupPolicy exists
    if (!config.groupPolicy) {
      config.groupPolicy = 'allowlist';
      migrated = true;
      migrations.push('Added groupPolicy (default: allowlist)');
    }

    // Migration 10: Ensure groups object exists
    if (!config.groups) {
      config.groups = {};
      migrated = true;
      migrations.push('Added empty groups object');
    }

    // Migration 11: Ensure internal_port
    if (!config.internal_port) {
      config.internal_port = 3460;
      migrated = true;
      migrations.push('Added internal_port (3460)');
    }

    // Migration 12: Create typing directory
    const typingDir = path.join(DATA_DIR, 'typing');
    if (!fs.existsSync(typingDir)) {
      fs.mkdirSync(typingDir, { recursive: true });
      migrations.push('Created typing/ directory');
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

// Log migration: split existing log files by thread_id
const logsDir = path.join(DATA_DIR, 'logs');
if (fs.existsSync(logsDir)) {
  try {
    const logFiles = fs.readdirSync(logsDir).filter(f => f.endsWith('.log') && !f.includes('_t_'));
    let splitCount = 0;

    for (const file of logFiles) {
      const filePath = path.join(logsDir, file);
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      if (!content) continue;

      const lines = content.split('\n');
      const threadLines = new Map(); // threadId -> lines[]
      const mainLines = [];

      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { mainLines.push(line); continue; }
        if (entry.thread_id) {
          const tid = String(entry.thread_id);
          if (!threadLines.has(tid)) threadLines.set(tid, []);
          threadLines.get(tid).push(line);
        } else {
          mainLines.push(line);
        }
      }

      if (threadLines.size === 0) continue;

      // Write thread-specific files
      const baseName = file.replace('.log', '');
      for (const [tid, tLines] of threadLines) {
        const threadFile = path.join(logsDir, `${baseName}_t_${tid}.log`);
        fs.appendFileSync(threadFile, tLines.join('\n') + '\n');
      }

      // Rewrite main file without thread entries
      fs.writeFileSync(filePath, mainLines.join('\n') + (mainLines.length ? '\n' : ''));
      splitCount++;
    }

    if (splitCount > 0) {
      console.log(`[post-upgrade] Split thread logs from ${splitCount} files`);
    }
  } catch (err) {
    console.warn(`[post-upgrade] Log split failed (non-fatal): ${err.message}`);
  }
}

console.log('\n[post-upgrade] Complete!');
