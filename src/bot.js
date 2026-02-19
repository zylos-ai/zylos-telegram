/**
 * zylos-telegram - Telegram Bot for Zylos Agent
 * Main entry point
 */

import { Telegraf } from 'telegraf';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { exec, execFile } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import { loadConfig, getEnv, DATA_DIR } from './lib/config.js';
import { getHistoryKey } from './lib/utils.js';
import {
  hasOwner, bindOwner, isAuthorized, isOwner,
  isGroupAllowed, isSmartGroup, isSenderAllowed,
  getGroupName, addGroup
} from './lib/auth.js';
import { downloadPhoto, downloadDocument } from './lib/media.js';
import {
  logAndRecord, ensureReplay, getHistory,
  formatMessage
} from './lib/context.js';
import {
  resolveUserName,
  loadUserCache,
  startPersistInterval,
  persistUserCache
} from './lib/user-cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

const C4_RECEIVE = path.join(process.env.HOME, 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');

// Typing indicator state
const TYPING_DIR = path.join(DATA_DIR, 'typing');
fs.mkdirSync(TYPING_DIR, { recursive: true });

/** @type {Map<string, { interval: NodeJS.Timeout, startedAt: number }>} */
const activeTypingIndicators = new Map();

// User cache init
loadUserCache();
const cachePersistInterval = startPersistInterval();

/**
 * Parse c4-receive JSON response from stdout.
 * Returns parsed object or null if parsing fails.
 */
function parseC4Response(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * Send message to Claude via C4
 * @param {string} source - Channel name
 * @param {string} endpoint - Endpoint ID
 * @param {string} content - Message content
 * @param {function} [onReject] - Callback with error message when c4-receive rejects
 */
function sendToC4(source, endpoint, content, onReject) {
  if (!content) {
    console.error('[telegram] sendToC4 called with empty content');
    return;
  }
  const safeContent = content.replace(/'/g, "'\\''");

  const cmd = `node "${C4_RECEIVE}" --channel "${source}" --endpoint "${endpoint}" --json --content '${safeContent}'`;

  exec(cmd, { encoding: 'utf8' }, (error, stdout) => {
    if (!error) {
      console.log(`[telegram] Sent to C4: ${content.substring(0, 50)}...`);
      return;
    }
    // Non-zero exit - check if c4-receive returned a structured rejection
    const response = parseC4Response(error.stdout || stdout);
    if (response && response.ok === false && response.error?.message) {
      console.warn(`[telegram] C4 rejected (${response.error.code}): ${response.error.message}`);
      if (onReject) onReject(response.error.message);
      return;
    }
    // Unexpected failure (node crash, etc.) - retry once
    console.warn(`[telegram] C4 send failed, retrying in 2s: ${error.message}`);
    setTimeout(() => {
      exec(cmd, { encoding: 'utf8' }, (retryError, retryStdout) => {
        if (!retryError) {
          console.log(`[telegram] Sent to C4 (retry): ${content.substring(0, 50)}...`);
          return;
        }
        const retryResponse = parseC4Response(retryError.stdout || retryStdout);
        if (retryResponse && retryResponse.ok === false && retryResponse.error?.message) {
          console.error(`[telegram] C4 rejected after retry (${retryResponse.error.code}): ${retryResponse.error.message}`);
          if (onReject) onReject(retryResponse.error.message);
        } else {
          console.error(`[telegram] C4 send failed after retry: ${retryError.message}`);
          if (onReject) onReject('Internal error, please try again.');
        }
      });
    }, 2000);
  });
}

/**
 * Check if the bot is @mentioned using Telegram entities API.
 * Replaces fragile string.includes() check.
 *
 * @param {object} ctx - Telegraf context
 * @returns {boolean}
 */
function isBotMentioned(ctx) {
  const entities = ctx.message.entities || ctx.message.caption_entities || [];
  const text = ctx.message.text || ctx.message.caption || '';
  const botUsername = bot.botInfo?.username?.toLowerCase();
  if (!botUsername) return false;

  return entities.some(e => {
    if (e.type === 'mention') {
      const mentioned = text.slice(e.offset + 1, e.offset + e.length);
      return mentioned.toLowerCase() === botUsername;
    }
    return false;
  });
}

/**
 * Replace bot @mention with bot's display name using entity offsets.
 * Handles both text messages (entities) and media captions (caption_entities).
 * Processes in reverse offset order to preserve positions.
 *
 * @param {object} ctx - Telegraf context
 * @returns {string} Text with bot @mentions replaced by display name
 */
function replaceBotMention(ctx) {
  let text = ctx.message.text || ctx.message.caption || '';
  const entities = (ctx.message.entities || ctx.message.caption_entities || [])
    .filter(e => e.type === 'mention')
    .sort((a, b) => b.offset - a.offset); // Reverse order

  const botUsername = bot.botInfo?.username?.toLowerCase();
  if (!botUsername) return text;

  const botName = bot.botInfo?.first_name || botUsername;

  for (const e of entities) {
    const mentioned = text.slice(e.offset + 1, e.offset + e.length);
    if (mentioned.toLowerCase() === botUsername) {
      // Replace @handle with @displayName (keep the @ prefix)
      text = text.slice(0, e.offset) + '@' + botName + text.slice(e.offset + e.length);
    }
  }
  return text.trim();
}

/**
 * Start typing indicator for a chat.
 * Sends sendChatAction('typing') immediately and every 5 seconds.
 *
 * @param {string|number} chatId
 * @param {string} correlationId - Unique per request: `${chatId}:${messageId}`
 * @param {number|null} threadId - Optional message_thread_id for forum topics
 */
function startTypingIndicator(chatId, correlationId, threadId = null) {
  const opts = threadId ? { message_thread_id: threadId } : {};
  // Immediate first action
  bot.telegram.sendChatAction(chatId, 'typing', opts).catch(() => {});

  const interval = setInterval(() => {
    bot.telegram.sendChatAction(chatId, 'typing', opts).catch(() => {});
  }, 5000);

  activeTypingIndicators.set(correlationId, {
    interval,
    startedAt: Date.now()
  });
}

/**
 * Stop typing indicator by correlation ID.
 *
 * @param {string} correlationId
 */
function stopTypingIndicator(correlationId) {
  const state = activeTypingIndicators.get(correlationId);
  if (!state) return;
  clearInterval(state.interval);
  activeTypingIndicators.delete(correlationId);
}

/**
 * Handle a .done marker file: stop the typing indicator and delete the file.
 */
function handleTypingDoneFile(filename) {
  if (!filename || !filename.endsWith('.done')) return;
  const correlationId = filename.replace('.done', '');
  const filePath = path.join(TYPING_DIR, filename);

  if (activeTypingIndicators.has(correlationId)) {
    stopTypingIndicator(correlationId);
    console.log(`[telegram] Typing stopped for ${correlationId} (reply sent)`);
  }
  try { fs.unlinkSync(filePath); } catch {}
}

// Watch typing directory for done markers (event-driven)
let typingWatcher = null;
try {
  typingWatcher = fs.watch(TYPING_DIR, (eventType, filename) => {
    if (eventType === 'rename' && filename) {
      handleTypingDoneFile(filename);
    }
  });
} catch (err) {
  console.warn(`[telegram] fs.watch on typing/ failed: ${err.message}, relying on fallback poll`);
}

// Fallback poll every 30s (belt and suspenders for missed inotify events)
const typingPollInterval = setInterval(() => {
  try {
    const files = fs.readdirSync(TYPING_DIR);
    for (const f of files) {
      handleTypingDoneFile(f);
    }
  } catch {}

  // Auto-timeout: sweep indicators older than 120s
  const now = Date.now();
  for (const [id, state] of activeTypingIndicators) {
    if (now - state.startedAt > 120000) {
      stopTypingIndicator(id);
      console.log(`[telegram] Typing auto-timeout for ${id}`);
    }
  }
}, 30000);

// Clean up stale .done files from previous run
try {
  const staleFiles = fs.readdirSync(TYPING_DIR);
  for (const f of staleFiles) {
    try { fs.unlinkSync(path.join(TYPING_DIR, f)); } catch {}
  }
  if (staleFiles.length > 0) {
    console.log(`[telegram] Cleaned ${staleFiles.length} stale typing markers`);
  }
} catch {}

/**
 * Extract reply-to context from ctx.message.reply_to_message.
 * No API call needed - Telegram delivers it in the update payload.
 *
 * @param {object} ctx
 * @returns {{ sender: string, text: string }|null}
 */
function getReplyToContext(ctx) {
  if (!ctx.message.reply_to_message) return null;
  const reply = ctx.message.reply_to_message;
  return {
    sender: reply.from?.username || reply.from?.first_name || 'unknown',
    text: reply.text || reply.caption || '[media]'
  };
}

/**
 * Build structured endpoint string for C4.
 *
 * @param {string|number} chatId
 * @param {object} [opts]
 * @param {number} [opts.messageId] - Trigger message ID
 * @param {number|string} [opts.threadId] - Topic thread ID
 * @returns {string} e.g. "12345|msg:67890|req:12345:67890|thread:111"
 */
function buildEndpoint(chatId, { messageId, threadId } = {}) {
  let endpoint = String(chatId);
  const correlationId = messageId ? `${chatId}:${messageId}` : null;
  if (messageId) endpoint += `|msg:${messageId}`;
  if (correlationId) endpoint += `|req:${correlationId}`;
  if (threadId) endpoint += `|thread:${threadId}`;
  return endpoint;
}

/**
 * Notify owner about pending group approval
 */
function notifyOwnerPendingGroup(chatId, chatTitle, addedBy) {
  if (!config.owner?.chat_id) return;

  const adminPath = path.join(__dirname, 'admin.js');
  const message = `[System] Bot was added to a group, pending approval:\nGroup: ${chatTitle}\nID: ${chatId}\nAdded by: ${addedBy}\n\nTo approve, run:\nnode "${adminPath}" add-group "${chatId}" "${chatTitle}" mention`;

  const sendPath = path.join(__dirname, '..', 'scripts', 'send.js');
  // Use async execFile to avoid deadlock: send.js calls recordOutgoing()
  // which POSTs back to this process's internal HTTP server.
  // execFileSync would block the event loop, preventing the response.
  execFile('node', [sendPath, config.owner.chat_id, message], { encoding: 'utf8' }, (err) => {
    if (err) {
      console.error(`[telegram] Failed to notify owner: ${err.message}`);
    } else {
      console.log(`[telegram] Notified owner about pending group: ${chatTitle}`);
    }
  });
}

/**
 * Handle bot being added to a group
 */
bot.on('new_chat_members', (ctx) => {
  config = loadConfig();
  const newMembers = ctx.message.new_chat_members;
  const botId = bot.botInfo?.id;
  const botWasAdded = newMembers.some(member => member.id === botId);
  if (!botWasAdded) return;

  const chatId = ctx.chat.id;
  const chatTitle = ctx.chat.title || 'Unknown Group';
  const addedById = String(ctx.from.id);

  if (String(config.owner?.chat_id) === addedById) {
    const added = addGroup(config, chatId, chatTitle, 'mention');
    if (added) {
      ctx.reply(`Group added. Members can now @${bot.botInfo?.username} to chat.`);
    } else {
      ctx.reply('Group is already configured.');
    }
  } else {
    ctx.reply('Bot joined, but requires admin approval to respond.');
    notifyOwnerPendingGroup(chatId, chatTitle, ctx.from.username || ctx.from.first_name || addedById);
  }
});

/**
 * Handle bot's own chat member status changes (covers new group creation scenario)
 */
bot.on('my_chat_member', (ctx) => {
  const update = ctx.myChatMember;
  const oldStatus = update.old_chat_member.status;
  const newStatus = update.new_chat_member.status;

  // Only handle: bot went from non-member to member/admin
  const wasMember = ['member', 'administrator', 'creator'].includes(oldStatus);
  const isMember = ['member', 'administrator', 'creator'].includes(newStatus);
  if (wasMember || !isMember) return;

  const chat = update.chat;
  if (chat.type !== 'group' && chat.type !== 'supergroup') return;

  config = loadConfig();
  const chatId = chat.id;
  const chatTitle = chat.title || 'Unknown Group';
  const addedById = String(update.from.id);

  // Skip if group already registered (new_chat_members already handled it)
  if (config.groups && config.groups[String(chatId)]) return;

  if (String(config.owner?.chat_id) === addedById) {
    const added = addGroup(config, chatId, chatTitle, 'mention');
    if (added) {
      bot.telegram.sendMessage(chatId, `Group added. Members can now @${bot.botInfo?.username} to chat.`).catch(() => {});
    }
  } else {
    bot.telegram.sendMessage(chatId, 'Bot joined, but requires admin approval to respond.').catch(() => {});
    notifyOwnerPendingGroup(chatId, chatTitle, update.from.username || update.from.first_name || addedById);
  }
});

/**
 * Handle /start command
 */
bot.start((ctx) => {
  config = loadConfig();

  if (!hasOwner(config)) {
    bindOwner(config, ctx);
    ctx.reply('You are now the admin of this bot.');
    console.log(`[telegram] New owner: ${ctx.from.username || ctx.chat.id}`);
    return;
  }

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
  if (ctx.message.text.startsWith('/')) return;
  config = loadConfig();

  const chatId = ctx.chat.id;
  const chatType = ctx.chat.type;
  const messageId = ctx.message.message_id;
  const threadId = ctx.message.message_thread_id || null;
  const userName = resolveUserName(ctx.from);

  const logEntry = {
    timestamp: new Date().toISOString(),
    message_id: messageId,
    user_id: ctx.from.id,
    user_name: userName,
    text: ctx.message.text,
    thread_id: threadId
  };

  // === PRIVATE CHAT ===
  if (chatType === 'private') {
    if (!hasOwner(config)) bindOwner(config, ctx);
    if (!isAuthorized(config, ctx)) {
      ctx.reply('Sorry, this bot is private.');
      return;
    }

    logAndRecord(chatId, logEntry);
    const quotedContent = getReplyToContext(ctx);
    const endpoint = buildEndpoint(chatId, { messageId });
    const correlationId = `${chatId}:${messageId}`;
    bot.telegram.callApi('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: JSON.stringify([{ type: 'emoji', emoji: '👀' }])
    }).catch(() => {});
    startTypingIndicator(chatId, correlationId, threadId);

    const msg = formatMessage({
      chatType: 'private',
      userName,
      text: ctx.message.text,
      quotedContent,
      mediaPath: null
    });
    sendToC4('telegram', endpoint, msg, (errMsg) => {
      stopTypingIndicator(correlationId);
      bot.telegram.sendMessage(chatId, errMsg, threadId ? { message_thread_id: threadId } : {}).catch(() => {});
    });
    return;
  }

  // === GROUP / SUPERGROUP CHAT ===
  if (chatType === 'group' || chatType === 'supergroup') {
    const isAllowed = isGroupAllowed(config, chatId);
    const isSmart = isSmartGroup(config, chatId, threadId);
    const mentioned = isBotMentioned(ctx);
    const senderIsOwner = isOwner(config, ctx);

    // Replay log history before recording new entry to preserve chronological order
    ensureReplay(getHistoryKey(chatId, threadId));

    if (isAllowed) {
      logAndRecord(chatId, logEntry);
    }

    const policy = config.groupPolicy || 'allowlist';
    const shouldRespond =
      isSmart ||
      (isAllowed && mentioned) ||
      (policy !== 'disabled' && senderIsOwner && mentioned);

    if (!shouldRespond) {
      if (!isAllowed && mentioned) {
        console.log(`[telegram] Group not allowed: ${chatId}`);
      }
      return;
    }

    if (!senderIsOwner && !isSenderAllowed(config, chatId, ctx.from.id)) {
      console.log(`[telegram] Sender ${ctx.from.id} not in allowFrom for group ${chatId}`);
      return;
    }

    // Log owner messages from non-allowed groups only when responding
    if (!isAllowed && senderIsOwner) {
      logAndRecord(chatId, logEntry);
    }

    const historyKey = getHistoryKey(chatId, threadId);
    const contextMessages = getHistory(historyKey, messageId);
    const quotedContent = getReplyToContext(ctx);
    const groupName = getGroupName(config, chatId, ctx.chat.title);

    const cleanText = mentioned ? replaceBotMention(ctx) : ctx.message.text;

    const endpoint = buildEndpoint(chatId, { messageId, threadId });
    const correlationId = `${chatId}:${messageId}`;
    const smartNoMention = isSmart && !mentioned;

    // Eyes reaction for all group messages; typing only when @mentioned
    bot.telegram.callApi('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: JSON.stringify([{ type: 'emoji', emoji: '👀' }])
    }).catch(() => {});
    if (!smartNoMention) {
      startTypingIndicator(chatId, correlationId, threadId);
    }

    const sendReplyOpts = threadId ? { message_thread_id: threadId } : {};
    const msg = formatMessage({
      chatType,
      groupName,
      userName,
      text: cleanText || ctx.message.text,
      contextMessages,
      quotedContent,
      mediaPath: null,
      isThread: !!threadId,
      smartHint: smartNoMention
    });
    sendToC4('telegram', endpoint, msg, (errMsg) => {
      stopTypingIndicator(correlationId);
      bot.telegram.sendMessage(chatId, errMsg, sendReplyOpts).catch(() => {});
    });
  }
});

/**
 * Handle photo messages
 */
bot.on('photo', async (ctx) => {
  config = loadConfig();

  const chatType = ctx.chat.type;
  const chatId = ctx.chat.id;
  const messageId = ctx.message.message_id;
  const threadId = ctx.message.message_thread_id || null;
  const userName = resolveUserName(ctx.from);

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

    const photos = ctx.message.photo;
    const fileId = photos[photos.length - 1].file_id;
    const caption = ctx.message.caption || '[sent a photo]';
    const photoInfo = `[photo, file_id: ${fileId}, msg_id: ${messageId}]`;
    const logEntry = {
      timestamp: new Date().toISOString(),
      message_id: messageId,
      user_id: ctx.from.id,
      user_name: userName,
      text: `${caption}\n${photoInfo}`,
      thread_id: threadId
    };
    logAndRecord(chatId, logEntry);

    try {
      const localPath = await downloadPhoto(ctx);
      const endpoint = buildEndpoint(chatId, { messageId, threadId });
      const correlationId = `${chatId}:${messageId}`;
      bot.telegram.callApi('setMessageReaction', {
        chat_id: chatId,
        message_id: messageId,
        reaction: JSON.stringify([{ type: 'emoji', emoji: '👀' }])
      }).catch(() => {});
      startTypingIndicator(chatId, correlationId, threadId);

      const msg = formatMessage({
        chatType: 'private',
        userName,
        text: caption,
        quotedContent: getReplyToContext(ctx),
        mediaPath: localPath,
        isThread: !!threadId
      });
      sendToC4('telegram', endpoint, msg, (errMsg) => {
        stopTypingIndicator(correlationId);
        bot.telegram.sendMessage(chatId, errMsg, threadId ? { message_thread_id: threadId } : {}).catch(() => {});
      });
    } catch (err) {
      console.error(`[telegram] Photo download error: ${err.message}`);
      ctx.reply('Failed to download photo.');
    }
    return;
  }

  // Group chat
  const isAllowed = isGroupAllowed(config, chatId);
  const isSmart = isSmartGroup(config, chatId, threadId);
  if (!isAllowed && !isSmart) return;

  // Replay log history before recording new entry to preserve chronological order
  ensureReplay(getHistoryKey(chatId, threadId));

  // Build log text with photo metadata for context
  const photos = ctx.message.photo;
  const fileId = photos[photos.length - 1].file_id;
  const caption = ctx.message.caption || '';
  const photoInfo = `[photo, file_id: ${fileId}, msg_id: ${messageId}]`;
  const logText = caption ? `${caption}\n${photoInfo}` : photoInfo;
  const logEntry = {
    timestamp: new Date().toISOString(),
    message_id: messageId,
    user_id: ctx.from.id,
    user_name: userName,
    text: logText,
    thread_id: threadId
  };
  logAndRecord(chatId, logEntry);

  // Smart/mention groups: only download when @mentioned in caption
  if (isBotMentioned(ctx)) {
    if (!config.features.download_media) return;
    if (!isOwner(config, ctx) && !isSenderAllowed(config, chatId, ctx.from.id)) {
      console.log(`[telegram] Sender ${ctx.from.id} not in allowFrom for group ${chatId} (photo)`);
      return;
    }
    try {
      const localPath = await downloadPhoto(ctx);
      const endpoint = buildEndpoint(chatId, { messageId, threadId });
      const correlationId = `${chatId}:${messageId}`;
      bot.telegram.callApi('setMessageReaction', {
        chat_id: chatId,
        message_id: messageId,
        reaction: JSON.stringify([{ type: 'emoji', emoji: '👀' }])
      }).catch(() => {});
      startTypingIndicator(chatId, correlationId, threadId);

      const msg = formatMessage({
        chatType,
        groupName: getGroupName(config, chatId, ctx.chat.title),
        userName,
        text: caption ? replaceBotMention(ctx) : '[sent a photo]',
        contextMessages: getHistory(getHistoryKey(chatId, threadId), messageId),
        quotedContent: getReplyToContext(ctx),
        mediaPath: localPath,
        isThread: !!threadId
      });
      sendToC4('telegram', endpoint, msg, (errMsg) => {
        stopTypingIndicator(correlationId);
        bot.telegram.sendMessage(chatId, errMsg, threadId ? { message_thread_id: threadId } : {}).catch(() => {});
      });
    } catch (err) {
      console.error(`[telegram] Photo download error: ${err.message}`);
    }
    return;
  }

  // Not @mentioned in smart group: forward without downloading, eyes reaction
  if (isSmart) {
    if (!isOwner(config, ctx) && !isSenderAllowed(config, chatId, ctx.from.id)) return;

    const endpoint = buildEndpoint(chatId, { messageId, threadId });
    const correlationId = `${chatId}:${messageId}`;

    bot.telegram.callApi('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: JSON.stringify([{ type: 'emoji', emoji: '👀' }])
    }).catch(() => {});

    const msg = formatMessage({
      chatType,
      groupName: getGroupName(config, chatId, ctx.chat.title),
      userName,
      text: caption ? `${caption}\n${photoInfo}` : `[sent a photo]\n${photoInfo}`,
      contextMessages: getHistory(getHistoryKey(chatId, threadId), messageId),
      quotedContent: getReplyToContext(ctx),
      mediaPath: null,
      isThread: !!threadId,
      smartHint: true
    });
    sendToC4('telegram', endpoint, msg, (errMsg) => {
      stopTypingIndicator(correlationId);
      bot.telegram.sendMessage(chatId, errMsg, threadId ? { message_thread_id: threadId } : {}).catch(() => {});
    });
    return;
  }

  // Not @mentioned in non-smart group: logged with metadata only
  console.log(`[telegram] Photo logged for lazy download in group ${chatId}`);
});

