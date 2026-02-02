/**
 * zylos-telegram - Telegram Bot for Zylos Agent
 * Main entry point
 */

const { Telegraf } = require('telegraf');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { exec } = require('child_process');
const path = require('path');

const { loadConfig, getEnv } = require('./lib/config');
const { hasOwner, bindOwner, isOwner, isAuthorized, isSmartGroup, getSmartGroupName } = require('./lib/auth');
const { downloadPhoto, downloadDocument } = require('./lib/media');

// Load config
let config = loadConfig();

// Setup bot with optional proxy
const botToken = getEnv('TELEGRAM_BOT_TOKEN');
if (!botToken) {
  console.error('[bot] TELEGRAM_BOT_TOKEN not set in ~/zylos/.env');
  process.exit(1);
}

const proxyUrl = getEnv('TELEGRAM_PROXY_URL');
const botOptions = {};

if (proxyUrl) {
  console.log(`[bot] Using proxy: ${proxyUrl}`);
  botOptions.telegram = {
    agent: new HttpsProxyAgent(proxyUrl)
  };
}

const bot = new Telegraf(botToken, botOptions);

// C4 receive interface path
const C4_RECEIVE = path.join(process.env.HOME, '.claude/skills/comm-bridge/c4-receive.sh');

/**
 * Send message to Claude via C4
 */
function sendToC4(source, endpoint, content) {
  const safeContent = content.replace(/'/g, "'\\''");

  const cmd = `"${C4_RECEIVE}" --source "${source}" --endpoint "${endpoint}" --content '${safeContent}'`;

  exec(cmd, (error, stdout, stderr) => {
    if (error) {
      console.error(`[bot] C4 receive error: ${error.message}`);
    } else {
      console.log(`[bot] Sent to C4: ${content.substring(0, 50)}...`);
    }
  });
}

/**
 * Format message for C4
 */
function formatMessage(ctx, text, mediaPath = null) {
  const chatType = ctx.chat.type; // 'private', 'group', 'supergroup'
  const username = ctx.from.username || ctx.from.first_name || 'unknown';
  const chatId = ctx.chat.id;

  let prefix;
  if (chatType === 'private') {
    prefix = `[TG DM]`;
  } else {
    const groupName = getSmartGroupName(config, chatId) || ctx.chat.title || 'group';
    prefix = `[TG GROUP:${groupName}]`;
  }

  let message = `${prefix} ${username} said: ${text}`;

  if (mediaPath) {
    message += ` ---- file: ${mediaPath}`;
  }

  return message;
}

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
    console.log(`[bot] New owner: ${ctx.from.username || ctx.chat.id}`);
    return;
  }

  // Check authorization
  if (!isAuthorized(config, ctx)) {
    ctx.reply('Sorry, this bot is private.');
    console.log(`[bot] Unauthorized /start: ${ctx.from.username || ctx.chat.id}`);
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
      console.log(`[bot] Unauthorized: ${ctx.from.username || chatId}`);
      return;
    }

    // Send to C4
    const message = formatMessage(ctx, ctx.message.text);
    sendToC4('telegram', String(chatId), message);
    return;
  }

  // Group chat: check if smart group or @mention
  if (chatType === 'group' || chatType === 'supergroup') {
    const isSmartGrp = isSmartGroup(config, chatId);
    const botUsername = bot.botInfo?.username;
    const isMentioned = botUsername && ctx.message.text.includes(`@${botUsername}`);

    if (isSmartGrp || isMentioned) {
      const message = formatMessage(ctx, ctx.message.text);
      sendToC4('telegram', String(chatId), message);
    }
  }
});

/**
 * Handle photo messages
 */
bot.on('photo', async (ctx) => {
  config = loadConfig();

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
    sendToC4('telegram', String(ctx.chat.id), message);
    ctx.reply('Photo received!');
  } catch (err) {
    console.error(`[bot] Photo download error: ${err.message}`);
    ctx.reply('Failed to download photo.');
  }
});

/**
 * Handle document messages
 */
bot.on('document', async (ctx) => {
  config = loadConfig();

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
    sendToC4('telegram', String(ctx.chat.id), message);
    ctx.reply('File received!');
  } catch (err) {
    console.error(`[bot] Document download error: ${err.message}`);
    ctx.reply('Failed to download file.');
  }
});

/**
 * Error handling
 */
bot.catch((err, ctx) => {
  console.error(`[bot] Error for ${ctx.updateType}:`, err.message);
});

/**
 * Start bot
 */
bot.launch().then(() => {
  console.log('[bot] zylos-telegram started');
  console.log(`[bot] Proxy: ${proxyUrl || 'none'}`);
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
