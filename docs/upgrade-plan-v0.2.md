# zylos-telegram v0.2.0 Upgrade Plan

> Optimization upgrade plan for zylos-telegram, informed by two key references:
> 1. **zylos-lark v0.1.5** — battle-tested patterns already running in production
> 2. **OpenClaw's Telegram channel** — UX patterns to reference (not copy)
>
> Philosophy: **Simplicity first.** Every change must earn its complexity. We adopt
> proven zylos-lark patterns where they solve real problems, and reference OpenClaw
> for UX inspiration without importing its layered architecture.
>
> All changes ship together in **v0.2.0** as a single coordinated release.

## Current State (v0.1.1)

| Area | Implementation | Limitation |
|------|---------------|------------|
| Context | File-based (`logs/{chatId}.log`), reads entire file on every @mention | O(n) disk I/O per message; no sliding window |
| User names | Raw `ctx.from.username \|\| ctx.from.first_name` | No caching; no persistence across restarts |
| Processing feedback | None | User gets no indication bot is working |
| Group policy | `allowed_groups[]` + `smart_groups[]` flat arrays | No per-group config (history limit, sender allowlist, mode) |
| Message format | Plain text with `[Group context - ...]` prefix | No structured tags; Claude can't distinguish context types |
| Reply-to context | Not implemented | Quoted replies lose parent message content |
| Bot's own messages | Not tracked | Context only includes other users' messages |
| Message chunking | Line-break split at 4000 chars | Doesn't preserve code blocks; no rate limit handling |
| Send script | Fire-and-forget, no reply-to support | Can't reply to specific messages in groups |
| Mention detection | `string.includes('@botname')` | Fragile; misses partial matches, doesn't use Telegram entities |
| Topic threads | Not handled | Messages in forum topics treated as flat group messages |

---

## Endpoint Format Specification

All changes in this plan share a unified endpoint string format for C4 routing.

**Format:** `chatId[|key:value]*`

```
chatId|msg:12345|req:abc123|thread:456
```

**Fields:**

| Key | Required | Description |
|-----|----------|-------------|
| (bare) | Yes | Telegram chat ID (first segment, before any `\|`) |
| `msg` | No | Trigger message ID (for reply-to in send.js) |
| `req` | No | Request correlation ID (for typing indicator cleanup) |
| `thread` | No | Topic thread ID (for forum thread isolation) |

**Parser:** Order-insensitive key-value extraction. Unknown keys are ignored
(forward-compatible). First occurrence wins for duplicate keys. Malformed segments
(no `:` separator, empty key, or empty value) are silently skipped.

```javascript
function parseEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'string') return { chatId: '' };
  const parts = endpoint.split('|');
  const result = { chatId: parts[0] };
  for (let i = 1; i < parts.length; i++) {
    const sep = parts[i].indexOf(':');
    if (sep > 0 && sep < parts[i].length - 1) {
      const key = parts[i].slice(0, sep);
      if (!(key in result)) {  // First occurrence wins
        result[key] = parts[i].slice(sep + 1);
      }
    }
  }
  return result;
}
```

**Backward compatibility:** Plain `chatId` (no `|`) continues to work — all extra
fields default to `undefined`.

---

## Changes

### 1. In-Memory Chat History with Log-File Replay

**What:** Replace file-read-per-@mention with `Map<chatId, messages[]>` in memory.

**Why:** Current `getGroupContext()` reads the entire log file, parses every JSON line,
and scans for the cursor position on every @mention. With active groups this becomes
a performance bottleneck. zylos-lark solved this cleanly.

**Design (from zylos-lark):**

```
chatHistories: Map<historyKey, Array<{timestamp, message_id, user_id, user_name, text}>>
```

Where `historyKey` is produced by the shared `getHistoryKey()` utility (see
Implementation Sequence). This function is used consistently across all sections:

```javascript
function getHistoryKey(chatId, threadId) {
  return threadId ? `${chatId}:${threadId}` : String(chatId);
}
```

- **Record on receive:** Every message (DM, group, smart group) gets appended to the
  in-memory array via `recordHistoryEntry(historyKey, entry)`.
- **Bounded size:** When `history.length > limit * 2`, trim to last `limit` entries.
  Default limit: `config.message.context_messages` (10).
- **Deduplication:** Skip if `message_id` already exists in the array **and** is not
  `null`. Bot outgoing entries have `message_id: null` (or a synthetic ID like
  `bot:{timestamp}`) and must never be deduped against each other.