/**
 * Handle document messages
 */
bot.on('document', async (ctx) => {
  config = loadConfig();

  const chatType = ctx.chat.type;
  const chatId = ctx.chat.id;
  const messageId = ctx.message.message_id;
  const threadId = ctx.message.message_thread_id || null;
  const userName = resolveUserName(ctx.from);

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

    const doc = ctx.message.document;
    const caption = ctx.message.caption || `[sent a file: ${doc.file_name}]`;
    const fileInfo = `[file: ${doc.file_name}, file_id: ${doc.file_id}, msg_id: ${messageId}]`;
    const logEntry = {
      timestamp: new Date().toISOString(),
      message_id: messageId,
      user_id: ctx.from.id,
      user_name: userName,
      text: `${caption}\n${fileInfo}`,
      thread_id: threadId
    };
    logAndRecord(chatId, logEntry);

    try {
      const localPath = await downloadDocument(ctx);
      const endpoint = buildEndpoint(chatId, { messageId, threadId });
      const correlationId = `${chatId}:${messageId}`;
      bot.telegram.callApi('setMessageReaction', {
        chat_id: chatId,
        message_id: messageId,
        reaction: JSON.stringify([{ type: 'emoji', emoji: '👀' }])
      }).catch(() => {});
      startTypingIndicator(chatId, correlationId, threadId);

      const msg = formatMessage({
        chatType: 'private',
        userName,
        text: caption,
        quotedContent: getReplyToContext(ctx),
        mediaPath: localPath,
        isThread: !!threadId
      });
      sendToC4('telegram', endpoint, msg, (errMsg) => {
        stopTypingIndicator(correlationId);
        bot.telegram.sendMessage(chatId, errMsg, threadId ? { message_thread_id: threadId } : {}).catch(() => {});
      });
    } catch (err) {
      console.error(`[telegram] Document download error: ${err.message}`);
      ctx.reply('Failed to download file.');
    }
    return;
  }

  // Group chat
  const isAllowed = isGroupAllowed(config, chatId);
  const isSmart = isSmartGroup(config, chatId, threadId);
  if (!isAllowed && !isSmart) return;

  // Replay log history before recording new entry to preserve chronological order
  ensureReplay(getHistoryKey(chatId, threadId));

  // Build log text with file metadata for context
  const doc = ctx.message.document;
  const caption = ctx.message.caption || '';
  const fileInfo = `[file: ${doc.file_name}, file_id: ${doc.file_id}, msg_id: ${messageId}]`;
  const logText = caption ? `${caption}\n${fileInfo}` : fileInfo;
  const logEntry = {
    timestamp: new Date().toISOString(),
    message_id: messageId,
    user_id: ctx.from.id,
    user_name: userName,
    text: logText,
    thread_id: threadId
  };
  logAndRecord(chatId, logEntry);

  // Smart/mention groups: only download when @mentioned in caption
  if (isBotMentioned(ctx)) {
    if (!config.features.download_media) return;
    if (!isOwner(config, ctx) && !isSenderAllowed(config, chatId, ctx.from.id)) {
      console.log(`[telegram] Sender ${ctx.from.id} not in allowFrom for group ${chatId} (document)`);
      return;
    }
    try {
      const localPath = await downloadDocument(ctx);
      const endpoint = buildEndpoint(chatId, { messageId, threadId });
      const correlationId = `${chatId}:${messageId}`;
      bot.telegram.callApi('setMessageReaction', {
        chat_id: chatId,
        message_id: messageId,
        reaction: JSON.stringify([{ type: 'emoji', emoji: '👀' }])
      }).catch(() => {});
      startTypingIndicator(chatId, correlationId, threadId);

      const msg = formatMessage({
        chatType,
        groupName: getGroupName(config, chatId, ctx.chat.title),
        userName,
        text: caption ? replaceBotMention(ctx) : `[sent a file: ${doc.file_name}]`,
        contextMessages: getHistory(getHistoryKey(chatId, threadId), messageId),
        quotedContent: getReplyToContext(ctx),
        mediaPath: localPath,
        isThread: !!threadId
      });
      sendToC4('telegram', endpoint, msg, (errMsg) => {
        stopTypingIndicator(correlationId);
        bot.telegram.sendMessage(chatId, errMsg, threadId ? { message_thread_id: threadId } : {}).catch(() => {});
      });
    } catch (err) {
      console.error(`[telegram] Document download error: ${err.message}`);
    }
    return;
  }

  // Not @mentioned in smart group: forward without downloading, eyes reaction
  if (isSmart) {
    if (!isOwner(config, ctx) && !isSenderAllowed(config, chatId, ctx.from.id)) return;

    const endpoint = buildEndpoint(chatId, { messageId, threadId });
    const correlationId = `${chatId}:${messageId}`;

    bot.telegram.callApi('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: JSON.stringify([{ type: 'emoji', emoji: '👀' }])
    }).catch(() => {});

    const msg = formatMessage({
      chatType,
      groupName: getGroupName(config, chatId, ctx.chat.title),
      userName,
      text: caption ? `${caption}\n${fileInfo}` : `[sent a file: ${doc.file_name}]\n${fileInfo}`,
      contextMessages: getHistory(getHistoryKey(chatId, threadId), messageId),
      quotedContent: getReplyToContext(ctx),
      mediaPath: null,
      isThread: !!threadId,
      smartHint: true
    });
    sendToC4('telegram', endpoint, msg, (errMsg) => {
      stopTypingIndicator(correlationId);
      bot.telegram.sendMessage(chatId, errMsg, threadId ? { message_thread_id: threadId } : {}).catch(() => {});
    });
    return;
  }

  // Not @mentioned in non-smart group: logged with metadata only
  console.log(`[telegram] Document logged for lazy download in group ${chatId}`);
});

