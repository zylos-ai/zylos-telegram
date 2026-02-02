---
name: telegram
description: Telegram Bot for user communication. Use when replying to Telegram messages or sending notifications.
---

# Telegram Bot

Telegram messaging component for Zylos Agent.

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
~/.claude/skills/telegram/src/send.sh <chat_id> "message"
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
Owner can manage whitelist via bot commands.
