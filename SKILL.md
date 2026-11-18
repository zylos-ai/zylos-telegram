---
name: telegram
version: 0.8.0
description: >-
  Telegram Bot communication channel (long polling mode, works behind firewalls).
  Use when: (1) replying to Telegram messages (DM or group @mentions),
  (2) sending proactive messages or media (images, files) to Telegram users or groups,
  (3) managing DM access control (dmPolicy: open/allowlist/owner, dmAllowFrom list),
  (4) managing group access control (groupPolicy, per-group allowFrom, smart/mention modes),
  (5) configuring the bot (admin CLI, proxy settings),
  (6) troubleshooting Telegram bot connection or polling issues.
  IMPORTANT: Before sending media or using any command, read this SKILL.md first
  if you have not loaded the exact syntax in the current session. Do not guess
  command flags.
  Config at ~/zylos/components/telegram/config.json. Service: pm2 zylos-telegram.
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-telegram
    entry: src/bot.js
  data_dir: ~/zylos/components/telegram
  hooks:
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - .env
    - data/

upgrade:
  repo: zylos-ai/zylos-telegram
  branch: main

config:
  required:
    - name: TELEGRAM_BOT_TOKEN
      description: Telegram Bot Token (从 @BotFather 获取)
      sensitive: true

dependencies:
  - comm-bridge
  - voice-asr
---

# Telegram Bot

Telegram messaging component for Zylos Agent.

Depends on: comm-bridge (C4 message routing).

## Sending Messages

Via C4 Bridge (always use stdin form):
```bash
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "telegram" "<chat_id>"
message
EOF
```

Or directly (for testing):
```bash
node ~/zylos/.claude/skills/telegram/scripts/send.js <chat_id> "message"
```

## Media Messages

```bash
# Send image
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "telegram" "<chat_id>"
[MEDIA:image]/path/to/photo.jpg
EOF

# Send file
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "telegram" "<chat_id>"
[MEDIA:file]/path/to/document.pdf
EOF
```

## Downloading Media by file_id

In smart group mode, photos and files sent without @mention are logged with
metadata only (file_id). Use `download.js` to fetch them on demand:

```bash
# Download a photo or file by its file_id
node ~/zylos/.claude/skills/telegram/scripts/download.js <file_id> [filename_hint]

# Examples:
node ~/zylos/.claude/skills/telegram/scripts/download.js AgACAgIAAxkBAAI... photo
node ~/zylos/.claude/skills/telegram/scripts/download.js BQACAgIAAxkBAAI... report
```

The file_id comes from context messages like `[photo, file_id: xxx, msg_id: xxx]`.
Telegram file_ids are permanent — they can be downloaded at any time.

Output: local file path on success, error message on failure.

## Session Groups (multi-session Core)

With a zylos-core that supports multi-session, each inbound message carries a
session group, so every DM, group and forum topic gets its own conversation
thread. Replies still go through the same `reply via` path; nothing changes on
the sending side.

| Conversation | Session group | Example |
|---|---|---|
| Private chat | `dm-<chat id>` | `dm-8101553026` |
| Group / supergroup | `group<chat id>` (chat id keeps its minus sign) | `group-1001234567890` |
| Forum topic | `group<chat id>:topic-<topic id>` | `group-1001234567890:topic-42` |

- Only messages Telegram marks as forum-topic messages are split by topic. Reply
  chains in ordinary groups and the forum "General" area stay in the group.
- When a basic group is upgraded to a supergroup its chat id changes, so it
  continues in a new session group (not merged).
- The group is passed only if the installed Core lists `--session-group` in
  `c4-receive-options.json`; older Cores behave exactly as before.
- If Core rejects a message, Core's raw text goes only to the component log. The
  user gets "please try again later" when Core says nothing was stored, and
  "this message may not have reached me; resend if there is no reply in a few
  minutes" when Core cannot say (or c4-receive fails twice). A rejected group is
  never dropped and resent to the overall group. If Core reports the message as
  already stored, the component sends nothing, does not resend, and clears the
  typing indicator and reaction.

Look up the group for a reply endpoint (prints the in-group name; exits 1 on an
invalid endpoint):

