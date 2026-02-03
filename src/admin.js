#!/usr/bin/env node
/**
 * zylos-telegram admin CLI
 * Manage telegram bot configuration
 *
 * Usage: node admin.js <command> [args]
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.env.HOME, 'zylos/components/telegram');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// Load config
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error(`Error loading config: ${err.message}`);
    process.exit(1);
  }
}

// Save config
function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Commands
const commands = {
  'show': () => {
    const config = loadConfig();
    console.log(JSON.stringify(config, null, 2));
  },

  'list-allowed-groups': () => {
    const config = loadConfig();
    const groups = config.allowed_groups || [];
    if (groups.length === 0) {
      console.log('No allowed groups configured');
    } else {
      console.log('Allowed Groups (can @mention bot):');
      groups.forEach(g => {
        console.log(`  ${g.chat_id} - ${g.name} (added: ${g.added_at || 'unknown'})`);
      });
    }
  },

  'add-allowed-group': (chatId, name) => {
    if (!chatId || !name) {
      console.error('Usage: admin.js add-allowed-group <chat_id> <name>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.allowed_groups) {
      config.allowed_groups = [];
    }

    // Check if already exists (use String() for consistent comparison)
    const exists = config.allowed_groups.find(g => String(g.chat_id) === String(chatId));
    if (exists) {
      console.log(`Group ${chatId} already in allowed_groups`);
      return;
    }

    config.allowed_groups.push({
      chat_id: chatId,
      name: name,
      added_at: new Date().toISOString()
    });
    saveConfig(config);
    console.log(`Added allowed group: ${chatId} (${name})`);
    console.log('Run: pm2 restart zylos-telegram');
  },

  'remove-allowed-group': (chatId) => {
    if (!chatId) {
      console.error('Usage: admin.js remove-allowed-group <chat_id>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.allowed_groups) {
      console.log('No allowed groups configured');
      return;
    }

    const index = config.allowed_groups.findIndex(g => String(g.chat_id) === String(chatId));
    if (index === -1) {
      console.log(`Group ${chatId} not found in allowed_groups`);
      return;
    }

    const removed = config.allowed_groups.splice(index, 1)[0];
    saveConfig(config);
    console.log(`Removed allowed group: ${chatId} (${removed.name})`);
    console.log('Run: pm2 restart zylos-telegram');
  },

  'list-smart-groups': () => {
    const config = loadConfig();
    const groups = config.smart_groups || [];
    if (groups.length === 0) {
      console.log('No smart groups configured');
    } else {
      console.log('Smart Groups (receive all messages):');
      groups.forEach(g => {
        console.log(`  ${g.chat_id} - ${g.name}`);
      });
    }
  },

  'add-smart-group': (chatId, name) => {
    if (!chatId || !name) {
      console.error('Usage: admin.js add-smart-group <chat_id> <name>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.smart_groups) {
      config.smart_groups = [];
    }

    // Check if already exists
    const exists = config.smart_groups.find(g => g.chat_id === chatId);
    if (exists) {
      console.log(`Group ${chatId} already in smart_groups`);
      return;
    }

    config.smart_groups.push({ chat_id: chatId, name: name });
    saveConfig(config);
    console.log(`Added smart group: ${chatId} (${name})`);
    console.log('Run: pm2 restart zylos-telegram');
  },

  'remove-smart-group': (chatId) => {
    if (!chatId) {
      console.error('Usage: admin.js remove-smart-group <chat_id>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.smart_groups) {
      console.log('No smart groups configured');
      return;
    }

    const index = config.smart_groups.findIndex(g => g.chat_id === chatId);
    if (index === -1) {
      console.log(`Group ${chatId} not found in smart_groups`);
      return;
    }

    const removed = config.smart_groups.splice(index, 1)[0];
    saveConfig(config);
    console.log(`Removed smart group: ${chatId} (${removed.name})`);
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
      saveConfig(config);
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
      saveConfig(config);
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

  'help': () => {
    console.log(`
zylos-telegram admin CLI

Commands:
  show                                Show full config

  Allowed Groups (can respond to @mentions):
  list-allowed-groups                 List allowed groups
  add-allowed-group <chat_id> <name>  Add an allowed group
  remove-allowed-group <chat_id>      Remove an allowed group

  Smart Groups (receive all messages):
  list-smart-groups                   List smart groups
  add-smart-group <chat_id> <name>    Add a smart group
  remove-smart-group <chat_id>        Remove a smart group

  Whitelist (private chat access):
  list-whitelist                      List whitelist entries
  add-whitelist <chat_id|username> <value>    Add to whitelist
  remove-whitelist <chat_id|username> <value> Remove from whitelist

  show-owner                          Show current owner
  help                                Show this help

Note: When owner adds bot to group, it's auto-approved.
      When others add bot, owner must manually approve.

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
