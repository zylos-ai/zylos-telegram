# zylos-telegram Design Document

**Version**: v2.0
**Date**: 2026-02-04
**Author**: Zylos Team
**Repository**: https://github.com/zylos-ai/zylos-telegram
**Status**: Implemented

---

## 1. Overview

### 1.1 Component Overview

zylos-telegram is a core communication component of Zylos0, responsible for enabling two-way messaging between users and the Claude Agent via the Telegram Bot API.

| Property | Value |
|----------|-------|
| Type | Communication |
| Priority | P0 |
| Dependency | C4 Communication Bridge |
| Code Base | zylos-infra/telegram-bot (~80% reused) |

### 1.2 Core Features

| Feature | Description | Priority |
|---------|-------------|----------|
| Private message receiving | Receive private messages from authorized users | P0 |
| Message sending | Send messages to a specified user via C4 | P0 |
| Owner auto-binding | First user is automatically bound as admin | P0 |
| User whitelist | Restrict usage to authorized users only | P0 |
| Group @mention | Receive messages mentioning @bot in group chats | P1 |
| Smart Groups | Receive all messages from designated groups | P1 |
| Image receiving | Download images and pass file paths to Claude | P1 |
| File receiving | Download files and pass file paths to Claude | P2 |
| Long message splitting | Automatically split oversized replies into segments | P1 |

### 1.3 Out of Scope

- Voice message handling (handled by the voice component)
- Video processing
- Inline Query
- Payment functionality

---

## 2. Directory Structure

### 2.1 Skills Directory (Code)

```
~/zylos/.claude/skills/telegram/
├── SKILL.md              # Component metadata (v2 format, with lifecycle)
├── package.json          # Dependency definitions
├── ecosystem.config.cjs  # PM2 configuration
├── hooks/
│   ├── post-install.js   # Post-install hook (create directories, configure PM2)
│   └── post-upgrade.js   # Post-upgrade hook (config migration)
├── scripts/
│   └── send.js           # C4 standard send interface
└── src/
    ├── bot.js            # Main entry point
    ├── admin.js          # Admin CLI
    └── lib/
        ├── config.js     # Configuration loader
        ├── auth.js       # Authentication (owner binding + whitelist)
        ├── context.js    # Group chat context management
        └── media.js      # Media handling module
```

> **Note**: The v2 format uses a `hooks/` directory, replacing the previous `install.js`, `upgrade.js`, and `uninstall.js`.
> Standard install/uninstall operations are handled by the zylos CLI; hooks only handle component-specific logic.

### 2.2 Data Directory

```
~/zylos/components/telegram/
├── config.json           # Runtime configuration
├── media/                # Media file storage (images, files, etc.)
└── logs/                 # Log directory (managed by PM2)
```

---

## 3. Architecture

### 3.1 Component Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    zylos-telegram                        │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────┐    ┌──────────────┐                   │
│  │   bot.js     │───▶│   auth.js    │                   │
│  │  (Telegraf)  │    │Owner+Whitelist│                   │
│  └──────┬───────┘    └──────────────┘                   │
│         │                                                │
│         │ Receive messages                               │
│         ▼                                                │
│  ┌──────────────┐                                       │
│  │   media.js   │  Download media locally                │
│  └──────┬───────┘                                       │
│         │                                                │
│         ▼                                                │
│  ┌──────────────────────────────────┐                   │
│  │ c4-receive (comm-bridge)         │ → C4 Bridge       │
│  └──────────────────────────────────┘                   │
│                                                          │
│  ┌──────────────┐                                       │
│  │   send.js    │  ← Called by C4 to send messages      │
│  └──────────────┘                                       │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### 3.2 Module Responsibilities

| Module | File | Responsibility |
|--------|------|----------------|
| Main | bot.js | Telegraf initialization, event listeners, message formatting, calling c4-receive |
| Config | lib/config.js | Load .env + config.json |
| Auth | lib/auth.js | Owner binding + whitelist verification |
| Media | lib/media.js | Download images/files locally |
| Context | lib/context.js | Group chat message log + @mention context |
| Send | scripts/send.js | C4 standard interface for sending text and media |

---

## 4. C4 Integration

### 4.1 Receive Flow (Telegram → Claude)

```
User sends a message
     │
     ▼
┌─────────────┐
│  bot.js     │  Listens to Telegram API
└─────┬───────┘
      │ 1. Owner binding (first-time user)
      │ 2. Whitelist verification
      │ 3. formatMessage() formats the message
      │    "[TG DM] username said: message content"
      │    "[TG GROUP:groupname] username said: message content"
      ▼
┌─────────────┐
│ c4-receive  │  comm-bridge interface
└─────┬───────┘
      │ --channel telegram
      │ --endpoint <chat_id>
      │ --content "..."
      ▼
┌─────────────┐
│   Claude    │  Processes the message
└─────────────┘
```

