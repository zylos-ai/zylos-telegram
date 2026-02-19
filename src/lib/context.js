/**
 * In-memory chat history and context formatting for zylos-telegram v0.2.0
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR, loadConfig } from './config.js';
import { getHistoryKey, historyKeyToLogFile, escapeXml } from './utils.js';

const LOGS_DIR = path.join(DATA_DIR, 'logs');
fs.mkdirSync(LOGS_DIR, { recursive: true });

// ============================================================
// In-memory history
// ============================================================

/** @type {Map<string, Array<HistoryEntry>>} */
const chatHistories = new Map();

/** @type {Set<string>} Track which historyKeys have been replayed from log files */
const _replayedKeys = new Set();

/**
 * @typedef {Object} HistoryEntry
 * @property {string} timestamp - ISO 8601
 * @property {number|string|null} message_id - Telegram message ID or synthetic bot:* ID
 * @property {string|number} user_id - Telegram user ID or 'bot'
 * @property {string} user_name - Display name
 * @property {string} text - Message text
 * @property {number|string|null} [thread_id] - Topic thread ID (null for non-topic)
 */

/**
 * Get history limit for a given historyKey.
 * Checks per-group config first, then global default.
 *
 * @param {string} historyKey
 * @returns {number}
 */
function getHistoryLimit(historyKey) {
  const config = loadConfig();
  // historyKey is either "chatId" or "chatId:threadId" - extract chatId
  const chatId = historyKey.includes(':') ? historyKey.split(':')[0] : historyKey;
  const groupConfig = config.groups?.[chatId];
  return groupConfig?.historyLimit || config.message?.context_messages || 5;
}

/**
 * Record a message into in-memory history.
 * Deduplicates by message_id (skips null/synthetic bot: IDs).
 *
 * @param {string} historyKey - From getHistoryKey()
 * @param {HistoryEntry} entry
 */
export function recordHistoryEntry(historyKey, entry) {
  if (!chatHistories.has(historyKey)) chatHistories.set(historyKey, []);
  const history = chatHistories.get(historyKey);

  // Dedup only real message IDs (skip null/synthetic)
  if (entry.message_id && !String(entry.message_id).startsWith('bot:')) {
    if (history.some(m => m.message_id === entry.message_id)) return;
  }

  history.push(entry);
  const limit = getHistoryLimit(historyKey);
  if (history.length > limit * 2) {
    chatHistories.set(historyKey, history.slice(-limit));
  }
}

/**
 * Get recent context messages from in-memory history.
 * Excludes the current message.
 *
 * @param {string} historyKey
 * @param {number|string|null} [excludeMessageId] - Current message to exclude
 * @returns {HistoryEntry[]}
 */
export function getHistory(historyKey, excludeMessageId) {
  const history = chatHistories.get(historyKey);
  if (!history || history.length === 0) return [];

  const limit = getHistoryLimit(historyKey);
  const filtered = excludeMessageId
    ? history.filter(m => m.message_id !== excludeMessageId)
    : history;
  return filtered.slice(-limit);
}

// ============================================================
// Cold-start replay from log files
// ============================================================

/**
 * Ensure in-memory history is populated for a given historyKey.
 * On first access after restart, reads tail of the per-key log file.
 *
 * @param {string} historyKey - From getHistoryKey() (chatId or chatId:threadId)
 */
export function ensureReplay(historyKey) {
  historyKey = String(historyKey);
  if (_replayedKeys.has(historyKey)) return;

  const logFile = path.join(LOGS_DIR, historyKeyToLogFile(historyKey));
  if (!fs.existsSync(logFile)) {
    _replayedKeys.add(historyKey);
    return;
  }

  const limit = getHistoryLimit(historyKey);

  try {
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l);
    const tail = lines.slice(-limit);

    for (const line of tail) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      recordHistoryEntry(historyKey, entry);
    }

    _replayedKeys.add(historyKey);
    if (tail.length > 0) {
      console.log(`[telegram] Replayed ${tail.length} log entries for ${historyKey}`);
    }
  } catch (err) {
    // Don't mark as replayed on failure — allow retry on next message
    console.error(`[telegram] Log replay failed for ${historyKey}: ${err.message}`);
  }
}

// ============================================================
// File logging (audit trail, unchanged hot path)
// ============================================================

/**
 * Append a log entry to the per-key log file.
 * Also records to in-memory history.
 *
 * @param {string} chatId
 * @param {HistoryEntry} entry - Must include thread_id field
 */
export function logAndRecord(chatId, entry) {
  chatId = String(chatId);
  const hk = getHistoryKey(chatId, entry.thread_id || null);

  // File log (audit) — per historyKey
  const logFile = path.join(LOGS_DIR, historyKeyToLogFile(hk));
  fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');

  // In-memory history
  recordHistoryEntry(hk, entry);
}

// ============================================================
// XML-structured message formatting
// ============================================================

/**
 * Format a complete C4 message with XML-structured context.
 *
 * @param {Object} opts
 * @param {'private'|'group'|'supergroup'} opts.chatType
 * @param {string} opts.groupName - Group display name (ignored for private)
 * @param {string} opts.userName - Sender display name
 * @param {string} opts.text - Current message text (already mention-stripped if needed)
 * @param {HistoryEntry[]} [opts.contextMessages] - Group/thread context
 * @param {{ sender: string, text: string }|null} [opts.quotedContent] - Reply-to content
 * @param {string|null} [opts.mediaPath] - Local file path for media attachment
 * @param {boolean} [opts.isThread] - True if this is a topic/forum thread
 * @returns {string}
 */
export function formatMessage(opts) {
  const {
    chatType, groupName, userName, text,
    contextMessages, quotedContent, mediaPath, isThread
  } = opts;

  // Prefix
  let prefix;
  if (chatType === 'private') {
    prefix = '[TG DM]';
  } else {
    prefix = `[TG GROUP:${groupName || 'group'}]`;
  }

  const parts = [`${prefix} ${escapeXml(userName)} said: `];

  // Context (group or thread)
  if (contextMessages && contextMessages.length > 0) {
    const tag = isThread ? 'thread-context' : 'group-context';
    const contextLines = contextMessages.map(m =>
      `[${escapeXml(m.user_name || String(m.user_id))}]: ${escapeXml(m.text)}`
    ).join('\n');
    parts.push(`<${tag}>\n${contextLines}\n</${tag}>\n\n`);
  }

  // Reply-to
  if (quotedContent) {
    const sender = escapeXml(quotedContent.sender || 'unknown');
    const quoted = escapeXml(quotedContent.text || '');
    parts.push(`<replying-to>\n[${sender}]: ${quoted}\n</replying-to>\n\n`);
  }

  // Current message
  parts.push(`<current-message>\n${escapeXml(text)}\n</current-message>`);

  let message = parts.join('');

  if (mediaPath) {
    message += ` ---- file: ${mediaPath}`;
  }

  return message;
}
