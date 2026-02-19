/**
 * Authentication module for zylos-telegram
 * Handles owner auto-binding and whitelist verification
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
  const chatId = String(ctx.chat.id);
  const username = ctx.from.username || null;

  config.owner = {
    chat_id: chatId,
    username: username,
    bound_at: new Date().toISOString()
  };

  // Auto-add owner to whitelist
  if (!config.whitelist.chat_ids.includes(chatId)) {
    config.whitelist.chat_ids.push(chatId);
  }

  saveConfig(config);
  console.log(`[telegram] Owner bound: ${username || chatId}`);

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
 * Check if user is in whitelist
 */
export function isWhitelisted(config, ctx) {
  const chatId = String(ctx.chat.id);
  const username = ctx.from.username?.toLowerCase();

  // Check chat_id
  if (config.whitelist.chat_ids.includes(chatId)) {
    return true;
  }

  // Check username
  if (username && config.whitelist.usernames.some(u => u.toLowerCase() === username)) {
    return true;
  }

  return false;
}

/**
 * Check if user is authorized (owner or whitelisted)
 */
export function isAuthorized(config, ctx) {
  return isOwner(config, ctx) || isWhitelisted(config, ctx);
}

/**
 * Add user to whitelist
 */
export function addToWhitelist(config, chatId, username = null) {
  chatId = String(chatId);

  if (!config.whitelist.chat_ids.includes(chatId)) {
    config.whitelist.chat_ids.push(chatId);
  }

  if (username && !config.whitelist.usernames.includes(username.toLowerCase())) {
    config.whitelist.usernames.push(username.toLowerCase());
  }

  saveConfig(config);
  return true;
}

/**
 * Remove user from whitelist
 */
export function removeFromWhitelist(config, chatId) {
  chatId = String(chatId);

  config.whitelist.chat_ids = config.whitelist.chat_ids.filter(id => id !== chatId);
  saveConfig(config);
  return true;
}

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
 * Check if a group is in "smart" mode (receive all messages).
 * @param {object} config
 * @param {string|number} chatId
 * @returns {boolean}
 */
export function isSmartGroup(config, chatId) {
  chatId = String(chatId);
  const gc = config.groups?.[chatId];
  return gc?.mode === 'smart';
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
    historyLimit: config.message?.context_messages || 10,
    added_at: new Date().toISOString()
  };

  saveConfig(config);
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
  saveConfig(config);
  return true;
}
