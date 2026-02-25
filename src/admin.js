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
      console.log('Run: pm2 restart zylos-telegram');
    } else {
      console.error(`Group ${chatId} not found`);
      process.exit(1);
    }
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
      console.error(`Group ${chatId} not found`);
      process.exit(1);
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
      console.error(`Group ${chatId} not found`);
      process.exit(1);
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
      console.error(`Group ${chatId} not found`);
      process.exit(1);
    }

    config.groups[String(chatId)].historyLimit = parsedLimit;
    if (!saveConfig(config)) {
      console.error('[telegram] Failed to save config to disk');
      process.exit(1);
    }
    console.log(`Set historyLimit for ${chatId}: ${parsedLimit}`);
    console.log('Run: pm2 restart zylos-telegram');
  },

  'set-dm-policy': (policy) => {
    const valid = ['open', 'allowlist', 'owner'];
    if (!valid.includes(policy)) {
      console.error(`Usage: admin.js set-dm-policy <${valid.join('|')}>`);
      process.exit(1);
    }
    const config = loadConfig();
    config.dmPolicy = policy;
    if (!saveConfig(config)) {
      console.error('[telegram] Failed to save config to disk');
      process.exit(1);
    }
    const desc = { open: 'Anyone can DM', allowlist: 'Only dmAllowFrom users can DM', owner: 'Only owner can DM' };
    console.log(`DM policy set to: ${policy} (${desc[policy]})`);
    console.log('Run: pm2 restart zylos-telegram');
  },

  'list-dm-allow': () => {
    const config = loadConfig();
    console.log(`DM policy: ${config.dmPolicy || 'owner'}`);
    console.log(`Group policy: ${config.groupPolicy || 'allowlist'}`);
    const allowFrom = config.dmAllowFrom || [];
    console.log(`DM allowFrom (${allowFrom.length}):`, allowFrom.length ? allowFrom.join(', ') : 'none');
  },

  'add-dm-allow': (value) => {
    if (!value) {
      console.error('Usage: admin.js add-dm-allow <chat_id_or_@username>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!Array.isArray(config.dmAllowFrom)) {
      config.dmAllowFrom = [];
    }
    if (!config.dmAllowFrom.includes(value)) {
      config.dmAllowFrom.push(value);
      if (!saveConfig(config)) {
        console.error('[telegram] Failed to save config to disk');
        process.exit(1);
      }
      console.log(`Added ${value} to dmAllowFrom`);
    } else {
      console.log(`${value} already in dmAllowFrom`);
    }
    if ((config.dmPolicy || 'owner') !== 'allowlist') {
      console.log(`Note: dmPolicy is "${config.dmPolicy || 'owner'}", set to "allowlist" for this to take effect.`);
    }
    console.log('Run: pm2 restart zylos-telegram');
  },

  'remove-dm-allow': (value) => {
    if (!value) {
      console.error('Usage: admin.js remove-dm-allow <chat_id_or_@username>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!Array.isArray(config.dmAllowFrom)) {
      console.log('No dmAllowFrom configured');
      return;
    }
    const idx = config.dmAllowFrom.indexOf(value);
    if (idx !== -1) {
      config.dmAllowFrom.splice(idx, 1);
      if (!saveConfig(config)) {
        console.error('[telegram] Failed to save config to disk');
        process.exit(1);
      }
      console.log(`Removed ${value} from dmAllowFrom`);
    } else {
      console.log(`${value} not in dmAllowFrom`);
    }
  },

  // Legacy whitelist commands → mapped to dmPolicy
  'list-whitelist': () => commands['list-dm-allow'](),
  'add-whitelist': (type, value) => {
    if (!type || !value) {
      console.error('Usage: admin.js add-whitelist <chat_id|username> <value> (legacy, use add-dm-allow instead)');
      process.exit(1);
    }
    const prefix = type === 'username' ? '@' : '';
    commands['add-dm-allow'](`${prefix}${value}`);
  },
  'remove-whitelist': (type, value) => {
    if (!type || !value) {
      console.error('Usage: admin.js remove-whitelist <chat_id|username> <value> (legacy, use remove-dm-allow instead)');
      process.exit(1);
    }
    const prefix = type === 'username' ? '@' : '';
    commands['remove-dm-allow'](`${prefix}${value}`);
    // Also clean up legacy whitelist entries so isDmAllowed backward-compat doesn't re-authorize
    const config = loadConfig();
    let modified = false;
    if (type === 'chat_id' && config.whitelist?.chat_ids) {
      const idx = config.whitelist.chat_ids.findIndex(id => String(id) === String(value));
      if (idx >= 0) { config.whitelist.chat_ids.splice(idx, 1); modified = true; }
    }
    if (type === 'username' && config.whitelist?.usernames) {
      const lv = value.toLowerCase();
      const idx = config.whitelist.usernames.findIndex(u => u.toLowerCase() === lv);
      if (idx >= 0) { config.whitelist.usernames.splice(idx, 1); modified = true; }
    }
    if (modified) {
      saveConfig(config);
      console.log(`Also removed from legacy whitelist`);
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

  DM Access Control:
  set-dm-policy <open|allowlist|owner>           Set DM policy
  list-dm-allow                                  Show DM policy and allowFrom list
  add-dm-allow <chat_id_or_@username>            Add user to dmAllowFrom
  remove-dm-allow <chat_id_or_@username>         Remove user from dmAllowFrom

  Legacy (whitelist → dmPolicy aliases):
  list-whitelist                                 → list-dm-allow
  add-whitelist <chat_id|username> <value>       → add-dm-allow
  remove-whitelist <chat_id|username> <value>    → remove-dm-allow

  show-owner                                     Show current owner
  help                                           Show this help

Permission flow:
  Private DM:  dmPolicy (open|allowlist|owner) + dmAllowFrom
  Group chat:  groupPolicy → groups config → per-group allowFrom
  Owner always bypasses all checks.

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
