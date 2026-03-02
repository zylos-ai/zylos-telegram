---
name: telegram
version: 0.2.1
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