### 4.2 Send Flow (Claude → Telegram)

```
Claude needs to reply
      │
      ▼
┌─────────────┐
│  c4-send    │  C4 Bridge
└─────┬───────┘
      │ c4-send telegram <chat_id> "message content"
      ▼
┌──────────────────────────────────────────┐
│ ~/zylos/.claude/skills/telegram/scripts/send.js │
└─────┬────────────────────────────────────┘
      │ 1. Parse arguments
      │ 2. Check for [MEDIA:type] prefix
      │ 3. Auto-split long messages
      │ 4. Call Telegram API
      ▼
┌─────────────┐
│ Telegram    │  User receives the message
└─────────────┘
```

### 4.3 send.js Interface Specification

```bash
# Location: ~/zylos/.claude/skills/telegram/scripts/send.js
# Usage: node send.js <chat_id> <message>
# Returns: 0 on success, non-zero on failure

# Example - plain text
node send.js "8101553026" "Hello, this is a test message"

# Example - send image
node send.js "8101553026" "[MEDIA:image]/path/to/photo.jpg"

# Example - send file
node send.js "8101553026" "[MEDIA:file]/path/to/document.pdf"
```

### 4.4 Message Format Specification

**Incoming message format:**

```
# Private chat
[TG DM] howardzhou said: Hello

# Group @mention
[TG GROUP:dev-team] howardzhou said: @bot can you look this up

# With image
[TG DM] howardzhou said: [sent an image] What is this ---- file: ~/zylos/components/telegram/media/photos/xxx.jpg
```

**Routing info (appended by c4-receive):**

```
---- reply via: c4-send telegram "8101553026"
```

---

## 5. Configuration

### 5.1 config.json Structure

```json
{
  "enabled": true,

  "owner": {
    "chat_id": null,
    "username": null,
    "bound_at": null
  },

  "whitelist": {
    "chat_ids": [],
    "usernames": []
  },

  "allowed_groups": [],

  "smart_groups": [
    {
      "chat_id": "-100123456789",
      "name": "dev-team"
    }
  ],

  "features": {
    "download_media": true
  },

  "message": {
    "context_messages": 10
  }
}
```

### 5.2 Configuration Reference

| Field | Type | Description |
|-------|------|-------------|
| enabled | boolean | Component enable/disable switch |
| owner.chat_id | string | Admin chat_id (auto-bound on first interaction) |
| owner.username | string | Admin username |
| owner.bound_at | string | Binding timestamp |
| whitelist.chat_ids | string[] | List of allowed Telegram chat_ids |
| whitelist.usernames | string[] | List of allowed Telegram usernames |
| allowed_groups | object[] | Groups that respond to @mentions (chat_id + name) |
| smart_groups | object[] | Groups where all messages are monitored (chat_id + name) |
| features.download_media | boolean | Whether to download media files |
| message.context_messages | number | Number of recent messages included with group @mentions (default: 10) |

### 5.3 Environment Variables (~/zylos/.env)

```bash
# Telegram Bot Token (required)
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...

# Proxy URL (optional, required in mainland China)
TELEGRAM_PROXY_URL=http://your-proxy-host:port
```

**Note:** Secrets and proxy settings are configured in .env only, not duplicated in config.json.

---

## 6. Security

### 6.1 Owner Auto-Binding

**Design principle**: The first user to interact with the bot is automatically bound as the Owner (admin).

```
User sends /start
      │
      ▼
┌─────────────────┐
│ Check owner     │
│ Is it empty?    │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
  Empty    Not empty
    │         │
    ▼         ▼
Bind as owner  Proceed with normal auth flow
Save config
Reply "You are now the admin"
```

**Recorded on binding**:
- chat_id (automatically obtained from Telegram API, unique)
- username (if available)
- bound_at (binding timestamp)

### 6.2 User Authentication Flow

```
User sends a message
      │
      ▼
┌─────────────────┐
│ Is owner?       │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
   Yes       No
    │         │
    ▼         ▼
  Allow   ┌─────────────────┐
         │ On whitelist?    │
         └────────┬────────┘
                  │
             ┌────┴────┐
             │         │
            Yes       No
             │         │
             ▼         ▼
           Allow     Reject
                   "Bot is private"
```

### 6.3 Owner Privileges

