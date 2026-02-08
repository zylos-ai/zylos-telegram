# zylos-telegram

[![Version](https://img.shields.io/badge/version-0.1.0--beta.16-blue.svg)](https://github.com/zylos-ai/zylos-telegram/releases)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Telegram Bot component for [Zylos Agent](https://github.com/zylos-ai/zylos-core), enabling bidirectional messaging between users and Claude via Telegram.

## Features

- **Private Messaging** - Secure one-on-one communication with Claude
- **Group Chat Support** - Respond to @mentions in groups
- **Smart Groups** - Monitor all messages from designated groups
- **Owner Auto-binding** - First user to interact becomes the admin
- **User Whitelist** - Control who can access the bot
- **Media Support** - Send and receive photos and documents

## Getting Started

Tell your Zylos agent:

> "Install the telegram component"

Zylos will guide you through the setup process, including obtaining a bot token from [@BotFather](https://t.me/botfather) if needed.

Once installed, simply message your bot on Telegram. The first user to interact becomes the owner (admin).

## Managing the Bot

Just tell your Zylos agent what you need:

| Task | Example |
|------|---------|
| Add user to whitelist | "Add @john to telegram whitelist" |
| Enable smart group | "Make this group a smart group" |
| Check status | "Show telegram bot status" |
| Restart bot | "Restart telegram bot" |

## Group Chat Behavior

| Scenario | Bot Response |
|----------|--------------|
| Private chat from owner/whitelisted | Responds via Claude |
| Smart group message | Receives all messages |
| @mention in allowed group | Responds via Claude |
| Owner @mention in any group | Responds via Claude |
| Unknown user | "Sorry, this bot is private" |

## Troubleshooting

Just ask Zylos:

> "Check telegram bot status"

> "Show telegram logs"

> "Restart telegram bot"

## Documentation

- [DESIGN.md](./DESIGN.md) - Technical design document
- [CHANGELOG.md](./CHANGELOG.md) - Version history

## Contributing

1. Fork the repository
2. Create a feature branch
3. Submit a Pull Request

## License

[MIT](./LICENSE)

---

Made with Claude by [Zylos AI](https://github.com/zylos-ai)
