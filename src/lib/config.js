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
  dmPolicy: 'owner',          // 'open' | 'allowlist' | 'owner'
  dmAllowFrom: [],            // chat_ids or @usernames allowed to DM (when dmPolicy=allowlist)
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
    const parsed = JSON.parse(data);
    const config = deepMergeDefaults(DEFAULT_CONFIG, parsed);
    // Runtime backward-compat: derive dmPolicy from legacy whitelist
    // Only triggers for configs with whitelist in file but no dmPolicy yet
    if ('whitelist' in parsed && !('dmPolicy' in parsed)) {
      const wl = parsed.whitelist || {};
      const hasEntries = (wl.chat_ids?.length > 0) || (wl.usernames?.length > 0);
      if (wl.enabled === false) {
        // Explicitly disabled whitelist → open access (no restrictions)
        config.dmPolicy = 'open';
      } else if (hasEntries || wl.enabled === true) {
        // Has entries or explicitly enabled → allowlist
        config.dmPolicy = 'allowlist';
        // Populate dmAllowFrom from legacy entries so remove-dm-allow works
        if (hasEntries && !('dmAllowFrom' in parsed)) {
          const legacyIds = (wl.chat_ids || []).map(String);
          const legacyUsers = (wl.usernames || []).map(u => `@${u.toLowerCase()}`);
          config.dmAllowFrom = [...legacyIds, ...legacyUsers];
        }
      } else {
        // No entries, no explicit enabled flag → restrictive default
        config.dmPolicy = 'owner';
      }
    }
    return config;
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
