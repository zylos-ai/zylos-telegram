#!/usr/bin/env node
/**
 * zylos-telegram admin CLI
 * Manage telegram bot configuration
 *
 * Usage: node admin.js <command> [args]
 */

import { loadConfig, saveConfig } from './lib/config.js';
import { addGroup, removeGroup } from './lib/auth.js';

// Commands
const commands = {
  show: () => {
    const config = loadConfig();
    console.log(JSON.stringify(config, null, 2));
  },

  'list-groups': () => {
    const config = loadConfig();
    const groups = config.groups || {};
    const ids = Object.keys(groups);

    if (ids.length === 0) {
      console.log('No groups configured');
      return;
    }

    console.log(`Groups (policy: ${config.groupPolicy || 'allowlist'}):`);
    ids.forEach(chatId => {
      const group = groups[chatId] || {};
      const allowFrom = Array.isArray(group.allowFrom) && group.allowFrom.length > 0
        ? group.allowFrom.join(', ')
        : '*';
      const historyLimit = group.historyLimit || config.message?.context_messages || 5;
      console.log(`  ${chatId} - ${group.name || 'group'}`);
      console.log(`    mode: ${group.mode || 'mention'}`);
      console.log(`    allowFrom: ${allowFrom}`);
      console.log(`    historyLimit: ${historyLimit}`);
      console.log(`    added_at: ${group.added_at || 'unknown'}`);
    });
  },

  'add-group': (chatId, name, mode = 'mention') => {
    if (!chatId || !name) {
      console.error('Usage: admin.js add-group <chat_id> <name> [mode]');
      process.exit(1);
    }
    if (!['mention', 'smart'].includes(mode)) {
      console.error('Mode must be: mention or smart');
      process.exit(1);
    }

    const config = loadConfig();
    const added = addGroup(config, chatId, name, mode);
    if (added) {
      console.log(`Added group: ${chatId} (${name}) mode=${mode}`);
    } else {
      console.log(`Group ${chatId} already configured`);
    }
    console.log('Run: pm2 restart zylos-telegram');
  },

  'remove-group': (chatId) => {
    if (!chatId) {
      console.error('Usage: admin.js remove-group <chat_id>');
      process.exit(1);
    }

    const config = loadConfig();
    const removed = removeGroup(config, chatId);
    if (removed) {
      console.log(`Removed group: ${chatId}`);
    } else {
      console.log(`Group ${chatId} not found`);
    }
    console.log('Run: pm2 restart zylos-telegram');
  },

  'set-group-policy': (policy) => {
    if (!policy || !['open', 'allowlist', 'disabled'].includes(policy)) {
      console.error('Usage: admin.js set-group-policy <open|allowlist|disabled>');
      process.exit(1);
    }

    const config = loadConfig();
    config.groupPolicy = policy;
    if (!saveConfig(config)) {
      console.error('[telegram] Failed to save config to disk');
      process.exit(1);
    }
    console.log(`Set groupPolicy=${policy}`);
    console.log('Run: pm2 restart zylos-telegram');
  },

  'set-group-mode': (chatId, mode) => {
    if (!chatId || !mode || !['mention', 'smart'].includes(mode)) {
      console.error('Usage: admin.js set-group-mode <chat_id> <mention|smart>');
      process.exit(1);
    }

    const config = loadConfig();
    if (!config.groups?.[String(chatId)]) {
      console.log(`Group ${chatId} not found`);
      return;
    }

    config.groups[String(chatId)].mode = mode;
    if (!saveConfig(config)) {
      console.error('[telegram] Failed to save config to disk');
      process.exit(1);
    }
    console.log(`Set mode for ${chatId}: ${mode}`);
    console.log('Run: pm2 restart zylos-telegram');
  },

  'set-group-allowfrom': (chatId, ...userIds) => {
    if (!chatId || userIds.length === 0) {
      console.error('Usage: admin.js set-group-allowfrom <chat_id> <user_ids...>');
      process.exit(1);
    }

    const config = loadConfig();
    if (!config.groups?.[String(chatId)]) {
      console.log(`Group ${chatId} not found`);
      return;
    }

    config.groups[String(chatId)].allowFrom = userIds.map(String);
    if (!saveConfig(config)) {
      console.error('[telegram] Failed to save config to disk');
      process.exit(1);
    }
    console.log(`Set allowFrom for ${chatId}: ${config.groups[String(chatId)].allowFrom.join(', ')}`);
    console.log('Run: pm2 restart zylos-telegram');
  },

  'set-group-history-limit': (chatId, limit) => {
    const parsedLimit = Number.parseInt(limit, 10);
    if (!chatId || !Number.isFinite(parsedLimit) || parsedLimit <= 0) {
      console.error('Usage: admin.js set-group-history-limit <chat_id> <limit>');
      process.exit(1);
    }

    const config = loadConfig();
    if (!config.groups?.[String(chatId)]) {
      console.log(`Group ${chatId} not found`);
      return;
    }

    config.groups[String(chatId)].historyLimit = parsedLimit;
    if (!saveConfig(config)) {
      console.error('[telegram] Failed to save config to disk');
      process.exit(1);
    }
    console.log(`Set historyLimit for ${chatId}: ${parsedLimit}`);
    console.log('Run: pm2 restart zylos-telegram');
  },

  'list-whitelist': () => {
    const config = loadConfig();
    const wl = config.whitelist || { chat_ids: [], usernames: [] };
    console.log('Whitelist:');
    console.log('  Chat IDs:', wl.chat_ids.length ? wl.chat_ids.join(', ') : 'none');
    console.log('  Usernames:', wl.usernames.length ? wl.usernames.join(', ') : 'none');
  },

  'add-whitelist': (type, value) => {
    if (!type || !value || !['chat_id', 'username'].includes(type)) {
      console.error('Usage: admin.js add-whitelist <chat_id|username> <value>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.whitelist) {
      config.whitelist = { chat_ids: [], usernames: [] };
    }

    const key = type === 'chat_id' ? 'chat_ids' : 'usernames';
    if (!config.whitelist[key].includes(value)) {
      config.whitelist[key].push(value);
      if (!saveConfig(config)) {
        console.error('[telegram] Failed to save config to disk');
        process.exit(1);
      }
      console.log(`Added ${type}: ${value} to whitelist`);
    } else {
      console.log(`${value} already in whitelist`);
    }
  },

  'remove-whitelist': (type, value) => {
    if (!type || !value || !['chat_id', 'username'].includes(type)) {
      console.error('Usage: admin.js remove-whitelist <chat_id|username> <value>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.whitelist) {
      console.log('No whitelist configured');
      return;
    }

    const key = type === 'chat_id' ? 'chat_ids' : 'usernames';
    const index = config.whitelist[key].indexOf(value);
    if (index !== -1) {
      config.whitelist[key].splice(index, 1);
      if (!saveConfig(config)) {
        console.error('[telegram] Failed to save config to disk');
        process.exit(1);
      }
      console.log(`Removed ${type}: ${value} from whitelist`);
    } else {
      console.log(`${value} not in whitelist`);
    }
  },

  'show-owner': () => {
    const config = loadConfig();
    const owner = config.owner || {};
    if (owner.chat_id) {
      console.log(`Owner: ${owner.username || 'unknown'} (${owner.chat_id})`);
      console.log(`Bound at: ${owner.bound_at || 'unknown'}`);
    } else {
      console.log('No owner configured');
    }
  },

  help: () => {
    console.log(`
zylos-telegram admin CLI

Commands:
  show                                           Show full config

  Group Policy:
  list-groups                                    List all groups with settings
  add-group <chat_id> <name> [mode]             Add group (mode: mention|smart)
  remove-group <chat_id>                         Remove group
  set-group-policy <open|allowlist|disabled>     Set global group policy
  set-group-mode <chat_id> <mention|smart>       Set group mode
  set-group-allowfrom <chat_id> <user_ids...>    Set allowed sender IDs (use * for all)
  set-group-history-limit <chat_id> <limit>      Set per-group history limit

  Whitelist (private chat access):
  list-whitelist                                 List whitelist entries
  add-whitelist <chat_id|username> <value>       Add to whitelist
  remove-whitelist <chat_id|username> <value>    Remove from whitelist

  show-owner                                     Show current owner
  help                                           Show this help

After changes, restart bot: pm2 restart zylos-telegram
`);
  }
};

// Main
const args = process.argv.slice(2);
const command = args[0] || 'help';

if (commands[command]) {
  commands[command](...args.slice(1));
} else {
  console.error(`Unknown command: ${command}`);
  commands.help();
  process.exit(1);
}
