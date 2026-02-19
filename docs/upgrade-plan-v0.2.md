# zylos-telegram v0.2 Upgrade Plan

> Optimization upgrade plan for zylos-telegram, informed by two key references:
> 1. **zylos-lark v0.1.5** — battle-tested patterns already running in production
> 2. **OpenClaw's Telegram channel** — UX patterns to reference (not copy)
>
> Philosophy: **Simplicity first.** Every change must earn its complexity. We adopt
> proven zylos-lark patterns where they solve real problems, and reference OpenClaw
> for UX inspiration without importing its layered architecture.

## Current State (v0.1.1)

| Area | Implementation | Limitation |
|------|---------------|------------|
| Context | File-based (`logs/{chatId}.log`), reads entire file on every @mention | O(n) disk I/O per message; no sliding window |
| User names | Raw `ctx.from.username \|\| ctx.from.first_name` | No caching; no Telegram API lookup for missing names |
| Processing feedback | None | User gets no indication bot is working |
| Group policy | `allowed_groups[]` + `smart_groups[]` flat arrays | No per-group config (history limit, sender allowlist, mode) |
| Message format | Plain text with `[Group context - ...]` prefix | No structured tags; Claude can't distinguish context types |
| Reply-to context | Not implemented | Quoted replies lose parent message content |
| Bot's own messages | Not tracked | Context only includes other users' messages |
| Message chunking | Line-break split at 4000 chars | Doesn't preserve code blocks or markdown structure |
| Send script | Fire-and-forget, no reply-to support | Can't reply to specific messages in groups |

## Proposed Changes

### P0 — In-Memory Chat History with Lazy-Load Fallback

**What:** Replace file-read-per-@mention with `Map<chatId, messages[]>` in memory.

**Why:** Current `getGroupContext()` reads the entire log file, parses every JSON line,
and scans for the cursor position on every @mention. With active groups this becomes
a performance bottleneck. zylos-lark solved this cleanly.

**Design (from zylos-lark):**

```
chatHistories: Map<chatId, Array<{timestamp, message_id, user_id, user_name, text}>>
```

- **Record on receive:** Every message (DM, group, smart group) gets appended to the
  in-memory array via `recordHistoryEntry()`.
- **Bounded size:** When `history.length > limit * 2`, trim to last `limit` entries.
  Default limit: `config.message.context_messages` (10).
- **Lazy-load on cold start:** First @mention after restart triggers a one-time
  Telegram `getUpdates` or cached log file read to seed the in-memory map. Track
  loaded chats in a `Set` to avoid repeat loads.
- **File logging preserved:** Continue appending to `logs/{chatId}.log` for audit
  trail, but never read it in the hot path.
- **Cursor elimination:** Replace file-based cursor tracking with simple array slicing
  from the in-memory history. The cursor concept (last-responded message_id) can be
  kept in memory as `lastResponseId: Map<chatId, messageId>`.

**Files affected:** `src/lib/context.js` (rewrite), `src/bot.js` (wire up recording)

**Complexity:** Medium — core data structure change, but well-proven in zylos-lark.

---

### P0 — Typing Indicator

**What:** Show "bot is processing" feedback when a message is being handled.

**Why:** Users currently send a message and see nothing until the reply arrives (which
can take seconds to minutes). This is the most noticeable UX gap. Both zylos-lark
and OpenClaw provide processing feedback.

**Design:**

Telegram natively supports `sendChatAction("typing")` which shows "Bot is typing..."
in the chat UI. This is simpler than zylos-lark's emoji reaction approach (which was
necessary because Lark lacks a typing indicator API).

```javascript
// On message received, before sendToC4():
bot.telegram.sendChatAction(chatId, 'typing');

// For long processing, repeat every 5s (Telegram typing expires after ~5s):
const typingInterval = setInterval(() => {
  bot.telegram.sendChatAction(chatId, 'typing').catch(() => {});
}, 5000);

// On reply sent (in send.js), clear the interval via marker file or IPC
```

**Sync between bot.js and send.js:** Use zylos-lark's file-marker pattern:
- `bot.js` starts typing indicator, stores interval in `activeTypingIndicators` Map
- `send.js` writes `typing/{chatId}.done` marker file after first chunk sent
- `bot.js` polls every 2s, clears interval when marker appears
- Auto-timeout after 120s to prevent orphaned typing indicators

**Files affected:** `src/bot.js` (add typing start/stop), `scripts/send.js` (add
marker file write), new `typing/` directory in data dir

**Complexity:** Low-Medium — Telegram's native typing API is simpler than Lark's
emoji reaction approach, but the cross-process sync adds some complexity.

---

### P1 — Structured Message Format (XML Tags)

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
[charlie]: what's up
</group-context>