```bash
node ~/zylos/.claude/skills/telegram/scripts/session-group.js "<endpoint>"
```

## Config Location

- Config: `~/zylos/components/telegram/config.json`
- Media: `~/zylos/components/telegram/media/`
- Logs: `~/zylos/components/telegram/logs/`

## Environment Variables

Required in `~/zylos/.env`:

```bash
# Telegram Bot Token (required, from @BotFather)
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...

# Proxy URL (optional, needed behind firewalls e.g. China mainland)
TELEGRAM_PROXY_URL=http://your-proxy-host:port
```

## Service Management

```bash
pm2 status zylos-telegram    # Check status
pm2 logs zylos-telegram      # View logs
pm2 restart zylos-telegram   # Restart service
```

## Owner

First user to interact with the bot becomes the owner (admin).
Owner bypasses allowlist checks only: the DM allowlist and per-group `allowFrom`.
For **text** messages, an owner `@mention` also bypasses the group allowlist /
configured-groups check (the bot responds even in an unconfigured group).
**Media and voice** (photo / document / voice) still require the group to be
configured or smart-enabled, even for the owner.
`groupPolicy: disabled` blocks all group messages, including from the owner.

## Access Control

DM and group access are controlled by independent policies:

**Private DM (dmPolicy):** `open` (anyone) | `allowlist` (dmAllowFrom list) | `owner` (owner only)

**Group (groupPolicy):** `open` (any group) | `allowlist` (configured groups only) | `disabled` (no groups)

These destination policies also apply to outbound text, images, files, and
reaction cleanup through `scripts/send.js`. Endpoints must use numeric chat IDs:
positive for DMs, negative for groups. `owner` permits only the bound owner;
`allowlist` permits the owner and numeric IDs in `dmAllowFrom` (including legacy
`whitelist.chat_ids`). Username-only entries cannot authorize a proactive outbound
numeric destination; add its verified numeric ID. Group allowlists use the `groups` map;
`allowFrom` controls inbound senders, not outbound destinations. A denied send
exits nonzero with the blocking policy before making any Telegram API request.

**Replies to accepted inbound messages:** preserve the full C4 reply endpoint.
If the normal destination policy denies a send, the component checks its own
message log for the original chat, message and thread. In an unlisted group the
logged sender must be the current owner; for a username-allowlisted DM the logged
sender must match the DM ID and remain allowed by the current policy. Only the
actual logged `username` is used, never the display name. Older logs without a
username cannot prove username-only DM access; ask for a new message or configure
the numeric DM ID. Owner DMs use normal policy and need no log proof.
`groupPolicy: disabled` still blocks all group replies. Missing logs deny the
exception. There is no expiry or token-dependent signature; queued endpoints can
still be used while their log proof and current access policy allow them.
These exceptional replies keep reply-to on every chunk and attachment. If the
original message cannot be replied to, sending fails instead of retrying without
reply-to. This never adds the destination to the allowlist. Group replies are
visible to all group members.

Per-group options: `mode` (mention/smart), `allowFrom` (restrict senders), `historyLimit`.

Policy values are case-sensitive. Hand-edited invalid values can still be accepted
by legacy inbound handling. Outbound checks reuse that behavior: the owner remains
allowed, and unknown policies use the DM/group allowlist. Correct the configuration
with `admin.js set-dm-policy <open|allowlist|owner>` or
`admin.js set-group-policy <open|allowlist|disabled>`; use lowercase values.

### Group join behavior (on bot invite)

The bot branches on who invited it:

- **Owner invited** → group is auto-configured with `allowFrom: [<ownerId>]`
  (owner-only — *not* the admin-CLI default `['*']`). The bot stays silent
  in the group on join; no in-group notice is posted. This gives the
  group a logged context immediately (so subsequent messages — including
  from members the owner has not yet authorized — are recorded in
  `logs/<chatId>.log` for later id resolution) while keeping access
  locked down until the owner explicitly authorizes more senders via
  `admin.js set-group-allowfrom`.

- **Non-owner invited** → group is **not** added. The bot stays silent in
  the group; the owner is DM'd the exact `admin.js add-group` command to
  authorize manually if desired.

Re-joining an already-configured group is a no-op (the existing
`config.groups[chatId]` entry stays valid).