The Owner has special privileges:
- Add/remove whitelist users (via commands)
- View bot status
- Extensible with more admin features in the future

### 6.4 Security Logging

All unauthorized access attempts are logged via console, with logs managed by PM2.

---

## 7. Media Handling

### 7.1 Receive Flow

```
User sends an image/file
      │
      ▼
┌─────────────┐
│  bot.js     │  Listens for photo/document events
└─────┬───────┘
      │
      ▼
┌─────────────┐
│  media.js   │  1. Get file_id
└─────┬───────┘  2. Call Telegram API to get file_path
      │          3. Download to ~/zylos/components/telegram/media/
      │          4. Filename: {type}-{timestamp}.{ext}
      ▼
Return local path, assemble into message and pass to c4-receive
```

### 7.2 Send Flow

```bash
# send.js parses the [MEDIA:type] prefix

# Image
node send.js "12345" "[MEDIA:image]/path/to/photo.jpg"
# → Calls sendPhoto API

# File
node send.js "12345" "[MEDIA:file]/path/to/doc.pdf"
# → Calls sendDocument API

# Plain text
node send.js "12345" "Hello world"
# → Calls sendMessage API
```

---

## 8. Service Management

### 8.1 PM2 Configuration

```javascript
// ecosystem.config.cjs (CJS format for PM2 compatibility)
const path = require('path');
const os = require('os');

module.exports = {
  apps: [{
    name: 'zylos-telegram',
    script: 'src/bot.js',
    cwd: path.join(os.homedir(), 'zylos/.claude/skills/telegram'),
    env: {
      NODE_ENV: 'production'
    }
  }]
};

// Note: .env is loaded by dotenv in bot.js, path: ~/zylos/.env
```

### 8.2 Service Commands

```bash
# Start
pm2 start ~/zylos/.claude/skills/telegram/ecosystem.config.cjs

# Stop
pm2 stop zylos-telegram

# Restart
pm2 restart zylos-telegram

# View logs
pm2 logs zylos-telegram
```

---

## 9. Lifecycle Management (v2 Hooks)

The v2 format uses a `lifecycle` configuration in `SKILL.md` and a `hooks/` directory, replacing the previous standalone scripts.

### 9.1 SKILL.md Lifecycle Configuration

```yaml
lifecycle:
  npm: true                          # zylos CLI runs npm install
  service:
    name: zylos-telegram             # PM2 service name
    entry: src/bot.js                # Entry file
  data_dir: ~/zylos/components/telegram  # Data directory
  hooks:
    post-install: hooks/post-install.js  # Post-install hook
    post-upgrade: hooks/post-upgrade.js  # Post-upgrade hook
```

### 9.2 hooks/post-install.js

Post-install hook that handles component-specific setup:

- Create subdirectories (media/, logs/)
- Generate default config.json
- Check environment variables
- Configure PM2 with ecosystem.config.cjs

### 9.3 hooks/post-upgrade.js

Post-upgrade hook that handles configuration migration:

- Check for and add new config fields
- Migrate legacy config formats
- Maintain backward compatibility

### 9.4 Install/Uninstall Flow

Standard operations are handled by the `zylos CLI`:

```bash
# Install
zylos install telegram
# 1. git clone to ~/zylos/.claude/skills/telegram
# 2. npm install
# 3. Create data_dir
# 4. Register PM2 service
# 5. Run post-install hook

# Upgrade
zylos upgrade telegram
# 1. git pull
# 2. npm install
# 3. Run post-upgrade hook
# 4. Restart PM2 service

# Uninstall
zylos uninstall telegram [--purge]
# 1. Remove PM2 service
# 2. Delete skill directory
# 3. --purge: Delete data directory
```

---

## 10. Acceptance Criteria

- [x] `zylos install telegram` completes installation on a fresh environment
- [x] `node send.js <chat_id> <message>` sends messages correctly
- [x] Private messages are correctly delivered to c4-receive
- [x] Images are downloaded and their paths are passed through
- [x] Owner auto-binding flow works correctly
- [x] Owner can @bot in any group to trigger a response
- [x] `zylos upgrade telegram` preserves user config and performs migration
- [x] `zylos uninstall telegram` cleans up correctly

---

## Appendix

### A. Dependency List

```json
{
  "dependencies": {
    "telegraf": "^4.x",
    "https-proxy-agent": "^7.x",
    "dotenv": "^16.x"
  }
}
```

### B. References

- [Telegraf Documentation](https://telegraf.js.org/)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Zylos Component Ecosystem Design](https://github.com/zylos-ai/zylos-core/blob/main/docs/components-design.md)

---

*End of document*