```javascript
function recordHistoryEntry(historyKey, entry) {
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
```

- **Log file schema update:** Add `thread_id` field to log entries so cold-start
  replay can reconstruct per-topic histories:

```javascript
const logEntry = {
  timestamp: new Date().toISOString(),
  message_id: messageId,
  user_id: userId,
  user_name: username,
  text: text,
  thread_id: threadId || null  // NEW: required for topic-aware replay
};
```

- **Cold-start replay from log files:** On first context request for a history key
  after restart, read the tail of `logs/{chatId}.log` (last `limit * 3` lines to
  account for thread distribution) and route each entry to
  `getHistoryKey(chatId, entry.thread_id)`. Track loaded chats in a
  `_replayedChats: Set<chatId>` to avoid repeat file reads.
  **Note:** `getUpdates` is NOT used — it conflicts with Telegraf's long-polling mode
  and may return stale data. Log file replay is reliable since we already persist every
  message to disk.
- **File logging preserved:** Continue appending to `logs/{chatId}.log` for audit
  trail, but never read it in the hot path (only on cold-start replay).
- **Cursor elimination:** Replace file-based cursor tracking with simple array slicing
  from the in-memory history. The cursor concept (last-responded message_id) can be
  kept in memory as `lastResponseId: Map<historyKey, messageId>`.

**Files affected:** `src/lib/context.js` (rewrite), `src/bot.js` (wire up recording)

**Complexity:** Medium

---

### 2. Typing Indicator with Request-Scoped Correlation

**What:** Show "Bot is typing..." feedback when a message is being handled.

**Why:** Users currently send a message and see nothing until the reply arrives (which
can take seconds to minutes). This is the most noticeable UX gap.

**Design:**

Telegram natively supports `sendChatAction("typing")` which shows "Bot is typing..."
in the chat UI. This is simpler than zylos-lark's emoji reaction approach (which was
necessary because Lark lacks a typing indicator API).

**Request correlation:** Each typing indicator is scoped to a specific request using
a correlation ID (`req`), preventing race conditions when multiple messages arrive
in the same chat concurrently.

```javascript
// Correlation ID format: chatId:messageId (unique per request)
const correlationId = `${chatId}:${messageId}`;

// On message received, before sendToC4():
const typingInterval = setInterval(() => {
  bot.telegram.sendChatAction(chatId, 'typing').catch(() => {});
}, 5000);
bot.telegram.sendChatAction(chatId, 'typing').catch(() => {});  // Immediate first

// Store with correlation key
activeTypingIndicators.set(correlationId, {
  interval: typingInterval,
  startedAt: Date.now()
});

// Embed correlation ID in endpoint: chatId|msg:123|req:chatId:messageId
```

**Cleanup (three mechanisms):**

1. **`fs.watch()` on typing directory:** `send.js` writes
   `typing/{correlationId}.done` marker file after first chunk sent. `bot.js` watches
   the directory with `fs.watch()` (event-driven, no polling overhead) and clears the
   matching interval immediately.

2. **Auto-timeout:** 120s safety net. `bot.js` periodically (every 30s) sweeps
   `activeTypingIndicators` and clears entries older than 120s.

3. **Stale marker cleanup:** On startup, delete any leftover `.done` files in
   `typing/`.

**Why `fs.watch()` + fallback poll (belt and suspenders):** `fs.watch()` is
event-driven with near-zero latency and no CPU cost. However, Linux inotify can
drop events under high concurrency. To guard against this, combine `fs.watch()`
with a 30s fallback poll that sweeps the `typing/` directory for any `.done`
markers that `fs.watch` may have missed. This ensures no typing indicator is ever
orphaned beyond 30s, even if `fs.watch` fails silently.

**Files affected:** `src/bot.js` (typing start/stop/watch), `scripts/send.js` (write
marker file), new `typing/` directory in data dir

**Complexity:** Medium

---

### 3. Structured Message Format (XML Tags)

**What:** Replace plain-text context format with XML-tagged structure.

**Why:** Claude can parse structured formats more reliably than free-text conventions.
zylos-lark's `<group-context>`, `<replying-to>`, `<current-message>` tags let Claude
distinguish between context, quoted content, and the actual message. This directly
improves response quality.