// Internal HTTP server for recording bot's outgoing messages.
const INTERNAL_PORT = config.internal_port || 3460;
const MAX_BODY_SIZE = 64 * 1024;
const INTERNAL_TOKEN = crypto.createHash('sha256').update(botToken).digest('hex');

const internalServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/internal/record-outgoing') {
    const token = req.headers['x-internal-token'];
    if (token !== INTERNAL_TOKEN) {
      res.writeHead(403).end('forbidden');
      return;
    }

    let body = '';
    let size = 0;
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        aborted = true;
        res.writeHead(413).end('body too large');
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      if (res.headersSent) return;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end('invalid json');
        return;
      }

      const { chatId, threadId, text } = parsed;
      if (!chatId || !text) {
        res.writeHead(400).end('missing chatId or text');
        return;
      }

      logAndRecord(chatId, {
        timestamp: new Date().toISOString(),
        message_id: `bot:${Date.now()}`,
        user_id: 'bot',
        user_name: bot.botInfo?.username || 'bot',
        text: text.substring(0, 500),
        thread_id: threadId || null
      });
      res.writeHead(200).end('ok');
    });
  } else {
    res.writeHead(404).end();
  }
});

internalServer.listen(INTERNAL_PORT, '127.0.0.1', () => {
  console.log(`[telegram] Internal server on 127.0.0.1:${INTERNAL_PORT}`);
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
bot.launch({
  allowedUpdates: ['message', 'edited_message', 'callback_query', 'inline_query', 'my_chat_member']
}).then(() => {
  console.log('[telegram] zylos-telegram v0.2.0 started');
  console.log(`[telegram] Proxy: ${proxyUrl || 'none'}`);
  console.log(`[telegram] Bot: @${bot.botInfo?.username}`);
});

// Graceful shutdown
function cleanup() {
  persistUserCache();
  clearInterval(typingPollInterval);
  clearInterval(cachePersistInterval);
  if (typingWatcher) typingWatcher.close();
  for (const [id] of activeTypingIndicators) stopTypingIndicator(id);
  internalServer.close();
}
process.once('SIGINT', () => {
  cleanup();
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  cleanup();
  bot.stop('SIGTERM');
});
