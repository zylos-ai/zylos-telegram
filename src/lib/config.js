/**
 * Configuration loader for zylos-telegram
 * Loads from ~/zylos/.env and ~/zylos/components/telegram/config.json
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { deepMergeDefaults } from './utils.js';

// Load .env from ~/zylos/.env (not cwd which may be skill directory)
dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

const HOME = process.env.HOME;
export const CONFIG_PATH = path.join(HOME, 'zylos/components/telegram/config.json');
export const DATA_DIR = path.join(HOME, 'zylos/components/telegram');

export const DEFAULT_CONFIG = {
  enabled: true,
  owner: { chat_id: null, username: null, bound_at: null },
  whitelist: { chat_ids: [], usernames: [] },
  // New v0.2.0 group policy (replaces allowed_groups/smart_groups after migration)
  groupPolicy: 'allowlist',   // 'disabled' | 'allowlist' | 'open'
  groups: {},                 // { [chatId]: { name, mode, allowFrom, historyLimit, added_at } }
  features: {
    download_media: true
  },
  message: {
    context_messages: 5
  },
  internal_port: 3460         // Port for internal HTTP server (record-outgoing)
};

export function loadConfig() {
  try {
    const data = fs.readFileSync(CONFIG_PATH, 'utf8');
    return deepMergeDefaults(DEFAULT_CONFIG, JSON.parse(data));
  } catch (err) {
    console.error('[telegram] Failed to load config, using defaults:', err.message);
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

export function saveConfig(config) {
  const tmp = CONFIG_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, CONFIG_PATH);
    return true;
  } catch (err) {
    console.error('[telegram] Failed to save config:', err.message);
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

export function getEnv(key, defaultValue = '') {
  return process.env[key] || defaultValue;
}
