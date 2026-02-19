# zylos-telegram v0.2.0 Implementation Plan

> This document provides exact specifications for implementing the v0.2.0 upgrade
> as described in `docs/upgrade-plan-v0.2.md`. Every file change, function signature,
> and data structure is defined so that an implementer (human or AI) can write code
> directly without guessing design intent.
>
> **Reference implementation:** zylos-lark v0.1.5 (`src/index.js`, `scripts/send.js`)
> is the battle-tested source for most patterns adopted here.

---

## Table of Contents

1. [File Inventory](#1-file-inventory)
2. [New File: `src/lib/utils.js`](#2-new-file-srclibutils-js)
3. [Rewrite: `src/lib/config.js`](#3-rewrite-srclibconfigjs)
4. [Rewrite: `src/lib/context.js`](#4-rewrite-srclibcontextjs)
5. [New File: `src/lib/user-cache.js`](#5-new-file-srclibuser-cachejs)
6. [Rewrite: `src/lib/auth.js`](#6-rewrite-srclibauth-js)
7. [Rewrite: `src/bot.js`](#7-rewrite-srcbotjs)
8. [Rewrite: `scripts/send.js`](#8-rewrite-scriptssendjs)
9. [Rewrite: `src/admin.js`](#9-rewrite-srcadminjs)
10. [Update: `hooks/post-install.js`](#10-update-hookspost-installjs)
11. [Rewrite: `hooks/post-upgrade.js`](#11-rewrite-hookspost-upgradejs)
12. [Update: `package.json`](#12-update-packagejson)
13. [Update: `ecosystem.config.cjs`](#13-update-ecosystemconfigcjs)
14. [Implementation Sequence](#14-implementation-sequence)
15. [Testing Checklist](#15-testing-checklist)

---

## 1. File Inventory

### New files
| File | Purpose |
|------|---------|
| `src/lib/utils.js` | Shared utilities: `parseEndpoint`, `getHistoryKey`, `escapeXml`, `deepMergeDefaults` |
| `src/lib/user-cache.js` | User name cache with in-memory TTL + file persistence |

### Modified files
| File | Nature of change |
|------|------------------|
| `src/lib/config.js` | Add `deepMergeDefaults` to `loadConfig()`, update `DEFAULT_CONFIG` schema |
| `src/lib/context.js` | Full rewrite: in-memory `chatHistories` Map, cold-start log replay, XML formatting |
| `src/lib/auth.js` | Replace `isAllowedGroup`/`isSmartGroup` with unified group policy model |
| `src/bot.js` | Major rewrite: entity-based mention, typing indicator, reply-to, internal HTTP server, thread support |
| `scripts/send.js` | parseEndpoint, reply-to, code-block-aware chunking, 429 retry, typing marker, record-outgoing |
| `src/admin.js` | New commands for unified group policy |
| `hooks/post-install.js` | Create `typing/` directory |
| `hooks/post-upgrade.js` | Add config migration: legacy arrays → groups map |
| `package.json` | Version bump 0.1.1 → 0.2.0 |
| `ecosystem.config.cjs` | No change needed (cwd already correct) |

### Deleted exports (removed, not re-exported)
- `context.js`: `logMessage`, `getGroupContext`, `updateCursor`, `formatContextPrefix` — replaced by new API
- `auth.js`: `isSmartGroup`, `getSmartGroupName`, `addAllowedGroup`, `removeAllowedGroup` — replaced by group policy

---

## 2. New File: `src/lib/utils.js`

Shared utilities imported by `bot.js`, `context.js`, `send.js`, `auth.js`, and `admin.js`.

```javascript
/**
 * Shared utilities for zylos-telegram v0.2.0
 */

/**
 * Parse structured endpoint string.
 * Format: chatId|key:value|key:value...
 * Keys: msg, req, thread (extendable, unknown keys ignored).
 * First occurrence wins for duplicate keys.
 *
 * @param {string} endpoint - Raw endpoint string
 * @returns {{ chatId: string, [key: string]: string }}
 */
export function parseEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'string') return { chatId: '' };
  const parts = endpoint.split('|');
  const result = { chatId: parts[0] };
  for (let i = 1; i < parts.length; i++) {
    const sep = parts[i].indexOf(':');
    if (sep > 0 && sep < parts[i].length - 1) {
      const key = parts[i].slice(0, sep);
      if (!(key in result)) {
        result[key] = parts[i].slice(sep + 1);
      }
    }
  }
  return result;
}

/**
 * Build composite history key for per-topic isolation.
 * Thread IDs in Telegram are only unique within a chat, so we prefix with chatId.
 *
 * @param {string|number} chatId
 * @param {string|number|null|undefined} threadId
 * @returns {string}
 */
export function getHistoryKey(chatId, threadId) {
  return threadId ? `${chatId}:${threadId}` : String(chatId);
}

/**
 * Escape user-generated content for safe embedding inside XML tags.
 * Prevents tag injection from user messages.
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeXml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;');
}

/**
 * Deep merge defaults into loaded config (one level deep).
 * Prevents shallow spread from losing nested default fields.
 *
 * @param {object} defaults
 * @param {object} loaded
 * @returns {object}
 */
export function deepMergeDefaults(defaults, loaded) {
  const result = { ...defaults, ...loaded };
  for (const key of Object.keys(defaults)) {
    if (
      defaults[key] &&
      typeof defaults[key] === 'object' &&
      !Array.isArray(defaults[key])
    ) {
      result[key] = { ...defaults[key], ...(loaded[key] || {}) };
    }
  }
  return result;
}
```

**No dependencies.** Pure functions only.

---

## 3. Rewrite: `src/lib/config.js`

### Changes

1. **Import `deepMergeDefaults` from `utils.js`** and use it in `loadConfig()`.
2. **Update `DEFAULT_CONFIG`** to the new schema (add `groupPolicy`, `groups`, `internal_port`; keep legacy fields for migration compat).
3. **Replace shallow merge** `{ ...DEFAULT_CONFIG, ...JSON.parse(data) }` with `deepMergeDefaults(DEFAULT_CONFIG, JSON.parse(data))`.

### New DEFAULT_CONFIG

```javascript
export const DEFAULT_CONFIG = {
  enabled: true,
  owner: { chat_id: null, username: null, bound_at: null },
  whitelist: { chat_ids: [], usernames: [] },
  // New v0.2.0 group policy (replaces allowed_groups/smart_groups after migration)
  groupPolicy: 'allowlist',   // 'disabled' | 'allowlist' | 'open'
  groups: {},                  // { [chatId]: { name, mode, allowFrom, historyLimit, added_at } }
  features: {
    download_media: true
  },
  message: {
    context_messages: 10
  },
  internal_port: 3460          // Port for internal HTTP server (record-outgoing)
};
```

### Updated loadConfig()

```javascript
import { deepMergeDefaults } from './utils.js';

export function loadConfig() {
  try {
    const data = fs.readFileSync(CONFIG_PATH, 'utf8');
    return deepMergeDefaults(DEFAULT_CONFIG, JSON.parse(data));
  } catch (err) {
    console.error('[telegram] Failed to load config, using defaults:', err.message);
    return { ...DEFAULT_CONFIG };
  }
}
```

### No other changes to this file.

---

## 4. Rewrite: `src/lib/context.js`

Full rewrite. The new module manages in-memory chat histories and provides XML-formatted
message context. It replaces all functions from the old module.

### Exports

```javascript
/**
 * In-memory chat history and context formatting for zylos-telegram v0.2.0
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR, loadConfig } from './config.js';
import { getHistoryKey, escapeXml } from './utils.js';

const LOGS_DIR = path.join(DATA_DIR, 'logs');
fs.mkdirSync(LOGS_DIR, { recursive: true });

// ============================================================
// In-memory history
// ============================================================

/** @type {Map<string, Array<HistoryEntry>>} */
const chatHistories = new Map();

/** @type {Set<string>} Track which chatIds have been replayed from log files */
const _replayedChats = new Set();

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
  // historyKey is either "chatId" or "chatId:threadId" — extract chatId
  const chatId = historyKey.includes(':') ? historyKey.split(':')[0] : historyKey;
  const groupConfig = config.groups?.[chatId];
  return groupConfig?.historyLimit || config.message?.context_messages || 10;
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
 * Ensure in-memory history is populated for a given chatId.
 * On first access after restart, reads tail of log file and routes entries
 * to the correct historyKey (per-topic or flat).
 *
 * @param {string} chatId - The Telegram chat ID (NOT composite historyKey)
 */
export function ensureReplay(chatId) {
  chatId = String(chatId);
  if (_replayedChats.has(chatId)) return;
  _replayedChats.add(chatId);

  const logFile = path.join(LOGS_DIR, `${chatId}.log`);
  if (!fs.existsSync(logFile)) return;

  const config = loadConfig();
  const limit = config.message?.context_messages || 10;
  // Read last limit*3 lines to account for thread distribution
  const readLimit = limit * 3;

  try {
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l);
    const tail = lines.slice(-readLimit);

    for (const line of tail) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const hk = getHistoryKey(chatId, entry.thread_id || null);
      recordHistoryEntry(hk, entry);
    }

    if (tail.length > 0) {
      console.log(`[telegram] Replayed ${tail.length} log entries for chat ${chatId}`);
    }
  } catch (err) {
    console.error(`[telegram] Log replay failed for ${chatId}: ${err.message}`);
  }
}

// ============================================================
// File logging (audit trail, unchanged hot path)
// ============================================================

/**
 * Append a log entry to the chat's log file.
 * Also records to in-memory history.
 *
 * @param {string} chatId
 * @param {HistoryEntry} entry - Must include thread_id field
 */
export function logAndRecord(chatId, entry) {
  chatId = String(chatId);

  // File log (audit)
  const logFile = path.join(LOGS_DIR, `${chatId}.log`);
  fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');

  // In-memory history
  const hk = getHistoryKey(chatId, entry.thread_id || null);
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
```

### Key differences from v0.1.1 `context.js`:
- **No more `getGroupContext()`** reading full file — replaced by `getHistory()` from Map
- **No more `groupCursors`** file — cursor concept eliminated (simple array slicing)
- **`logMessage()` → `logAndRecord()`** — unified log+record, includes `thread_id`
- **`formatContextPrefix()` → `formatMessage()`** — full XML-structured output
- **Cold-start replay** via `ensureReplay()` — called lazily on first context request

---

## 5. New File: `src/lib/user-cache.js`

```javascript
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
```

---

## 6. Rewrite: `src/lib/auth.js`

### Changes

1. **Remove** `isAllowedGroup`, `addAllowedGroup`, `removeAllowedGroup`, `isSmartGroup`, `getSmartGroupName`.
2. **Add** unified group policy functions matching the upgrade plan.
3. Keep `hasOwner`, `bindOwner`, `isOwner`, `isAuthorized`, `isWhitelisted`, whitelist functions unchanged.

### New group policy exports

```javascript
// ============================================================
// Group policy (v0.2.0 — replaces allowed_groups/smart_groups)
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
```

### Retained exports (unchanged logic)

- `hasOwner(config)`
- `bindOwner(config, ctx)`
- `isOwner(config, ctx)`
- `isWhitelisted(config, ctx)`
- `isAuthorized(config, ctx)`
- `addToWhitelist(config, chatId, username)`
- `removeFromWhitelist(config, chatId)`

---

## 7. Rewrite: `src/bot.js`

This is the largest change. Below is the complete structure with exact function signatures
and behavioral specifications.

### Imports

```javascript
import { Telegraf } from 'telegraf';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { exec } from 'child_process';
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
import { resolveUserName, loadUserCache, startPersistInterval } from './lib/user-cache.js';
```

### Module-level state

```javascript
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let config = loadConfig();

// Bot setup (same as v0.1.1)
const botToken = getEnv('TELEGRAM_BOT_TOKEN');
// ... proxy setup identical to v0.1.1 ...
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
```

### 7.1 Mention Detection (Section 7 of upgrade plan)

```javascript
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
```

### 7.2 Typing Indicator (Section 2 of upgrade plan)

```javascript
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

// --- fs.watch() on typing directory for done markers ---

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
  if (staleFiles.length > 0) console.log(`[telegram] Cleaned ${staleFiles.length} stale typing markers`);
} catch {}
```

### 7.3 Reply-To Context (Section 4 of upgrade plan)

```javascript
/**
 * Extract reply-to context from ctx.message.reply_to_message.
 * No API call needed — Telegram delivers it in the update payload.
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
```

### 7.4 C4 Send (unchanged from v0.1.1 except endpoint building)

`sendToC4()` and `parseC4Response()` remain identical to v0.1.1.

### 7.5 Build Endpoint String

```javascript
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
```

### 7.6 Main Text Handler (`bot.on('text')`)

Complete rewrite following the upgrade plan. Pseudocode structure:

```javascript
bot.on('text', (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  config = loadConfig();

  const chatId = ctx.chat.id;
  const chatType = ctx.chat.type;
  const messageId = ctx.message.message_id;
  const threadId = ctx.message.message_thread_id || null;
  const userName = resolveUserName(ctx.from);

  // Build log entry (includes thread_id for topic-aware replay)
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
      mediaPath: null,
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

    // Log to file + in-memory for allowed groups
    if (isAllowed || senderIsOwner) {
      logAndRecord(chatId, logEntry);
    }

    // Determine if we should respond
    const shouldRespond =
      (isSmart) ||
      (isAllowed && mentioned) ||
      (senderIsOwner && mentioned);

    if (!shouldRespond) {
      if (!isAllowed && mentioned) {
        console.log(`[telegram] Group not allowed: ${chatId}`);
      }
      return;
    }

    // Check sender allowFrom
    if (!senderIsOwner && !isSenderAllowed(config, chatId, ctx.from.id)) {
      console.log(`[telegram] Sender ${ctx.from.id} not in allowFrom for group ${chatId}`);
      return;
    }

    // If not already logged (owner in non-allowed group)
    if (!isAllowed && !isSmart && senderIsOwner) {
      logAndRecord(chatId, logEntry);
    }

    // Ensure cold-start replay
    const historyKey = getHistoryKey(chatId, threadId);
    ensureReplay(String(chatId));

    // Get context
    const contextMessages = getHistory(historyKey, messageId);
    const quotedContent = getReplyToContext(ctx);
    const groupName = getGroupName(config, chatId, ctx.chat.title);

    // Strip bot mention from text
    const cleanText = mentioned ? stripBotMention(ctx) : ctx.message.text;

    // Build endpoint and start typing
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
      isThread: !!threadId,
    });
    sendToC4('telegram', endpoint, msg, (errMsg) => {
      stopTypingIndicator(correlationId);
      bot.telegram.sendMessage(chatId, errMsg).catch(() => {});
    });
  }
});
```

### 7.7 Photo and Document Handlers

Same structure as v0.1.1 but updated to:
- Use `resolveUserName(ctx.from)` instead of inline resolution
- Use `logAndRecord()` instead of `logMessage()`
- Use `isGroupAllowed()` / `isSmartGroup()` from new auth module
- Use `formatMessage()` for XML output
- Include `thread_id` in log entries
- Start typing indicator before C4 send

### 7.8 `new_chat_members` Handler

Updated to use `addGroup()` instead of `addAllowedGroup()`:

```javascript
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
      ctx.reply(`Group is already configured.`);
    }
  } else {
    ctx.reply(`Bot joined, but requires admin approval to respond.`);
    notifyOwnerPendingGroup(chatId, chatTitle, ctx.from.username || ctx.from.first_name || addedById);
  }
});
```

### 7.9 Internal HTTP Server (Section 6 of upgrade plan)

```javascript
/**
 * Internal HTTP server for recording bot's outgoing messages.
 * Listens on 127.0.0.1 only. Authenticated via X-Internal-Token.
 */
const INTERNAL_PORT = config.internal_port || 3460;
const MAX_BODY_SIZE = 64 * 1024;

// Token: SHA-256 hash of bot token (same pattern as zylos-lark uses app_id)
const INTERNAL_TOKEN = crypto.createHash('sha256').update(botToken).digest('hex');

const internalServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/internal/record-outgoing') {
    // Auth check
    const token = req.headers['x-internal-token'];
    if (token !== INTERNAL_TOKEN) {
      res.writeHead(403).end('forbidden');
      return;
    }

    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        res.writeHead(413).end('body too large');
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
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
```

### 7.10 Startup & Shutdown

```javascript
bot.launch().then(() => {
  console.log('[telegram] zylos-telegram v0.2.0 started');
  console.log(`[telegram] Proxy: ${proxyUrl || 'none'}`);
  console.log(`[telegram] Bot: @${bot.botInfo?.username}`);
});

process.once('SIGINT', () => {
  persistUserCache();
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  persistUserCache();
  bot.stop('SIGTERM');
});
```

---

## 8. Rewrite: `scripts/send.js`

### Changes summary
1. Import `parseEndpoint` from `src/lib/utils.js`
2. Endpoint parsing: extract `chatId`, `msg`, `req`, `thread`
3. Reply-to: first chunk uses `reply_to_message_id` from `msg` field
4. Thread support: include `message_thread_id` from `thread` field
5. Code-block-aware `splitMessage()` (from zylos-lark)
6. 429 retry with `retry_after` (refactored `apiRequest`)
7. Typing done marker (write `typing/{req}.done`)
8. Record outgoing (POST to internal HTTP server)

### Detailed specifications

#### 8.1 Endpoint Parsing

```javascript
import { parseEndpoint } from '../src/lib/utils.js';

// After argument parsing:
const parsed = parseEndpoint(args[0]);
const chatId = parsed.chatId;
const triggerMsgId = parsed.msg ? parseInt(parsed.msg, 10) : null;
const correlationId = parsed.req || null;
const threadId = parsed.thread ? parseInt(parsed.thread, 10) : null;
```

#### 8.2 Refactored apiRequest with 429 retry

```javascript
/**
 * Make Telegram API request via curl.
 * Returns parsed response.result on success.
 * Throws error with telegramResponse property on failure.
 */
function apiRequest(method, params) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

  let curlCmd;
  if (params.photo || params.document) {
    const filePath = params.photo || params.document;
    const fieldName = params.photo ? 'photo' : 'document';
    curlCmd = `curl -s -X POST "${url}" -F "chat_id=${params.chat_id}" -F "${fieldName}=@${filePath}"`;
    if (params.reply_to_message_id) {
      curlCmd += ` -F "reply_to_message_id=${params.reply_to_message_id}"`;
    }
    if (params.message_thread_id) {
      curlCmd += ` -F "message_thread_id=${params.message_thread_id}"`;
    }
  } else {
    const jsonData = JSON.stringify(params);
    curlCmd = `curl -s -X POST "${url}" -H "Content-Type: application/json" -d '${jsonData.replace(/'/g, "'\\''")}'`;
  }

  if (PROXY_URL) {
    curlCmd = curlCmd.replace('curl ', `curl --proxy "${PROXY_URL}" `);
  }

  const result = execSync(curlCmd, { encoding: 'utf8' });
  const response = JSON.parse(result);
  if (response.ok) return response.result;

  const err = new Error(response.description || 'API error');
  err.telegramResponse = response;
  throw err;
}

/**
 * API request with 429 retry.
 */
async function apiRequestWithRetry(method, params, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return apiRequest(method, params);
    } catch (err) {
      const tgErr = err.telegramResponse;
      if (tgErr?.error_code === 429 && attempt < maxRetries) {
        const retryAfter = (tgErr.parameters?.retry_after || 5) * 1000;
        console.warn(`[telegram] Rate limited, retrying in ${retryAfter}ms`);
        await sleep(retryAfter);
        continue;
      }
      throw err;
    }
  }
}
```

#### 8.3 Code-block-aware splitMessage()

Identical algorithm to zylos-lark `scripts/send.js` lines 78-136:

```javascript
function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let breakAt = maxLength;

    // Check if we're inside a code block at the break point
    const segment = remaining.substring(0, breakAt);
    const fenceMatches = segment.match(/```/g);
    const insideCodeBlock = fenceMatches && fenceMatches.length % 2 !== 0;

    if (insideCodeBlock) {
      // Try to break before the code block
      const lastFenceStart = segment.lastIndexOf('```');
      const lineBeforeFence = remaining.lastIndexOf('\n', lastFenceStart - 1);
      if (lineBeforeFence > maxLength * 0.2) {
        breakAt = lineBeforeFence;
      } else {
        // Or include the full code block
        const fenceEnd = remaining.indexOf('```', lastFenceStart + 3);
        if (fenceEnd !== -1) {
          const blockEnd = remaining.indexOf('\n', fenceEnd + 3);
          breakAt = blockEnd !== -1 ? blockEnd + 1 : fenceEnd + 3;
        }
        if (breakAt > maxLength) {
          breakAt = maxLength; // Hard split as last resort
        }
      }
    } else {
      // Prefer paragraph breaks > line breaks > word boundaries
      const chunk = remaining.substring(0, breakAt);
      const lastParaBreak = chunk.lastIndexOf('\n\n');
      if (lastParaBreak > maxLength * 0.3) {
        breakAt = lastParaBreak + 1;
      } else {
        const lastNewline = chunk.lastIndexOf('\n');
        if (lastNewline > maxLength * 0.3) {
          breakAt = lastNewline;
        } else {
          const lastSpace = chunk.lastIndexOf(' ');
          if (lastSpace > maxLength * 0.3) {
            breakAt = lastSpace;
          }
        }
      }
    }

    chunks.push(remaining.substring(0, breakAt).trim());
    remaining = remaining.substring(breakAt).trim();
  }

  return chunks;
}
```

#### 8.4 sendText with reply-to + thread support

```javascript
async function sendText(text) {
  const chunks = splitMessage(text, MAX_LENGTH);

  for (let i = 0; i < chunks.length; i++) {
    const isFirstChunk = i === 0;
    const params = { chat_id: chatId, text: chunks[i] };

    // Thread support: all chunks go to the correct topic
    if (threadId) {
      params.message_thread_id = threadId;
    }

    // Reply-to: first chunk replies to trigger message
    if (isFirstChunk && triggerMsgId) {
      params.reply_to_message_id = triggerMsgId;
    }

    try {
      await apiRequestWithRetry('sendMessage', params);
    } catch (err) {
      // If reply_to fails (message deleted/too old), retry without it
      if (params.reply_to_message_id && err.telegramResponse?.error_code === 400) {
        console.warn('[telegram] reply_to_message_id failed, sending without reply');
        delete params.reply_to_message_id;
        await apiRequestWithRetry('sendMessage', params);
      } else {
        throw err;
      }
    }

    console.log(`Sent chunk ${i + 1}/${chunks.length}`);
    if (i < chunks.length - 1) {
      await sleep(500); // Increased from 300ms to reduce 429 likelihood
    }
  }
}
```

#### 8.5 Typing done marker

```javascript
function markTypingDone() {
  if (!correlationId) return;
  try {
    const typingDir = path.join(DATA_DIR, 'typing');
    fs.mkdirSync(typingDir, { recursive: true });
    fs.writeFileSync(path.join(typingDir, `${correlationId}.done`), String(Date.now()));
  } catch {} // Non-critical
}
```

Where `DATA_DIR` is imported from `../src/lib/config.js`.

#### 8.6 Record outgoing

```javascript
import crypto from 'crypto';

const INTERNAL_TOKEN = crypto.createHash('sha256').update(BOT_TOKEN).digest('hex');

async function recordOutgoing(text) {
  const port = 3460; // Must match config.internal_port
  try {
    const body = JSON.stringify({
      chatId,
      threadId: threadId || null,
      text
    });
    // Use fetch (available in Node 20+)
    await fetch(`http://127.0.0.1:${port}/internal/record-outgoing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': INTERNAL_TOKEN,
      },
      body
    });
  } catch {} // Non-critical, best-effort
}
```

#### 8.7 Updated main()

```javascript
async function main() {
  try {
    if (message.startsWith('[MEDIA:image]')) {
      const filePath = message.substring('[MEDIA:image]'.length);
      await sendPhoto(filePath);
      markTypingDone();
      console.log(`Sent photo to ${chatId}`);
      return;
    }

    if (message.startsWith('[MEDIA:file]')) {
      const filePath = message.substring('[MEDIA:file]'.length);
      await sendDocument(filePath);
      markTypingDone();
      console.log(`Sent file to ${chatId}`);
      return;
    }

    await sendText(message);
    markTypingDone();
    await recordOutgoing(message);
    console.log('Message sent successfully');

  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
```

Note: `sendPhoto` and `sendDocument` also need `reply_to_message_id` and
`message_thread_id` support in their `params` object, following the same
pattern as `sendText`.

---

## 9. Rewrite: `src/admin.js`

### New commands (replacing old group commands)

| Command | Arguments | Description |
|---------|-----------|-------------|
| `show` | — | Show full config |
| `list-groups` | — | List all groups with mode/allowFrom/historyLimit |
| `add-group` | `<chat_id> <name> [mode]` | Add group (mode: `mention` or `smart`, default: `mention`) |
| `remove-group` | `<chat_id>` | Remove group |
| `set-group-policy` | `<open\|allowlist\|disabled>` | Set global group policy |
| `set-group-mode` | `<chat_id> <mention\|smart>` | Change group mode |
| `set-group-allowfrom` | `<chat_id> <user_ids...>` | Set allowFrom (use `*` for all) |
| `set-group-history-limit` | `<chat_id> <limit>` | Set per-group history limit |
| `list-whitelist` | — | (unchanged) |
| `add-whitelist` | `<chat_id\|username> <value>` | (unchanged) |
| `remove-whitelist` | `<chat_id\|username> <value>` | (unchanged) |
| `show-owner` | — | (unchanged) |
| `help` | — | Updated help text |

### Implementation notes

- `add-group` calls `addGroup()` from `auth.js`
- `remove-group` calls `removeGroup()` from `auth.js`
- `set-group-policy` directly updates `config.groupPolicy` and calls `saveConfig()`
- `set-group-mode` updates `config.groups[chatId].mode` and calls `saveConfig()`
- `set-group-allowfrom` updates `config.groups[chatId].allowFrom` and calls `saveConfig()`
- `set-group-history-limit` updates `config.groups[chatId].historyLimit` and calls `saveConfig()`
- Remove all legacy commands: `list-allowed-groups`, `add-allowed-group`, `remove-allowed-group`, `list-smart-groups`, `add-smart-group`, `remove-smart-group`, `enable-group-whitelist`, `disable-group-whitelist`

---

## 10. Update: `hooks/post-install.js`

Add `typing/` directory creation alongside existing `media/` and `logs/`:

```javascript
fs.mkdirSync(path.join(DATA_DIR, 'typing'), { recursive: true });
console.log('  - typing/');
```

---

## 11. Rewrite: `hooks/post-upgrade.js`

Add migration from legacy `allowed_groups[]` + `smart_groups[]` to `groups` map.

### New migration (added after existing migrations)

```javascript
// Migration 8: Migrate legacy group arrays to unified groups map
if ((config.allowed_groups || config.smart_groups) && !config.groups) {
  config.groups = {};
  config.groupPolicy = config.group_whitelist?.enabled !== false ? 'allowlist' : 'open';

  for (const g of (config.allowed_groups || [])) {
    config.groups[String(g.chat_id)] = {
      name: g.name,
      mode: 'mention',
      allowFrom: ['*'],
      historyLimit: config.message?.context_messages || 10,
      added_at: g.added_at || new Date().toISOString()
    };
  }
  for (const g of (config.smart_groups || [])) {
    config.groups[String(g.chat_id)] = {
      name: g.name,
      mode: 'smart',
      allowFrom: ['*'],
      historyLimit: config.message?.context_messages || 10,
      added_at: g.added_at || new Date().toISOString()
    };
  }

  // Remove legacy fields
  delete config.allowed_groups;
  delete config.smart_groups;
  delete config.group_whitelist;

  migrated = true;
  migrations.push(`Migrated ${Object.keys(config.groups).length} groups to unified groups map`);
}

// Migration 9: Ensure groupPolicy exists
if (!config.groupPolicy) {
  config.groupPolicy = 'allowlist';
  migrated = true;
  migrations.push('Added groupPolicy (default: allowlist)');
}

// Migration 10: Ensure groups object exists
if (!config.groups) {
  config.groups = {};
  migrated = true;
  migrations.push('Added empty groups object');
}

// Migration 11: Ensure internal_port
if (!config.internal_port) {
  config.internal_port = 3460;
  migrated = true;
  migrations.push('Added internal_port (3460)');
}

// Migration 12: Create typing directory
const typingDir = path.join(DATA_DIR, 'typing');
if (!fs.existsSync(typingDir)) {
  fs.mkdirSync(typingDir, { recursive: true });
  migrations.push('Created typing/ directory');
}
```

---

## 12. Update: `package.json`

```json
{
  "version": "0.2.0"
}
```

No new dependencies needed. All features use:
- `telegraf` (existing) — bot framework
- `https-proxy-agent` (existing) — proxy support
- `dotenv` (existing) — env loading
- `http` (Node built-in) — internal server
- `fs` (Node built-in) — file operations
- `crypto` (Node built-in) — token hashing
- `fetch` (Node 20+ built-in) — record-outgoing HTTP call

---

## 13. Update: `ecosystem.config.cjs`

No changes needed. The PM2 config already points `cwd` to the skill directory
and `script` to `src/bot.js`.

---

## 14. Implementation Sequence

Recommended order (based on dependency chain):

```
Step 1: src/lib/utils.js (NEW)
  - parseEndpoint, getHistoryKey, escapeXml, deepMergeDefaults
  - No dependencies on other project files

Step 2: src/lib/config.js (MODIFY)
  - Import deepMergeDefaults from utils.js
  - Update DEFAULT_CONFIG
  - Update loadConfig() to use deepMergeDefaults

Step 3: src/lib/user-cache.js (NEW)
  - Depends on: config.js (DATA_DIR)

Step 4: src/lib/context.js (REWRITE)
  - Depends on: config.js, utils.js (getHistoryKey, escapeXml)

Step 5: src/lib/auth.js (REWRITE)
  - Depends on: config.js (saveConfig)

Step 6: scripts/send.js (REWRITE)
  - Depends on: utils.js (parseEndpoint), config.js (DATA_DIR)

Step 7: src/bot.js (REWRITE)
  - Depends on: ALL of the above

Step 8: src/admin.js (REWRITE)
  - Depends on: config.js, auth.js

Step 9: hooks/post-install.js (MODIFY)
  - Standalone

Step 10: hooks/post-upgrade.js (MODIFY)
  - Standalone

Step 11: package.json (MODIFY)
  - Version bump
```

---

## 15. Testing Checklist

### Unit-level verification
- [ ] `parseEndpoint('')` → `{ chatId: '' }`
- [ ] `parseEndpoint('123')` → `{ chatId: '123' }`
- [ ] `parseEndpoint('123|msg:456|req:123:789|thread:10')` → `{ chatId: '123', msg: '456', req: '123:789', thread: '10' }`
- [ ] `parseEndpoint('123|bad|msg:456')` → `{ chatId: '123', msg: '456' }` (bad segment skipped)
- [ ] `getHistoryKey('123', null)` → `'123'`
- [ ] `getHistoryKey('123', '456')` → `'123:456'`
- [ ] `escapeXml('<script>&"\'')` → `'&lt;script&gt;&amp;&quot;&apos;'`
- [ ] `deepMergeDefaults({a: {b: 1, c: 2}}, {a: {b: 3}})` → `{a: {b: 3, c: 2}}`

### Integration tests (manual, with running bot)
- [ ] DM: Send message → bot replies (typing indicator shown while processing)
- [ ] DM: Reply to specific message → `<replying-to>` tag in C4 content
- [ ] Group: @mention bot → reply threaded to trigger message
- [ ] Group: Non-mentioned message → logged but no response
- [ ] Group: Smart mode → all messages forwarded
- [ ] Group: Topic/forum thread → context isolated per topic
- [ ] Group: `allowFrom` restriction → unauthorized sender ignored
- [ ] Send long message (>4000 chars) → chunked correctly, code blocks preserved
- [ ] Rate limit (429) → automatic retry after `retry_after`
- [ ] Bot's own reply → recorded in history, visible in next context
- [ ] Cold restart → log replay populates history, context works immediately
- [ ] Config migration → `allowed_groups`/`smart_groups` → `groups` map
- [ ] Admin CLI: `add-group`, `remove-group`, `set-group-policy` all work