## Admin CLI

Manage bot configuration via `admin.js`:

```bash
ADM="node ~/zylos/.claude/skills/telegram/src/admin.js"

# General
$ADM show                                    # Show full config
$ADM show-owner                              # Show current owner
$ADM help                                    # Show all commands

# DM Access Control
$ADM set-dm-policy <open|allowlist|owner>     # Set DM policy
$ADM list-dm-allow                            # Show DM policy + allowFrom list
$ADM add-dm-allow <chat_id_or_username>       # Add user to dmAllowFrom
$ADM remove-dm-allow <chat_id_or_username>    # Remove user from dmAllowFrom

# Group Management
$ADM list-groups                              # List all configured groups
$ADM add-group <chat_id> <name> [mode]        # Add group (mode: mention|smart)
$ADM remove-group <chat_id>                   # Remove a group
$ADM set-group-policy <disabled|allowlist|open>  # Set group policy
$ADM set-group-mode <chat_id> <mention|smart> # Set group mode
$ADM set-group-allowfrom <chat_id> <id1,id2>  # Set per-group allowed senders
$ADM set-group-history-limit <chat_id> <n>    # Set per-group context message limit

# Legacy aliases (backward-compatible, map to commands above)
# list-whitelist, add-whitelist, remove-whitelist → list-dm-allow, add-dm-allow, remove-dm-allow
```

After changes, restart: `pm2 restart zylos-telegram`

## Resolving @username to user_id from message logs

Telegram Bot API has no direct `@username → user_id` resolver for regular
users, and `config.groups.<chatId>.allowFrom` requires **numeric** user_ids
to match (the auth check is a strict `array.includes(senderId)`). Storing
`@username` literally in `allowFrom` will silently fail to match.

But the bot already logs every processed message per group as one JSON line
per row, with `user_id` (numeric) and `user_name` (the @username at the
time of the message) included. Because owner-invited groups land
**configured** (with `allowFrom: [<ownerId>]`), the text handler logs
every incoming message *before* the per-sender `allowFrom` rejection
fires — so a non-allowed member's `user_id` ends up in
`logs/<chatId>.log` the first time they @-mention the bot, even though
the bot replies with the no-permission notice. So when the owner says
*"allow @felix to access you in this group"*, the workflow is:

1. Pick the right log file by chat:

   ```
   ~/zylos/components/telegram/logs/<chatId>.log
   ```

   (Owner usually says this *inside* the group; `<chatId>` is the current
   chat. For DM allowlist, scan **all** log files.)

2. Grep for the target user_name:

   ```bash
   grep -E '"user_name":"felixl0707"' \
     ~/zylos/components/telegram/logs/-5298485474.log | head -1
   ```

   Extract `user_id` from the JSON (e.g., `8614077771`). The log captures
   the id even when the message didn't @-mention this bot — any message
   in an authorized group is logged.

3. Apply the change via admin.js, **including the owner's own id** so they
   don't lock themselves out:

   ```bash
   node ~/zylos/.claude/skills/telegram/src/admin.js \
     set-group-allowfrom <chatId> <target-id> <owner-id>
   ```

   `config.json` hot-reloads — no `pm2 restart` needed.

4. Confirm to the owner:
   - Which numeric id was resolved
   - The new `allowFrom` value
   - That all other group members are now blocked

If the target user has never sent any message in any of the bot's logged
chats, no log entry exists yet. In that case:
- Ask them to @-mention the bot once **in an owner-configured group**
  (any group the owner invited the bot into — those land configured
  owner-only, so non-allowed members can be logged on first interaction
  even though the bot rejects them at the per-sender check), OR
- Get the numeric chat_id from the owner directly.

`logs/<chatId>.log` is also the source of truth for in-group message
history; this section only describes how to use it for ID resolution.

## Forum Topic State

Use the component command to inspect known topics or close/reopen them:

```bash
node ~/zylos/.claude/skills/telegram/scripts/topics.js list --chat -1001234567890
node ~/zylos/.claude/skills/telegram/scripts/topics.js list --chat -1001234567890 --state open
node ~/zylos/.claude/skills/telegram/scripts/topics.js close --chat -1001234567890 --topic 42
node ~/zylos/.claude/skills/telegram/scripts/topics.js reopen --chat -1001234567890 --topic 42
```

