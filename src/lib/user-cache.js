/**
 * User name cache for zylos-telegram v0.2.0
 * In-memory with TTL, persisted to file every 5 minutes.
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';

const CACHE_FILE = path.join(DATA_DIR, 'user-cache.json');
const USER_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/** @type {Map<string, { name: string, expireAt: number }>} */
const userCache = new Map();
let _dirty = false;

/**
 * Load cache from file on startup.
 */
export function loadUserCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      const now = Date.now();
      for (const [userId, name] of Object.entries(data)) {
        if (typeof name === 'string') {
          userCache.set(userId, { name, expireAt: now + USER_CACHE_TTL });
        }
      }
      console.log(`[telegram] Loaded ${userCache.size} cached user names`);
    }
  } catch (err) {
    console.log(`[telegram] Failed to load user cache: ${err.message}`);
  }
}

/**
 * Persist cache to file (batch write, called periodically).
 */
export function persistUserCache() {
  if (!_dirty) return;
  _dirty = false;
  const obj = {};
  for (const [userId, entry] of userCache) {
    obj[userId] = entry.name;
  }
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.log(`[telegram] Failed to persist user cache: ${err.message}`);
  }
}

/**
 * Resolve a Telegram user to a display name.
 * Updates cache with fresh data from ctx.from.
 *
 * @param {object} from - ctx.from object (has id, username, first_name)
 * @returns {string} Display name
 */
export function resolveUserName(from) {
  if (!from) return 'unknown';
  const userId = String(from.id);

  const cached = userCache.get(userId);
  if (cached && cached.expireAt > Date.now()) return cached.name;

  const name = from.username || from.first_name || userId;
  userCache.set(userId, { name, expireAt: Date.now() + USER_CACHE_TTL });
  _dirty = true;
  return name;
}

/**
 * Get a cached name by user ID (for log replay where ctx.from is unavailable).
 * Returns userId string if not cached.
 *
 * @param {string|number} userId
 * @returns {string}
 */
export function getCachedName(userId) {
  const cached = userCache.get(String(userId));
  return cached ? cached.name : String(userId);
}

/**
 * Start periodic persistence (call once at startup).
 * @returns {NodeJS.Timeout} interval handle
 */
export function startPersistInterval() {
  return setInterval(persistUserCache, 5 * 60 * 1000);
}
