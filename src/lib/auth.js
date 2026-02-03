/**
 * Authentication module for zylos-telegram
 * Handles owner auto-binding and whitelist verification
 */

const { loadConfig, saveConfig } = require('./config');

/**
 * Check if owner is bound
 */
function hasOwner(config) {
  return config.owner && config.owner.chat_id !== null;
}

/**
 * Bind first user as owner
 */
function bindOwner(config, ctx) {
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
  console.log(`[auth] Owner bound: ${username || chatId}`);

  return true;
}

/**
 * Check if user is the owner
 */
function isOwner(config, ctx) {
  if (!hasOwner(config)) return false;
  return String(ctx.chat.id) === String(config.owner.chat_id);
}

/**
 * Check if user is in whitelist
 */
function isWhitelisted(config, ctx) {
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
function isAuthorized(config, ctx) {
  return isOwner(config, ctx) || isWhitelisted(config, ctx);
}

/**
 * Add user to whitelist
 */
function addToWhitelist(config, chatId, username = null) {
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
function removeFromWhitelist(config, chatId) {
  chatId = String(chatId);

  config.whitelist.chat_ids = config.whitelist.chat_ids.filter(id => id !== chatId);
  saveConfig(config);
  return true;
}

/**
 * Check if group is in allowed_groups (can respond to @mentions)
 */
function isAllowedGroup(config, chatId) {
  chatId = String(chatId);
  if (!config.allowed_groups) return false;
  return config.allowed_groups.some(g => String(g.chat_id) === chatId);
}

/**
 * Add group to allowed_groups
 */
function addAllowedGroup(config, chatId, name) {
  chatId = String(chatId);
  if (!config.allowed_groups) {
    config.allowed_groups = [];
  }

  // Check if already exists
  if (config.allowed_groups.some(g => String(g.chat_id) === chatId)) {
    return false;
  }

  config.allowed_groups.push({
    chat_id: chatId,
    name: name,
    added_at: new Date().toISOString()
  });

  saveConfig(config);
  console.log(`[auth] Allowed group added: ${name} (${chatId})`);
  return true;
}

/**
 * Remove group from allowed_groups
 */
function removeAllowedGroup(config, chatId) {
  chatId = String(chatId);
  if (!config.allowed_groups) return false;

  const index = config.allowed_groups.findIndex(g => String(g.chat_id) === chatId);
  if (index === -1) return false;

  config.allowed_groups.splice(index, 1);
  saveConfig(config);
  return true;
}

/**
 * Check if chat is a smart group (receive all messages)
 */
function isSmartGroup(config, chatId) {
  chatId = String(chatId);
  if (!config.smart_groups) return false;
  return config.smart_groups.some(g => String(g.chat_id) === chatId);
}

/**
 * Get smart group name
 */
function getSmartGroupName(config, chatId) {
  chatId = String(chatId);
  const group = config.smart_groups.find(g => String(g.chat_id) === chatId);
  return group ? group.name : null;
}

module.exports = {
  hasOwner,
  bindOwner,
  isOwner,
  isWhitelisted,
  isAuthorized,
  addToWhitelist,
  removeFromWhitelist,
  isAllowedGroup,
  addAllowedGroup,
  removeAllowedGroup,
  isSmartGroup,
  getSmartGroupName
};
