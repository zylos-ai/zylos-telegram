/**
 * Group context management for zylos-telegram
 * Logs messages and provides context for @mentions
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR, loadConfig } from './config.js';

const LOGS_DIR = path.join(DATA_DIR, 'logs');
const CURSORS_PATH = path.join(DATA_DIR, 'group-cursors.json');

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// Load/save cursors
let groupCursors = {};
try {
  if (fs.existsSync(CURSORS_PATH)) {
    groupCursors = JSON.parse(fs.readFileSync(CURSORS_PATH, 'utf-8'));
  }
} catch {}

function saveCursors() {
  fs.writeFileSync(CURSORS_PATH, JSON.stringify(groupCursors, null, 2));
}

/**
 * Log a message to the chat's log file
 * @param {string} chatId
 * @param {object} ctx - Telegraf context
 * @param {string} [textOverride] - Override text (e.g., with file metadata for lazy download)
 */
export function logMessage(chatId, ctx, textOverride = null) {
  chatId = String(chatId);
  const username = ctx.from.username || ctx.from.first_name || 'unknown';
  const userId = ctx.from.id;
  const messageId = ctx.message.message_id;
  const text = textOverride || ctx.message.text || ctx.message.caption || '';

  const logEntry = {
    timestamp: new Date().toISOString(),
    message_id: messageId,
    user_id: userId,
    user_name: username,
    text: text
  };

  const logFile = path.join(LOGS_DIR, `${chatId}.log`);
  fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
}

/**
 * Get recent context messages for a group
 */
export function getGroupContext(chatId) {
  chatId = String(chatId);
  const logFile = path.join(LOGS_DIR, `${chatId}.log`);
  if (!fs.existsSync(logFile)) return [];

  const config = loadConfig();
  const MIN_CONTEXT = 5;
  const MAX_CONTEXT = config.message?.context_messages ?? 10;
  const cursor = groupCursors[chatId] || null;

  const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(l => l);
  const messages = lines.map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(m => m);

  if (messages.length === 0) return [];

  let cursorIndex = -1;
  let currentIndex = messages.length - 1;

  if (cursor) {
    cursorIndex = messages.findIndex(m => m.message_id === cursor);
  }

  // Get messages since cursor (excluding current message)
  let contextMessages = messages.slice(cursorIndex + 1, currentIndex);

  // If not enough context, get recent messages instead
  if (contextMessages.length < MIN_CONTEXT && currentIndex > 0) {
    const startIndex = Math.max(0, currentIndex - MIN_CONTEXT);
    contextMessages = messages.slice(startIndex, currentIndex);
  }

  return contextMessages.slice(-MAX_CONTEXT);
}

/**
 * Update cursor after responding to a message
 */
export function updateCursor(chatId, messageId) {
  chatId = String(chatId);
  groupCursors[chatId] = messageId;
  saveCursors();
}

/**
 * Format context messages as text
 */
export function formatContextPrefix(contextMessages) {
  if (!contextMessages || contextMessages.length === 0) return '';

  const contextLines = contextMessages.map(m =>
    `[${m.user_name}]: ${m.text}`
  ).join('\n');

  return `[Group context - recent messages before this @mention:]\n${contextLines}\n\n[Current message:] `;
}
