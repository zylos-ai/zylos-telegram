/**
 * Configuration loader for zylos-telegram
 * Loads from ~/zylos/.env and ~/zylos/components/telegram/config.json
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Load .env from ~/zylos/.env (not cwd which may be skill directory)
dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

const HOME = process.env.HOME;
export const CONFIG_PATH = path.join(HOME, 'zylos/components/telegram/config.json');
export const DATA_DIR = path.join(HOME, 'zylos/components/telegram');

export const DEFAULT_CONFIG = {
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

export function loadConfig() {
  try {
    const data = fs.readFileSync(CONFIG_PATH, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
  } catch (err) {
    console.error('[telegram] Failed to load config, using defaults:', err.message);
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    return true;
  } catch (err) {
    console.error('[telegram] Failed to save config:', err.message);
    return false;
  }
}

export function getEnv(key, defaultValue = '') {
  return process.env[key] || defaultValue;
}