<replying-to>
[bob]: the original message being replied to
</replying-to>

<current-message>
what do you think?
</current-message>
```

**Additional tags for future thread support:**
- `<thread-context>` / `<thread-root>` — when Telegram adds topic threads

**Files affected:** `src/lib/context.js` (`formatContextPrefix` → `formatMessage`
integration), `src/bot.js` (message formatting)

**Complexity:** Low — string formatting change, no architectural impact.

---

### P1 — Reply-To Context

**What:** When a user replies to a specific message, include the quoted message content.

**Why:** Telegram's reply-to is heavily used. Currently the bot ignores
`ctx.message.reply_to_message` entirely, losing critical context about what the user
is responding to. zylos-lark's `<replying-to>` tag pattern handles this well.

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

**Complexity:** Low — data is already in the Telegraf context object.

---

### P1 — Bot Outgoing Message Recording

**What:** Record the bot's own replies in the in-memory chat history.

**Why:** Without this, group context only contains other users' messages. When a user
follows up on the bot's previous reply, the bot has no memory of what it said. zylos-lark
solves this with an internal HTTP endpoint that `send.js` calls after sending.

**Design:**

Option A (zylos-lark pattern): `send.js` POSTs to `bot.js` via localhost HTTP endpoint.
Option B (simpler): `send.js` writes bot response to the same `logs/{chatId}.log` file
and the in-memory history picks it up on next lazy-load.

**Recommended: Option A** — internal HTTP endpoint on `bot.js` (e.g., `/internal/record-outgoing`).
This keeps the in-memory history immediately up-to-date without waiting for a lazy-load cycle.

```javascript
// In bot.js: add express/http server (lightweight, only localhost)
// POST /internal/record-outgoing { chatId, text }
// Validates via X-Internal-Token header (bot token hash)
// Calls recordHistoryEntry() to update in-memory map
```

**Files affected:** `src/bot.js` (add internal HTTP server), `scripts/send.js` (add
POST after successful send)

**Complexity:** Medium — introduces an HTTP server in bot.js, but it's a proven pattern
from zylos-lark and the Telegraf bot doesn't currently use one.

---

### P2 — Enhanced Group Policy Model

**What:** Upgrade from flat `allowed_groups[]` / `smart_groups[]` arrays to a unified
per-group config map with modes, sender allowlists, and per-group history limits.

**Why:** The current model has no way to:
- Set different context window sizes per group
- Restrict which users can trigger the bot in a group
- Configure group behavior without moving between two separate arrays

zylos-lark's unified model is cleaner and more powerful.

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

**Migration:** `post-upgrade.js` converts legacy arrays to the new map format.
Legacy arrays kept as fallback for one version cycle.

**Admin CLI updates:**
- `add-group <chat_id> <name> [mode]` — unified add command
- `set-group-policy <open|allowlist|disabled>`
- `set-group-allowfrom <chat_id> <user_ids...>`
- `set-group-history-limit <chat_id> <limit>`
- `migrate-groups` — manual migration trigger

**Files affected:** `src/lib/auth.js` (rewrite group checks), `src/lib/config.js`
(new schema), `src/admin.js` (new commands), `hooks/post-upgrade.js` (migration)

**Complexity:** Medium — schema change with migration, but improves long-term
maintainability.

---

### P2 — User Name Caching

**What:** Cache Telegram user display names with in-memory TTL and file persistence.

**Why:** Currently uses raw `ctx.from.username || ctx.from.first_name` on every message.
This works for most cases, but:
- Some users have no username (only first_name which may be generic)
- Group context shows user_id if name wasn't captured at message time
- No persistence across restarts

**Design (adapted from zylos-lark):**

```javascript
const userCache = new Map();  // userId -> { name, expireAt }
const USER_CACHE_TTL = 10 * 60 * 1000;  // 10 minutes
const CACHE_FILE = path.join(DATA_DIR, 'user-cache.json');

function resolveUserName(ctx) {
  const userId = String(ctx.from.id);
  const cached = userCache.get(userId);
  if (cached && cached.expireAt > Date.now()) return cached.name;

  // Resolve from context (Telegram provides this in every update)
  const name = ctx.from.username || ctx.from.first_name || String(ctx.from.id);
  userCache.set(userId, { name, expireAt: Date.now() + USER_CACHE_TTL });
  markCacheDirty();
  return name;
}

