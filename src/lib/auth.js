/**
 * Authentication module for zylos-telegram
 * Handles owner auto-binding and DM/group access control
 */

import { saveConfig } from './config.js';

/**
 * Check if owner is bound
 */
export function hasOwner(config) {
  return config.owner && config.owner.chat_id !== null;
}

/**
 * Bind first user as owner
 */
export function bindOwner(config, ctx) {
  const userId = String(ctx.from.id);
  const username = ctx.from.username || null;

  config.owner = {
    chat_id: userId,
    username: username,
    bound_at: new Date().toISOString()
  };

  // Auto-add owner to dmAllowFrom
  if (!Array.isArray(config.dmAllowFrom)) config.dmAllowFrom = [];
  if (!config.dmAllowFrom.includes(userId)) {
    config.dmAllowFrom.push(userId);
  }
  // Also maintain legacy whitelist for backward compat
  if (config.whitelist?.chat_ids && !config.whitelist.chat_ids.includes(userId)) {
    config.whitelist.chat_ids.push(userId);
  }

  if (!saveConfig(config)) {
    console.error('[telegram] Config change succeeded in memory but failed to persist to disk');
  }
  console.log(`[telegram] Owner bound: ${username || userId}`);

  return true;
}

/**
 * Check if user is the owner
 */
export function isOwner(config, ctx) {
  if (!hasOwner(config)) return false;
  return String(ctx.from.id) === String(config.owner.chat_id);
}

/**
 * Check DM access — uses dmPolicy + dmAllowFrom
 * Replaces legacy isWhitelisted/isAuthorized for private chat access control.
 */
export function isDmAllowed(config, ctx) {
  if (isOwner(config, ctx)) return true;
  const policy = config.dmPolicy || 'owner';
  if (policy === 'open') return true;
  if (policy === 'owner') return false;
  // policy === 'allowlist'
  const chatId = String(ctx.chat.id);
  const username = ctx.from.username?.toLowerCase();
  const allowFrom = (config.dmAllowFrom || []).map(String);
  // Backward compat: also check legacy whitelist
  if (config.whitelist?.chat_ids?.length) {
    for (const id of config.whitelist.chat_ids) {
      if (!allowFrom.includes(String(id))) allowFrom.push(String(id));
    }
  }
  if (config.whitelist?.usernames?.length) {
    for (const u of config.whitelist.usernames) {
      const prefixed = `@${u.toLowerCase()}`;
      if (!allowFrom.some(a => a.toLowerCase() === prefixed) && !allowFrom.some(a => a.toLowerCase() === u.toLowerCase())) {
        allowFrom.push(prefixed);
      }
    }
  }
  // Check chat_id match
  if (allowFrom.includes(chatId)) return true;
  // Check username match (with or without @ prefix)
  if (username) {
    if (allowFrom.some(a => a.toLowerCase() === `@${username}` || a.toLowerCase() === username)) return true;
  }
  return false;
}

// Legacy aliases for backward compatibility
export function isWhitelisted(config, ctx) { return isDmAllowed(config, ctx); }
export function isAuthorized(config, ctx) { return isDmAllowed(config, ctx); }

// ============================================================
// Group policy (v0.2.0 - replaces allowed_groups/smart_groups)
// ============================================================

/**
 * Get the config entry for a specific group.
 * @param {object} config
 * @param {string|number} chatId
 * @returns {object|undefined} Group config entry or undefined
 */
export function getGroupConfig(config, chatId) {
  chatId = String(chatId);
  return config.groups?.[chatId];
}

/**
 * Check if a group is allowed by the current policy.
 * @param {object} config
 * @param {string|number} chatId
 * @returns {boolean}
 */
export function isGroupAllowed(config, chatId) {
  chatId = String(chatId);
  const policy = config.groupPolicy || 'allowlist';

  if (policy === 'disabled') return false;
  if (policy === 'open') return true;
  // allowlist: must be in groups map
  return !!config.groups?.[chatId];
}

/**
 * Check if a group (or specific thread) is in "smart" mode.
 * Thread-level mode overrides group-level mode.
 * @param {object} config
 * @param {string|number} chatId
 * @param {string|number|null} threadId - Optional thread ID for forum topics
 * @returns {boolean}
 */
export function isSmartGroup(config, chatId, threadId = null) {
  chatId = String(chatId);
  const policy = config.groupPolicy || 'allowlist';
  if (policy === 'disabled') return false;
  const gc = config.groups?.[chatId];
  if (!gc) return false;
  // Check thread-level override first
  if (threadId && gc.threads?.[String(threadId)]?.mode) {
    return gc.threads[String(threadId)].mode === 'smart';
  }
  return gc.mode === 'smart';
}

/**
 * Check if a sender is allowed to trigger the bot in a group.
 * @param {object} config
 * @param {string|number} chatId
 * @param {string|number} senderId - Telegram user ID
 * @returns {boolean}
 */
export function isSenderAllowed(config, chatId, senderId) {
  chatId = String(chatId);
  senderId = String(senderId);
  const gc = config.groups?.[chatId];
  if (!gc?.allowFrom || gc.allowFrom.length === 0) return true;
  if (gc.allowFrom.includes('*')) return true;
  return gc.allowFrom.includes(senderId);
}

/**
 * Get the group's name from config or fallback.
 * @param {object} config
 * @param {string|number} chatId
 * @param {string} [chatTitle] - Telegram chat title fallback
 * @returns {string}
 */
export function getGroupName(config, chatId, chatTitle) {
  chatId = String(chatId);
  const gc = config.groups?.[chatId];
  return gc?.name || chatTitle || 'group';
}

/**
 * Add a group to the groups map.
 * @param {object} config - Mutable config object
 * @param {string|number} chatId
 * @param {string} name
 * @param {'mention'|'smart'} [mode='mention']
 * @returns {boolean} true if added, false if already exists
 */
export function addGroup(config, chatId, name, mode = 'mention') {
  chatId = String(chatId);
  if (!config.groups) config.groups = {};
  if (config.groups[chatId]) return false;

  config.groups[chatId] = {
    name,
    mode,
    allowFrom: ['*'],
    historyLimit: config.message?.context_messages || 5,
    added_at: new Date().toISOString()
  };

  if (!saveConfig(config)) {
    console.error('[telegram] Config change succeeded in memory but failed to persist to disk');
  }
  console.log(`[telegram] Group added: ${name} (${chatId}) mode=${mode}`);
  return true;
}

/**
 * Remove a group from the groups map.
 * @param {object} config
 * @param {string|number} chatId
 * @returns {boolean}
 */
export function removeGroup(config, chatId) {
  chatId = String(chatId);
  if (!config.groups?.[chatId]) return false;
  delete config.groups[chatId];
  if (!saveConfig(config)) {
    console.error('[telegram] Config change succeeded in memory but failed to persist to disk');
  }
  return true;
}
