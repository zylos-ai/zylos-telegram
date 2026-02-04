/**
 * Configuration loader for zylos-telegram
 * Loads from ~/zylos/.env and ~/zylos/components/telegram/config.json
 */

const fs = require('fs');
const path = require('path');

// Load .env from ~/zylos/.env
const envPath = path.join(process.env.HOME, 'zylos', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const CONFIG_PATH = path.join(process.env.HOME, 'zylos/components/telegram/config.json');

const DEFAULT_CONFIG = {
  enabled: true,
  owner: { chat_id: null, username: null, bound_at: null },
  whitelist: { chat_ids: [], usernames: [] },
  allowed_groups: [],
  smart_groups: [],
  features: {
    auto_split_messages: true,
    max_message_length: 4000,
    download_media: true
  }
};

function loadConfig() {
  try {
    const data = fs.readFileSync(CONFIG_PATH, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
  } catch (err) {
    console.error('[config] Failed to load config, using defaults:', err.message);
    return DEFAULT_CONFIG;
  }
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    return true;
  } catch (err) {
    console.error('[config] Failed to save config:', err.message);
    return false;
  }
}

function getEnv(key, defaultValue = '') {
  return process.env[key] || defaultValue;
}

module.exports = {
  loadConfig,
  saveConfig,
  getEnv,
  CONFIG_PATH
};
