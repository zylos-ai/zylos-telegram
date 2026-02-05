---
name: telegram
version: 0.1.0-beta.8
description: Telegram Bot for user communication
type: communication

lifecycle:
  npm: true
  service:
    name: zylos-telegram
    entry: src/bot.js
  data_dir: ~/zylos/components/telegram
  hooks:
    post-install: hooks/post-install.js
    post-upgrade: hooks/post-upgrade.js

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

## Dependencies

- **comm-bridge**: Required for forwarding messages to Claude via C4 protocol

## When to Use

- Replying to Telegram messages from users
- Sending notifications or alerts via Telegram
- Receiving images/files from Telegram users

## How to Send Messages

Via C4 Bridge:
```bash
~/.claude/skills/comm-bridge/c4-send.sh telegram <chat_id> "message"
```

Or directly (for testing):
```bash
node ~/.claude/skills/telegram/send.js <chat_id> "message"
```

## Media Messages

```bash
# Send image
c4-send.sh telegram <chat_id> "[MEDIA:image]/path/to/photo.jpg"

# Send file
c4-send.sh telegram <chat_id> "[MEDIA:file]/path/to/document.pdf"
```

## Config Location

- Config: `~/zylos/components/telegram/config.json`
- Media: `~/zylos/components/telegram/media/`
- Logs: `~/zylos/components/telegram/logs/`

## Service Management

```bash
pm2 status zylos-telegram    # Check status
pm2 logs zylos-telegram      # View logs
pm2 restart zylos-telegram   # Restart service
```

## Owner

First user to interact with the bot becomes the owner (admin).

## Admin CLI

Manage bot configuration via `admin.js`:

```bash
# Show full config
node ~/.claude/skills/telegram/src/admin.js show

# Allowed Groups (respond to @mentions)
node ~/.claude/skills/telegram/src/admin.js list-allowed-groups
node ~/.claude/skills/telegram/src/admin.js add-allowed-group <chat_id> <name>
node ~/.claude/skills/telegram/src/admin.js remove-allowed-group <chat_id>

# Smart Groups (receive all messages, no @mention needed)
node ~/.claude/skills/telegram/src/admin.js list-smart-groups
node ~/.claude/skills/telegram/src/admin.js add-smart-group <chat_id> <name>
node ~/.claude/skills/telegram/src/admin.js remove-smart-group <chat_id>

# Whitelist
node ~/.claude/skills/telegram/src/admin.js list-whitelist
node ~/.claude/skills/telegram/src/admin.js add-whitelist chat_id <id>
node ~/.claude/skills/telegram/src/admin.js add-whitelist username <name>
node ~/.claude/skills/telegram/src/admin.js remove-whitelist chat_id <id>

# Owner info
node ~/.claude/skills/telegram/src/admin.js show-owner

# Help
node ~/.claude/skills/telegram/src/admin.js help
```

After changes, restart: `pm2 restart zylos-telegram`