**Current format:**
```
[TG GROUP:dev-team] alice said: [Group context - recent messages before this @mention:]
[bob]: hello
[charlie]: what's up

[Current message:] what do you think?
```

**Proposed format:**
```
[TG GROUP:dev-team] alice said: <group-context>
[bob]: hello
[charlie]: what&apos;s up
</group-context>

<replying-to>
[bob]: the original message being replied to
</replying-to>

<current-message>
what do you think?
</current-message>
```

**XML Escaping Rules:**

User-generated content inside XML tags MUST be escaped to prevent tag injection:

| Character | Escape |
|-----------|--------|
| `<` | `&lt;` |
| `>` | `&gt;` |
| `&` | `&amp;` |
| `'` | `&apos;` |
| `"` | `&quot;` |

```javascript
function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;');
}
```

**Application:** `escapeXml()` is applied to user message text and usernames inside
all XML tags. Tag names and structural markup are NOT escaped (they are controlled by
our code, not user input).

**Thread-related tags (for topic support):**
- `<thread-context>` — messages in the topic thread
- `<thread-root>` — the root message that started the topic

**Files affected:** `src/lib/context.js` (`formatContextPrefix` → unified
`formatMessage`), `src/bot.js` (message formatting)

**Complexity:** Low

---

### 4. Reply-To Context (Incoming)

**What:** When a user replies to a specific message, include the quoted message content.

**Why:** Telegram's reply-to is heavily used. Currently the bot ignores
`ctx.message.reply_to_message` entirely, losing critical context about what the user
is responding to.

**Design:**

```javascript
// In bot.on('text') handler:
let quotedContent = null;
if (ctx.message.reply_to_message) {
  const reply = ctx.message.reply_to_message;
  quotedContent = {
    sender: reply.from?.username || reply.from?.first_name || 'unknown',
    text: reply.text || reply.caption || '[media]'
  };
}
// Pass to formatMessage() for <replying-to> tag wrapping
```

No API call needed — Telegram delivers `reply_to_message` in the update payload.

**Files affected:** `src/bot.js` (extract reply context), message formatting

**Complexity:** Low

---

### 5. Reply-To in send.js (Outgoing Group Replies)

**What:** When Claude responds to a group @mention, reply to the triggering message
instead of sending a standalone message.

**Why:** In group chats, a standalone message from the bot has no visual connection to
the question that triggered it. Telegram's reply-to creates a clear visual thread.
High UX impact, low implementation cost.

**Design:**

`bot.js` embeds `msg:messageId` in the C4 endpoint string. `send.js` parses the
endpoint and uses `reply_to_message_id` in the Telegram API call:

```javascript
const { chatId, msg } = parseEndpoint(endpoint);

// First chunk replies to trigger message; subsequent chunks send standalone
const params = { chat_id: chatId, text: chunk };
if (isFirstChunk && msg) {
  params.reply_to_message_id = parseInt(msg, 10);
}
await apiRequest('sendMessage', params);
```

**Fallback:** If `reply_to_message_id` fails (message deleted, too old), retry without
it. Telegram returns error 400 "Bad Request: message to reply not found" — catch and
resend.

**Files affected:** `src/bot.js` (build structured endpoint), `scripts/send.js`
(parse endpoint, add reply_to_message_id)

**Complexity:** Low

---

### 6. Bot Outgoing Message Recording

**What:** Record the bot's own replies in the in-memory chat history.

**Why:** Without this, group context only contains other users' messages. When a user
follows up on the bot's previous reply, the bot has no memory of what it said.

**Design:** Internal HTTP endpoint using Node's built-in `http` module (no Express).

```javascript
// In bot.js: add lightweight localhost HTTP server
import http from 'http';

const INTERNAL_PORT = 3460;  // Configurable via config.internal_port
const MAX_BODY_SIZE = 64 * 1024;  // 64KB body limit

const internalServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/internal/record-outgoing') {
    // Validate X-Internal-Token header (hash of bot token)
    const token = req.headers['x-internal-token'];
    if (token !== expectedToken) {
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
        message_id: `bot:${Date.now()}`,  // Synthetic ID to avoid null dedup issues
        user_id: 'bot',
        user_name: bot.botInfo?.username || 'bot',
        text: text.substring(0, 500)  // Truncate to avoid bloating history
      });
      res.writeHead(200).end('ok');
    });
  } else {
    res.writeHead(404).end();
  }
});
internalServer.listen(INTERNAL_PORT, '127.0.0.1');
```

