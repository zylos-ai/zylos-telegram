/**
 * zylos-telegram - Telegram Bot for Zylos Agent
 * Main entry point
 */

import { Telegraf } from 'telegraf';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { exec, execSync, execFileSync } from 'child_process';
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
  recordHistoryEntry, formatMessage
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
startPersistInterval();

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
 * Strip bot @mention from text using entity offsets (precise, not regex).
 * Processes in reverse offset order to preserve positions.
 *
 * @param {object} ctx - Telegraf context
 * @returns {string} Text with bot mentions removed
 */
function stripBotMention(ctx) {
  let text = ctx.message.text || '';
  const entities = (ctx.message.entities || [])
    .filter(e => e.type === 'mention')
    .sort((a, b) => b.offset - a.offset); // Reverse order

  const botUsername = bot.botInfo?.username?.toLowerCase();
  if (!botUsername) return text;

  for (const e of entities) {
    const mentioned = text.slice(e.offset + 1, e.offset + e.length);
    if (mentioned.toLowerCase() === botUsername) {
      text = text.slice(0, e.offset) + text.slice(e.offset + e.length);
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
 */
function startTypingIndicator(chatId, correlationId) {
  // Immediate first action
  bot.telegram.sendChatAction(chatId, 'typing').catch(() => {});

  const interval = setInterval(() => {
    bot.telegram.sendChatAction(chatId, 'typing').catch(() => {});
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
try {
  fs.watch(TYPING_DIR, (eventType, filename) => {
    if (eventType === 'rename' && filename) {
      handleTypingDoneFile(filename);
    }
  });
} catch (err) {
  console.warn(`[telegram] fs.watch on typing/ failed: ${err.message}, relying on fallback poll`);
}

// Fallback poll every 30s (belt and suspenders for missed inotify events)
setInterval(() => {
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
  try {
    execFileSync('node', [sendPath, config.owner.chat_id, message], { encoding: 'utf8' });
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
  const botWasAdded = newMembers.some(member => member.id === botId);
  if (!botWasAdded) return;

  const chatId = ctx.chat.id;
  const chatTitle = ctx.chat.title || 'Unknown Group';
  const addedById = String(ctx.from.id);

  if (config.owner?.chat_id === addedById) {
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
    startTypingIndicator(chatId, correlationId);

    const msg = formatMessage({
      chatType: 'private',
      userName,
      text: ctx.message.text,
      quotedContent,
      mediaPath: null
    });
    sendToC4('telegram', endpoint, msg, (errMsg) => {
      stopTypingIndicator(correlationId);
      bot.telegram.sendMessage(chatId, errMsg).catch(() => {});
    });
    return;
  }

  // === GROUP / SUPERGROUP CHAT ===
  if (chatType === 'group' || chatType === 'supergroup') {
    const isAllowed = isGroupAllowed(config, chatId);
    const isSmart = isSmartGroup(config, chatId);
    const mentioned = isBotMentioned(ctx);
    const senderIsOwner = isOwner(config, ctx);

    let logged = false;
    if (isAllowed || senderIsOwner) {
      logAndRecord(chatId, logEntry);
      logged = true;
    }

    const shouldRespond =
      isSmart ||
      (isAllowed && mentioned) ||
      (senderIsOwner && mentioned);

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

    const historyKey = getHistoryKey(chatId, threadId);
    ensureReplay(String(chatId));

    const contextMessages = getHistory(historyKey, messageId);
    const quotedContent = getReplyToContext(ctx);
    const groupName = getGroupName(config, chatId, ctx.chat.title);

    const cleanText = mentioned ? stripBotMention(ctx) : ctx.message.text;

    const endpoint = buildEndpoint(chatId, { messageId, threadId });
    const correlationId = `${chatId}:${messageId}`;
    startTypingIndicator(chatId, correlationId);

    const msg = formatMessage({
      chatType,
      groupName,
      userName,
      text: cleanText || ctx.message.text,
      contextMessages,
      quotedContent,
      mediaPath: null,
      isThread: !!threadId
    });
    sendToC4('telegram', endpoint, msg, (errMsg) => {
      stopTypingIndicator(correlationId);
      bot.telegram.sendMessage(chatId, errMsg).catch(() => {});
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
      startTypingIndicator(chatId, correlationId);

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
        bot.telegram.sendMessage(chatId, errMsg).catch(() => {});
      });
      ctx.reply('Photo received!');
    } catch (err) {
      console.error(`[telegram] Photo download error: ${err.message}`);
      ctx.reply('Failed to download photo.');
    }
    return;
  }

  // Group chat
  const isAllowed = isGroupAllowed(config, chatId);
  const isSmart = isSmartGroup(config, chatId);
  if (!isAllowed && !isSmart) return;

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

  // Smart groups: download immediately
  if (isSmart) {
    if (!config.features.download_media) return;
    if (!isSenderAllowed(config, chatId, ctx.from.id)) {
      console.log(`[telegram] Sender ${ctx.from.id} not in allowFrom for group ${chatId} (photo)`);
      return;
    }
    try {
      const localPath = await downloadPhoto(ctx);
      const endpoint = buildEndpoint(chatId, { messageId, threadId });
      const correlationId = `${chatId}:${messageId}`;
      startTypingIndicator(chatId, correlationId);
      ensureReplay(String(chatId));

      const msg = formatMessage({
        chatType,
        groupName: getGroupName(config, chatId, ctx.chat.title),
        userName,
        text: caption || '[sent a photo]',
        contextMessages: getHistory(getHistoryKey(chatId, threadId), messageId),
        quotedContent: getReplyToContext(ctx),
        mediaPath: localPath,
        isThread: !!threadId
      });
      sendToC4('telegram', endpoint, msg, (errMsg) => {
        stopTypingIndicator(correlationId);
        bot.telegram.sendMessage(chatId, errMsg).catch(() => {});
      });
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
      startTypingIndicator(chatId, correlationId);

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
        bot.telegram.sendMessage(chatId, errMsg).catch(() => {});
      });
      ctx.reply('File received!');
    } catch (err) {
      console.error(`[telegram] Document download error: ${err.message}`);
      ctx.reply('Failed to download file.');
    }
    return;
  }

  // Group chat
  const isAllowed = isGroupAllowed(config, chatId);
  const isSmart = isSmartGroup(config, chatId);
  if (!isAllowed && !isSmart) return;

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

  // Smart groups: download immediately
  if (isSmart) {
    if (!config.features.download_media) return;
    if (!isSenderAllowed(config, chatId, ctx.from.id)) {
      console.log(`[telegram] Sender ${ctx.from.id} not in allowFrom for group ${chatId} (document)`);
      return;
    }
    try {
      const localPath = await downloadDocument(ctx);
      const endpoint = buildEndpoint(chatId, { messageId, threadId });
      const correlationId = `${chatId}:${messageId}`;
      startTypingIndicator(chatId, correlationId);
      ensureReplay(String(chatId));

      const msg = formatMessage({
        chatType,
        groupName: getGroupName(config, chatId, ctx.chat.title),
        userName,
        text: caption || `[sent a file: ${doc.file_name}]`,
        contextMessages: getHistory(getHistoryKey(chatId, threadId), messageId),
        quotedContent: getReplyToContext(ctx),
        mediaPath: localPath,
        isThread: !!threadId
      });
      sendToC4('telegram', endpoint, msg, (errMsg) => {
        stopTypingIndicator(correlationId);
        bot.telegram.sendMessage(chatId, errMsg).catch(() => {});
      });
    } catch (err) {
      console.error(`[telegram] Document download error: ${err.message}`);
    }
    return;
  }

  // Non-smart groups: logged with metadata, lazy download via context
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

      const historyKey = getHistoryKey(chatId, threadId);
      recordHistoryEntry(historyKey, {
        timestamp: new Date().toISOString(),
        message_id: `bot:${Date.now()}`,
        user_id: 'bot',
        user_name: bot.botInfo?.username || 'bot',
        text: text.substring(0, 500)
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
bot.launch().then(() => {
  console.log('[telegram] zylos-telegram v0.2.0 started');
  console.log(`[telegram] Proxy: ${proxyUrl || 'none'}`);
  console.log(`[telegram] Bot: @${bot.botInfo?.username}`);
});

// Graceful shutdown
process.once('SIGINT', () => {
  persistUserCache();
  bot.stop('SIGINT');
  internalServer.close();
});
process.once('SIGTERM', () => {
  persistUserCache();
  bot.stop('SIGTERM');
  internalServer.close();
});