// Persist to file every 5 minutes (batch write, not per-message)
// Load from file on startup for cold-start names
```

**Note:** Unlike zylos-lark which needs API calls to resolve Lark user IDs, Telegram
always provides `from.username` / `from.first_name` in the update. So the cache is
mainly for:
1. Consistency across context messages (same user always shows same name)
2. Persistence across restarts
3. Future: `getChatMember()` API call for richer profiles if needed

**Files affected:** New `src/lib/user-cache.js`, `src/bot.js` (use cached names)

**Complexity:** Low — simpler than zylos-lark's version since Telegram provides names
in every update.

---

### P2 — Improved Message Chunking in send.js

**What:** Upgrade message splitting to preserve markdown code blocks and prefer
semantic break points.

**Why:** Current `splitMessage()` splits on line breaks only, which can break
markdown code blocks (splitting in the middle of a ``` block). zylos-lark's chunking
logic handles this correctly.

**Design (from zylos-lark):**

1. Never split inside a code block (track ``` open/close state)
2. Prefer paragraph breaks (`\n\n`) over line breaks (`\n`)
3. Prefer line breaks over word boundaries
4. Ensure minimum 30% of max length before breaking (avoid tiny fragments)
5. Hard split as last resort

**Files affected:** `scripts/send.js` (`splitMessage` function)

**Complexity:** Low — isolated function replacement with better algorithm.

---

### P3 — Reply-To in send.js (Group Replies)

**What:** When Claude responds to a group @mention, reply to the triggering message
instead of sending a standalone message.

**Why:** In group chats, a standalone message from the bot has no visual connection to
the question that triggered it. Telegram's reply-to creates a clear visual thread.
OpenClaw uses this extensively for UX clarity.

**Design:**

The C4 endpoint string needs to carry the trigger message_id:

```
# Current endpoint:
"telegram" "-100123456789"

# Proposed endpoint (from zylos-lark pattern):
"telegram" "-100123456789|msg:12345"
```

`send.js` parses the endpoint, extracts `msg:`, and uses `reply_to_message_id` in the
Telegram API call:

```javascript
await apiRequest('sendMessage', {
  chat_id: chatId,
  text: text,
  reply_to_message_id: messageId  // Reply to trigger message
});
```

**Files affected:** `src/bot.js` (build structured endpoint), `scripts/send.js`
(parse endpoint, add reply_to_message_id)

**Complexity:** Low — Telegram API natively supports `reply_to_message_id`.

---

### P3 — Telegram Topic/Forum Thread Support

**What:** Handle Telegram topic threads (forum groups) with isolated context.

**Why:** Telegram supergroups can enable "Topics" (forum mode), where each topic is
an isolated thread. Currently these messages are treated as regular group messages
with no thread isolation. This is a forward-looking feature since topic adoption is
growing.

**Design (from zylos-lark's thread isolation):**

- Detect `ctx.message.message_thread_id` (Telegram's topic thread ID)
- Store topic messages in separate history: `chatHistories[threadId]`
- Build endpoint with thread info: `chatId|thread:threadId|msg:messageId`
- Format with `<thread-context>` tags when in a topic

**Files affected:** `src/bot.js` (thread detection), `src/lib/context.js` (thread
history isolation), `scripts/send.js` (parse thread from endpoint)

**Complexity:** Medium — requires understanding Telegram's forum/topic API nuances.
Defer until topic threads are actively used.

---

## Implementation Order

```
Phase 1 (v0.2.0) — Core Performance & UX
  ├── P0: In-memory chat history
  ├── P0: Typing indicator
  ├── P1: Structured message format (XML tags)
  └── P1: Reply-to context

Phase 2 (v0.2.x) — Intelligence & Configuration
  ├── P1: Bot outgoing message recording
  ├── P2: Enhanced group policy model
  ├── P2: User name caching
  └── P2: Improved message chunking

Phase 3 (v0.3.0) — Advanced Features
  ├── P3: Reply-to in send.js (group replies)
  └── P3: Topic/forum thread support
```

## What We're NOT Doing

These OpenClaw patterns are explicitly out of scope to maintain simplicity:

- **7-layer fallback routing** — Over-engineered for our use case. We route by chat_id.
- **Multi-account support** — We run one bot per agent instance.
- **grammY migration** — Telegraf works fine and the team knows it. No framework churn.
- **Rate limiting / backoff middleware** — Telegram's API is generous; handle errors
  when they happen rather than preemptively throttling.
- **Silent failure modes** — We prefer explicit error logging over silent degradation.
- **Gateway architecture** — Our direct bot-to-C4 pipeline is simple and effective.

## Migration & Compatibility

- **Config migration:** `post-upgrade.js` handles schema changes. Legacy `allowed_groups[]`
  and `smart_groups[]` arrays are auto-migrated to the `groups` map on first upgrade.
- **Log file format:** No change to `logs/{chatId}.log` format. In-memory history
  is an optimization layer, not a replacement.
- **C4 endpoint format:** Backward compatible. Plain `chatId` continues to work;
  `chatId|msg:xxx` is an additive extension.
- **Version bump:** v0.1.1 → v0.2.0 (minor version for new features, no breaking changes).