**Security hardening:**
- Body-size limit (64KB) to prevent memory abuse
- `JSON.parse` wrapped in try/catch with 400 response
- Input validation (chatId and text required)
- `X-Internal-Token` validation (hash of bot token, same pattern as zylos-lark)

`send.js` POSTs to this endpoint after each successful send. Non-200 responses are
logged but do not block the send (recording is best-effort).

**Files affected:** `src/bot.js` (add internal HTTP server), `scripts/send.js` (add
POST after successful send)

**Complexity:** Medium

---

### 7. Mention Detection via Telegram Entities API

**What:** Replace `string.includes('@botname')` with Telegram's `entities` array.

**Why:** Current detection is fragile:
- `@botname` in a code block or quoted text triggers the bot
- Partial matches possible (e.g., `@botname_test` matches `@botname`)
- Case sensitivity issues

Telegram provides a parsed `entities` array in every message with exact mention
positions and types.

**Design:**

```javascript
function isBotMentioned(ctx) {
  // Check both entities (text messages) and caption_entities (media with captions)
  const entities = ctx.message.entities || ctx.message.caption_entities || [];
  const text = ctx.message.text || ctx.message.caption || '';
  const botUsername = bot.botInfo?.username?.toLowerCase();
  if (!botUsername) return false;

  return entities.some(e => {
    if (e.type === 'mention') {
      // @username mention — extract from text/caption
      const mentioned = text.slice(e.offset + 1, e.offset + e.length);
      return mentioned.toLowerCase() === botUsername;
    }
    // Also handle text_mention (for users without username who mention via search)
    return false;
  });
}

function stripBotMention(ctx) {
  // Remove bot @mention from text using entity offsets (precise, not regex)
  let text = ctx.message.text;
  const entities = (ctx.message.entities || [])
    .filter(e => e.type === 'mention')
    .sort((a, b) => b.offset - a.offset);  // Reverse order to preserve offsets

  for (const e of entities) {
    const mentioned = text.slice(e.offset + 1, e.offset + e.length);
    if (mentioned.toLowerCase() === bot.botInfo?.username?.toLowerCase()) {
      text = text.slice(0, e.offset) + text.slice(e.offset + e.length);
    }
  }
  return text.trim();
}
```

**Files affected:** `src/bot.js` (replace `includes()` checks with entity-based
detection)

**Complexity:** Low

---

### 8. Enhanced Group Policy Model

**What:** Upgrade from flat `allowed_groups[]` / `smart_groups[]` arrays to a unified
per-group config map with modes, sender allowlists, and per-group history limits.

**Why:** The current model has no way to:
- Set different context window sizes per group
- Restrict which users can trigger the bot in a group
- Configure group behavior without moving between two separate arrays

**Proposed config schema:**

```json
{
  "groupPolicy": "allowlist",
  "groups": {
    "-100123456789": {
      "name": "dev-team",
      "mode": "mention",
      "allowFrom": ["*"],
      "historyLimit": 15,
      "added_at": "2026-02-19T00:00:00Z"
    },
    "-100987654321": {
      "name": "alerts",
      "mode": "smart",
      "allowFrom": ["alice_id", "bob_id"],
      "historyLimit": 5,
      "added_at": "2026-02-19T00:00:00Z"
    }
  }
}
```

**Three global policies (from zylos-lark):**
- `disabled` — ignore all groups
- `allowlist` — only configured groups (default, current behavior)
- `open` — all groups allowed

**Per-group fields:**
- `mode`: `"mention"` (respond to @mentions only) or `"smart"` (receive all)
- `allowFrom`: array of user_ids or `["*"]` for all. Default: `["*"]`
- `historyLimit`: per-group context window size. Default: global setting

**Migration path:**

`post-upgrade.js` auto-converts legacy arrays on upgrade:

```javascript
// Legacy: allowed_groups: [{chat_id, name}] + smart_groups: [{chat_id, name}]
// New:    groups: { chatId: {name, mode, ...} }
if (config.allowed_groups && !config.groups) {
  config.groups = {};
  for (const g of config.allowed_groups) {
    config.groups[String(g.chat_id)] = {
      name: g.name, mode: 'mention', allowFrom: ['*'],
      historyLimit: config.message?.context_messages || 10,
      added_at: g.added_at || new Date().toISOString()
    };
  }
  for (const g of (config.smart_groups || [])) {
    config.groups[String(g.chat_id)] = {
      name: g.name, mode: 'smart', allowFrom: ['*'],
      historyLimit: config.message?.context_messages || 10,
      added_at: g.added_at || new Date().toISOString()
    };
  }
  delete config.allowed_groups;
  delete config.smart_groups;
}
```

