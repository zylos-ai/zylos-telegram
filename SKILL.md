---
name: telegram
version: 0.4.0
description: >-
  Telegram Bot communication channel (long polling mode, works behind firewalls).
  Use when: (1) replying to Telegram messages (DM or group @mentions),
  (2) sending proactive messages or media (images, files) to Telegram users or groups,
  (3) managing DM access control (dmPolicy: open/allowlist/owner, dmAllowFrom list),
  (4) managing group access control (groupPolicy, per-group allowFrom, smart/mention modes),
  (5) configuring the bot (admin CLI, proxy settings),
  (6) troubleshooting Telegram bot connection or polling issues.
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
Owner always bypasses all access checks (DM and group) regardless of policy settings.

## Access Control

DM and group access are controlled by independent policies:

**Private DM (dmPolicy):** `open` (anyone) | `allowlist` (dmAllowFrom list) | `owner` (owner only)

**Group (groupPolicy):** `open` (any group) | `allowlist` (configured groups only) | `disabled` (no groups)

Per-group options: `mode` (mention/smart), `allowFrom` (restrict senders), `historyLimit`.

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

## Group Context

When responding to @mentions in groups, the bot includes recent message context
so Claude understands the conversation. Context is retrieved from logged messages
since the last response.

Configuration in `config.json`:
```json
{
  "message": {
    "context_messages": 10
  }
}
```

Message logs are stored in `~/zylos/components/telegram/logs/<chat_id>.log`.