Results are JSON. `list` returns `{ "topics": [...] }`; each topic has
`chat_id`, `topic_id`, `name`, `state`, `updated_at` (UTC ISO timestamp), and
`actor` (Telegram User or Chat, or null for an unknown seed actor). General uses
topic ID 1. A first rename event leaves state null; a close/reopen without a
known name leaves name null. Never treat missing or null state as open.

The component records create, rename, close and reopen service messages for
groups allowed by `groupPolicy`. Sender `allowFrom` restricts conversations,
not observation of topic state: an administrator's closure must be recorded
even when that administrator cannot trigger the agent. These events never go
to C4 or conversational history. Config changes apply through the existing hot reload.

Telegram has no topic-state query API. This history is observational: events
before installation, downtime beyond Telegram's update retention, or operations
outside this component may leave gaps. Missing history returns an empty list
with a warning only when neither current nor rotated files exist; damaged history
returns an error naming the file and a nonzero exit. Neither
blocks bot startup or ordinary messages. Topic history is an append-only journal
at `data/topics.jsonl` in the component data directory, preserved on upgrades.
Before each append (service events, close/reopen and import), a current file of
at least 2 MiB (2,097,152 bytes) is atomically renamed to
`topics.jsonl.YYYYMMDDTHHmmssSSSZ-PID` (UTC). Filenames include the process ID,
so two writers rotating simultaneously cannot overwrite each other. At most
5 files including the current file are retained, deleting the oldest rotated
name. Rotation/pruning errors are logged and the event is still appended;
failed pruning can exceed 5 until a later append can prune successfully. There is no compression, line rewriting
or age-based expiry.

Queries read only matching rotated names, in filename order followed by the
current file, then replay all retained events by event time (file order breaks
ties). A rotated-only history works normally. Known limitation: after an oldest
file is deleted, a topic with no later event disappears from query results
(becomes unknown); it is not treated as an incorrect open/closed state. At about
50 changes per day, a file can cover over half a year and five files about two
to three years; queries read approximately 10 MiB under that workload.

Use `topics.js close|reopen` instead of raw Bot API calls: successful operations
are recorded immediately, even before the service update arrives. Telegram's
server permits outgoing topic service updates ([source](https://github.com/tdlib/telegram-bot-api/blob/7232881b39dfcd048a0d569f1983c5184249ee05/telegram-bot-api/Client.cpp#L19565));
duplicate observations fold into the same topic. API failures are not recorded.
If the API succeeds but local persistence fails, the error explicitly says so;
check the service event/storage rather than blindly repeating the operation.

For a one-time seed, prepare a human-provided JSON array, then import it:

```json
[{"chat_id":"-1001234567890","topic_id":42,"name":"Status","state":"closed","updated_at":"2026-11-18T00:00:00Z","actor":null}]
```

```bash
node ~/zylos/.claude/skills/telegram/scripts/topics.js import --file /path/to/topics.json
```

The whole array is validated before appending; groups must be allowed. Use the
time the state was verified for `updated_at`. Imports merge by event time and
do not replace unrelated topics. Old dropped events cannot be recovered.

## Group Context

With Core `session_mode: multi`, forwarded group messages include only context
not previously handed to the same group or forum-topic session. Own bot replies
are excluded. Pending context survives bot restarts under `data/context/`, with
a bounded tail and an omitted-message count. The existing per-group `historyLimit`
(or global `message.context_messages`, default 5) applies; entries are capped at
500 characters. Context is consumed immediately before dispatch; a rejected or
uncertain delivery does not restore it for a later message, and the existing
failure notice asks the sender to retry. Each message starts its own C4 receive
without waiting for an earlier receive to finish. Overflow adds `之前还有 N 条未显示`; empty context emits no tags.
Single-session, old-Core and unknown-mode instances retain recent logged context.
Mode is read from Core's `.zylos/config.json`, not its supported CLI options.

Configuration in `config.json`:
```json
{
  "message": {
    "context_messages": 10
  }
}
```

Message logs are stored in `~/zylos/components/telegram/logs/<chat_id>.log`.