Legacy arrays are removed after migration (no dual-path code).

**Nested defaults normalization:** Current `config.js` does a shallow merge
(`{ ...DEFAULT_CONFIG, ...loaded }`), which means nested objects (e.g.,
`features`, `message`, `group_whitelist`) can lose default subfields if the
loaded config has only partial nested objects. Migration must apply deep merge
for nested fields:

```javascript
function deepMergeDefaults(defaults, loaded) {
  const result = { ...defaults, ...loaded };
  for (const key of Object.keys(defaults)) {
    if (defaults[key] && typeof defaults[key] === 'object' && !Array.isArray(defaults[key])) {
      result[key] = { ...defaults[key], ...(loaded[key] || {}) };
    }
  }
  return result;
}
```

This should also be applied in `config.js`'s `loadConfig()` to prevent the issue
going forward (not just during migration).

**Admin CLI updates:**
- `add-group <chat_id> <name> [mode]` — unified add command
- `set-group-policy <open|allowlist|disabled>`
- `set-group-allowfrom <chat_id> <user_ids...>`
- `set-group-history-limit <chat_id> <limit>`

**Files affected:** `src/lib/auth.js` (rewrite group checks), `src/lib/config.js`
(new schema), `src/admin.js` (new commands), `hooks/post-upgrade.js` (migration)

**Complexity:** Medium

---

### 9. Improved Message Chunking with Rate Limit Handling

**What:** Upgrade message splitting to preserve markdown code blocks, prefer semantic
break points, and handle Telegram 429 rate limits.

**Why:** Current `splitMessage()` splits on line breaks only, which can break markdown
code blocks (splitting in the middle of a ``` block). Also, chunked sends to the same
chat can trigger Telegram's rate limiter, returning HTTP 429 with `retry_after`.

**Chunking algorithm (from zylos-lark):**

1. Never split inside a code block (track ``` open/close state)
2. Prefer paragraph breaks (`\n\n`) over line breaks (`\n`)
3. Prefer line breaks over word boundaries
4. Ensure minimum 30% of max length before breaking (avoid tiny fragments)
5. Hard split as last resort

**429 rate limit handling:**

Current `apiRequest` uses `execSync(curl)` and throws plain `Error` on failure,
discarding the Telegram API error structure. The refactored version must preserve
the original API response to enable 429 detection:

```javascript
// Refactored apiRequest: preserve Telegram error structure
function apiRequest(method, params) {
  // ... curl execution ...
  const response = JSON.parse(result);
  if (response.ok) return response.result;
  // Attach original response to error for retry logic
  const err = new Error(response.description || 'API error');
  err.telegramResponse = response;  // { ok, error_code, description, parameters }
  throw err;
}

async function apiRequestWithRetry(method, params, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await apiRequest(method, params);
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

Inter-chunk delay increased from 300ms to 500ms to reduce 429 likelihood.

**Files affected:** `scripts/send.js` (`splitMessage` function, `apiRequest` wrapper)

**Complexity:** Low

---

### 10. Telegram Topic/Forum Thread Support

**What:** Handle Telegram topic threads (forum groups) with isolated context.

**Why:** Telegram Topics (forum mode) is a production feature already in use across
many supergroups. Each topic is an isolated conversation thread. Without support,
messages from different topics get mixed into a single group context, producing
confusing results for Claude.

**Design (from zylos-lark's thread isolation):**

- Detect `ctx.message.message_thread_id` (Telegram's topic thread ID)
- **Composite isolation key:** `chatId:threadId` — thread IDs are NOT globally unique,
  only unique within a chat. Using bare `threadId` as a history map key would cause
  collisions across different groups.

```javascript
function getHistoryKey(chatId, threadId) {
  return threadId ? `${chatId}:${threadId}` : String(chatId);
}

// In message handler:
const historyKey = getHistoryKey(chatId, ctx.message.message_thread_id);
recordHistoryEntry(historyKey, entry);  // Isolated per-topic history

