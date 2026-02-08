/**
 * zylos-telegram - Telegram Bot for Zylos Agent
 * Main entry point
 */

import { Telegraf } from 'telegraf';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { exec, execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig, getEnv } from './lib/config.js';
import { hasOwner, bindOwner, isAuthorized, isAllowedGroup, addAllowedGroup, isSmartGroup } from './lib/auth.js';
import { downloadPhoto, downloadDocument } from './lib/media.js';
import { logMessage, getGroupContext, updateCursor, formatContextPrefix } from './lib/context.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load config
let config = loadConfig();

// Setup bot with optional proxy
const botToken = getEnv('TELEGRAM_BOT_TOKEN');
if (!botToken) {
  console.error('[telegram] TELEGRAM_BOT_TOKEN not set in ~/zylos/.env');
  process.exit(1);
}

const proxyUrl = getEnv('TELEGRAM_PROXY_URL');
const botOptions = {};

if (proxyUrl) {
  console.log(`[telegram] Using proxy: ${proxyUrl}`);
  botOptions.telegram = {
    agent: new HttpsProxyAgent(proxyUrl)
  };
}

const bot = new Telegraf(botToken, botOptions);

// C4 receive interface path
const C4_RECEIVE = path.join(process.env.HOME, 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');

/**
 * Send message to Claude via C4
 */
function sendToC4(source, endpoint, content) {
  if (!content) {
    console.error('[telegram] sendToC4 called with empty content');
    return;
  }
  const safeContent = content.replace(/'/g, "'\\''");

  const cmd = `node "${C4_RECEIVE}" --channel "${source}" --endpoint "${endpoint}" --content '${safeContent}'`;

  exec(cmd, (error) => {
    if (!error) {
      console.log(`[telegram] Sent to C4: ${content.substring(0, 50)}...`);
      return;
    }
    console.warn(`[telegram] C4 send failed, retrying in 2s: ${error.message}`);
    setTimeout(() => {
      exec(cmd, (retryError) => {
        if (retryError) {
          console.error(`[telegram] C4 send failed after retry: ${retryError.message}`);
        } else {
          console.log(`[telegram] Sent to C4 (retry): ${content.substring(0, 50)}...`);
        }
      });
    }, 2000);
  });
}

/**
 * Format message for C4
 */
function formatMessage(ctx, text, mediaPath = null, contextPrefix = '') {
  const chatType = ctx.chat.type; // 'private', 'group', 'supergroup'
  const username = ctx.from.username || ctx.from.first_name || 'unknown';
  const chatId = ctx.chat.id;

  let prefix;
  if (chatType === 'private') {
    prefix = `[TG DM]`;
  } else {
    const groupName = getGroupName(config, chatId, ctx.chat.title);
    prefix = `[TG GROUP:${groupName}]`;
  }

  let message = `${prefix} ${username} said: ${contextPrefix}${text}`;

  if (mediaPath) {
    message += ` ---- file: ${mediaPath}`;
  }

  return message;
}

/**
 * Get group name from allowed_groups or smart_groups or chat title
 */
function getGroupName(config, chatId, chatTitle) {
  chatId = String(chatId);

  // Check smart_groups first
  const smartGroup = config.smart_groups?.find(g => String(g.chat_id) === chatId);
  if (smartGroup) return smartGroup.name;

  // Check allowed_groups
  const allowedGroup = config.allowed_groups?.find(g => String(g.chat_id) === chatId);
  if (allowedGroup) return allowedGroup.name;

  return chatTitle || 'group';
}

/**
 * Notify owner about pending group approval
 */
function notifyOwnerPendingGroup(chatId, chatTitle, addedBy) {
  if (!config.owner?.chat_id) return;

  const adminPath = path.join(__dirname, 'admin.js');
  const message = `[System] Bot was added to a group, pending approval:
Group: ${chatTitle}
ID: ${chatId}
Added by: ${addedBy}

To approve, run:
node "${adminPath}" add-allowed-group "${chatId}" "${chatTitle}"`;

  const sendPath = path.join(__dirname, '..', 'scripts', 'send.js');
  try {
    execSync(`node "${sendPath}" "${config.owner.chat_id}" '${message.replace(/'/g, "'\\''")}'`);
    console.log(`[telegram] Notified owner about pending group: ${chatTitle}`);
  } catch (err) {
    console.error(`[telegram] Failed to notify owner: ${err.message}`);
  }
}

/**
 * Handle bot being added to a group
 */
bot.on('new_chat_members', (ctx) => {
  config = loadConfig();

  const newMembers = ctx.message.new_chat_members;
  const botId = bot.botInfo?.id;

  // Check if bot was added
  const botWasAdded = newMembers.some(member => member.id === botId);
  if (!botWasAdded) return;

  const chatId = ctx.chat.id;
  const chatTitle = ctx.chat.title || 'Unknown Group';
  const addedBy = ctx.from.username || ctx.from.first_name || String(ctx.from.id);
  const addedById = String(ctx.from.id);

  console.log(`[telegram] Added to group: ${chatTitle} (${chatId}) by ${addedBy}`);

  // Check if adder is owner
  if (config.owner?.chat_id === addedById) {
    // Owner added bot - auto approve
    const added = addAllowedGroup(config, chatId, chatTitle);
    if (added) {
      ctx.reply(`Group added to whitelist. Members can now @${bot.botInfo?.username} to chat.`);
      console.log(`[telegram] Auto-approved group (owner added): ${chatTitle}`);
    } else {
      ctx.reply(`Group is already in whitelist.`);
    }
  } else {
    // Non-owner added bot - need approval
    ctx.reply(`Bot joined, but requires admin approval to respond.`);
    notifyOwnerPendingGroup(chatId, chatTitle, addedBy);
    console.log(`[telegram] Group pending approval: ${chatTitle}`);
  }
});

/**
 * Handle /start command
 */
bot.start((ctx) => {
  // Reload config
  config = loadConfig();

  // Check if owner needs to be bound
  if (!hasOwner(config)) {
    bindOwner(config, ctx);
    ctx.reply('You are now the admin of this bot.');
    console.log(`[telegram] New owner: ${ctx.from.username || ctx.chat.id}`);
    return;
  }

  // Check authorization
  if (!isAuthorized(config, ctx)) {
    ctx.reply('Sorry, this bot is private.');
    console.log(`[telegram] Unauthorized /start: ${ctx.from.username || ctx.chat.id}`);
    return;
  }

  ctx.reply('Bot is ready. Send me a message!');
});

/**
 * Handle text messages
 */
bot.on('text', (ctx) => {
  // Skip commands
  if (ctx.message.text.startsWith('/')) return;

  // Reload config periodically
  config = loadConfig();

  const chatId = ctx.chat.id;
  const chatType = ctx.chat.type;

  // Private chat: must be authorized
  if (chatType === 'private') {
    // Check if owner needs to be bound
    if (!hasOwner(config)) {
      bindOwner(config, ctx);
      ctx.reply('You are now the admin of this bot.');
    }

    if (!isAuthorized(config, ctx)) {
      ctx.reply('Sorry, this bot is private.');
      console.log(`[telegram] Unauthorized: ${ctx.from.username || chatId}`);
      return;
    }

    // Send to C4
    const message = formatMessage(ctx, ctx.message.text);
    sendToC4('telegram', String(chatId), message);
    return;
  }

  // Group chat: check permissions
  if (chatType === 'group' || chatType === 'supergroup') {
    const isAllowed = isAllowedGroup(config, chatId);
    const isSmartGrp = isSmartGroup(config, chatId);
    const botUsername = bot.botInfo?.username;
    const isMentioned = botUsername && ctx.message.text.includes(`@${botUsername}`);
    const senderIsOwner = config.owner && String(ctx.from.id) === String(config.owner.chat_id);

    // Log messages from allowed/smart groups for context
    if (isAllowed || isSmartGrp) {
      logMessage(chatId, ctx);
    }

    // Smart groups receive all messages
    if (isSmartGrp) {
      const message = formatMessage(ctx, ctx.message.text);
      sendToC4('telegram', String(chatId), message);
      return;
    }

    // Allowed groups respond to @mentions (with context)
    if (isAllowed && isMentioned) {
      const contextMessages = getGroupContext(chatId);
      const contextPrefix = formatContextPrefix(contextMessages);
      updateCursor(chatId, ctx.message.message_id);
      const cleanText = ctx.message.text.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim();
      const message = formatMessage(ctx, cleanText || ctx.message.text, null, contextPrefix);
      sendToC4('telegram', String(chatId), message);
      return;
    }

    // Owner can @mention bot in any group (even non-whitelisted, with context)
    if (senderIsOwner && isMentioned) {
      // Log this message for future context if not already logged
      if (!isAllowed && !isSmartGrp) {
        logMessage(chatId, ctx);
      }
      const contextMessages = getGroupContext(chatId);
      const contextPrefix = formatContextPrefix(contextMessages);
      updateCursor(chatId, ctx.message.message_id);
      const cleanText = ctx.message.text.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim();
      const message = formatMessage(ctx, cleanText || ctx.message.text, null, contextPrefix);
      sendToC4('telegram', String(chatId), message);
      return;
    }

    // Not in allowed_groups - ignore
    if (!isAllowed && isMentioned) {
      console.log(`[telegram] Group not allowed: ${chatId}`);
    }
  }
});

/**
 * Handle photo messages
 */
bot.on('photo', async (ctx) => {
  config = loadConfig();

  const chatType = ctx.chat.type;
  const chatId = ctx.chat.id;

  // For private chat: must be authorized, download immediately
  if (chatType === 'private') {
    if (!isAuthorized(config, ctx)) {
      ctx.reply('Sorry, this bot is private.');
      return;
    }
    if (!config.features.download_media) {
      ctx.reply('Media download is disabled.');
      return;
    }
    try {
      const localPath = await downloadPhoto(ctx);
      const caption = ctx.message.caption || '[sent a photo]';
      const message = formatMessage(ctx, caption, localPath);
      sendToC4('telegram', String(chatId), message);
      ctx.reply('Photo received!');
    } catch (err) {
      console.error(`[telegram] Photo download error: ${err.message}`);
      ctx.reply('Failed to download photo.');
    }
    return;
  }

  // Group chat
  const isAllowed = isAllowedGroup(config, chatId);
  const isSmartGrp = isSmartGroup(config, chatId);
  if (!isAllowed && !isSmartGrp) return;

  // Build log text with photo metadata for context
  const photos = ctx.message.photo;
  const fileId = photos[photos.length - 1].file_id;
  const caption = ctx.message.caption || '';
  const photoInfo = `[photo, file_id: ${fileId}, msg_id: ${ctx.message.message_id}]`;
  const logText = caption ? `${caption}\n${photoInfo}` : photoInfo;
  logMessage(chatId, ctx, logText);

  // Smart groups: download immediately
  if (isSmartGrp) {
    if (!config.features.download_media) return;
    try {
      const localPath = await downloadPhoto(ctx);
      const message = formatMessage(ctx, caption || '[sent a photo]', localPath);
      sendToC4('telegram', String(chatId), message);
    } catch (err) {
      console.error(`[telegram] Photo download error: ${err.message}`);
    }
    return;
  }

  // Non-smart groups: logged with metadata, lazy download via context
  console.log(`[telegram] Photo logged for lazy download in group ${chatId}`);
});

/**
 * Handle document messages
 */
bot.on('document', async (ctx) => {
  config = loadConfig();

  const chatType = ctx.chat.type;
  const chatId = ctx.chat.id;

  // For private chat: must be authorized, download immediately
  if (chatType === 'private') {
    if (!isAuthorized(config, ctx)) {
      ctx.reply('Sorry, this bot is private.');
      return;
    }
    if (!config.features.download_media) {
      ctx.reply('Media download is disabled.');
      return;
    }
    try {
      const localPath = await downloadDocument(ctx);
      const caption = ctx.message.caption || `[sent a file: ${ctx.message.document.file_name}]`;
      const message = formatMessage(ctx, caption, localPath);
      sendToC4('telegram', String(chatId), message);
      ctx.reply('File received!');
    } catch (err) {
      console.error(`[telegram] Document download error: ${err.message}`);
      ctx.reply('Failed to download file.');
    }
    return;
  }

  // Group chat
  const isAllowed = isAllowedGroup(config, chatId);
  const isSmartGrp = isSmartGroup(config, chatId);
  if (!isAllowed && !isSmartGrp) return;

  // Build log text with file metadata for context
  const doc = ctx.message.document;
  const caption = ctx.message.caption || '';
  const fileInfo = `[file: ${doc.file_name}, file_id: ${doc.file_id}, msg_id: ${ctx.message.message_id}]`;
  const logText = caption ? `${caption}\n${fileInfo}` : fileInfo;
  logMessage(chatId, ctx, logText);

  // Smart groups: download immediately
  if (isSmartGrp) {
    if (!config.features.download_media) return;
    try {
      const localPath = await downloadDocument(ctx);
      const message = formatMessage(ctx, caption || `[sent a file: ${doc.file_name}]`, localPath);
      sendToC4('telegram', String(chatId), message);
    } catch (err) {
      console.error(`[telegram] Document download error: ${err.message}`);
    }
    return;
  }

  // Non-smart groups: logged with metadata, lazy download via context
  console.log(`[telegram] Document logged for lazy download in group ${chatId}`);
});

/**
 * Error handling
 */
bot.catch((err, ctx) => {
  console.error(`[telegram] Error for ${ctx.updateType}:`, err.message);
});

/**
 * Start bot
 */
bot.launch().then(() => {
  console.log('[telegram] zylos-telegram started');
  console.log(`[telegram] Proxy: ${proxyUrl || 'none'}`);
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
