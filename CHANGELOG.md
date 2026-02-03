# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-beta.1] - 2026-02-03

First beta release establishing telegram as the reference implementation for zylos component best practices.

### Added
- Telegram Bot with Telegraf framework
- Owner auto-binding (first user becomes admin)
- Group whitelist management
- Smart groups (receive all messages without @mention)
- Media download support (photos, documents)
- Admin CLI for configuration
- C4 protocol integration via comm-bridge
- PM2 service management
- CHANGELOG.md for version tracking
- LICENSE file (MIT)

### Structure
- `send.js` at root directory (comm-bridge interface standard)
- `install.js`, `upgrade.js`, `uninstall.js` lifecycle scripts
- `src/` for internal implementation

### Upgrade Notes

Initial release. For fresh installation:

```bash
zylos-pm install telegram
```

No migration required.