// Context retrieval:
const context = getHistory(historyKey);  // Only messages from same topic
```

- Build endpoint with thread info: `chatId|msg:messageId|thread:threadId`
- `send.js` parses `thread:` and includes `message_thread_id` in Telegram API call
  to post the reply in the correct topic
- Format with `<thread-context>` and `<thread-root>` tags

**Files affected:** `src/bot.js` (thread detection), `src/lib/context.js` (composite
key history), `scripts/send.js` (parse thread, send to correct topic)

**Complexity:** Medium

---

### 11. User Name Caching

**What:** Cache Telegram user display names with in-memory TTL and file persistence.

**Why:** Telegram provides `from.username` / `from.first_name` in every update, so
this is lower priority than on Lark (which requires API calls). However, caching
still provides:
- Consistency across context messages (same user always shows same resolved name)
- Name persistence across restarts (cold-start replay has names ready)
- Foundation for future `getChatMember()` enrichment if needed

**Design (adapted from zylos-lark, simplified):**

```javascript
const userCache = new Map();  // userId -> { name, expireAt }
const USER_CACHE_TTL = 10 * 60 * 1000;  // 10 minutes
const CACHE_FILE = path.join(DATA_DIR, 'user-cache.json');

function resolveUserName(ctx) {
  const userId = String(ctx.from.id);
  const cached = userCache.get(userId);
  if (cached && cached.expireAt > Date.now()) return cached.name;

  const name = ctx.from.username || ctx.from.first_name || String(ctx.from.id);
  userCache.set(userId, { name, expireAt: Date.now() + USER_CACHE_TTL });
  markCacheDirty();
  return name;
}

// Persist to file every 5 minutes (batch write, not per-message)
// Load from file on startup for cold-start names
```

**Files affected:** New `src/lib/user-cache.js`, `src/bot.js` (use cached names)

**Complexity:** Low

---

## Implementation Sequence

All changes ship in v0.2.0. Recommended implementation order (based on dependencies):

```
1. Shared utilities (implement first, used everywhere):
   a. parseEndpoint() — endpoint format parser
   b. getHistoryKey() — composite history key (chatId:threadId)
   c. escapeXml() — XML content escaping
   d. deepMergeDefaults() — nested config defaults
2. In-memory chat history + log-file replay (core data structure, uses getHistoryKey)
3. Mention detection via entities API (fixes fragile detection, standalone)
4. Structured message format (XML tags, uses escapeXml)
5. Reply-to context (incoming, uses XML tags)
6. Reply-to in send.js (outgoing, uses parseEndpoint)
7. Typing indicator with correlation ID (uses parseEndpoint)
8. Bot outgoing message recording (uses getHistoryKey + in-memory history)
9. Improved message chunking + rate limit handling (send.js, uses refactored apiRequest)
10. Enhanced group policy model + config migration (uses deepMergeDefaults)
11. Topic/forum thread support (uses getHistoryKey + parseEndpoint + log threadId)
12. User name caching (independent, lowest priority)
```

Steps 1-6 are the foundation; 7-12 build on them. No circular dependencies.
Shared utilities (step 1) are defined once in a new `src/lib/utils.js` module and
imported by all consumers, ensuring consistent behavior across sections.

## What We're NOT Doing

These OpenClaw patterns are explicitly out of scope to maintain simplicity:

- **7-layer fallback routing** — Over-engineered for our use case. We route by chat_id.
- **Multi-account support** — We run one bot per agent instance.
- **grammY migration** — Telegraf works fine and the team knows it. No framework churn.
- **Silent failure modes** — We prefer explicit error logging over silent degradation.
- **Gateway architecture** — Our direct bot-to-C4 pipeline is simple and effective.

## Migration & Compatibility

- **Config migration:** `post-upgrade.js` auto-migrates legacy `allowed_groups[]` and
  `smart_groups[]` to the `groups` map. Legacy arrays are removed after migration.
- **Log file format:** Additive backward-compatible schema change: `thread_id` field
  added to log entries. Existing entries without `thread_id` are treated as non-topic
  messages during replay. Log files remain the source of truth for cold-start replay.
- **C4 endpoint format:** Backward compatible. Plain `chatId` (no `|`) continues to
  work; `chatId|msg:xxx|req:yyy|thread:zzz` is an additive extension with
  order-insensitive parsing.
- **Version bump:** v0.1.1 → v0.2.0 (minor version for new features, no breaking
  changes to external interfaces).
