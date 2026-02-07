# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-beta.12] - 2026-02-07

### Changed
- Version bump for upgrade flow testing on zylos0

---

## [0.1.0-beta.11] - 2026-02-07

### Fixed
- SKILL.md version now correctly tracks releases (was stuck at beta.9 in beta.10)
- ecosystem.config.cjs converted to CJS for PM2 compatibility
- c4-receive.js path corrected to scripts/ subdirectory

---

## [0.1.0-beta.9] - 2026-02-05

### Added
- Group context feature - include recent messages when responding to @mentions
- Message logging for allowed/smart groups
- Cursor tracking to avoid duplicate context
- `message.context_messages` config option (default 10)

### Changed
- Clean up @mention from text before sending to Claude

---

## [0.1.0-beta.7] - 2026-02-05

### Changed
- Test release for interactive confirmation testing

---

## [0.1.0-beta.6] - 2026-02-05

### Changed
- Test release for zylos upgrade v2 testing

---

## [0.1.0-beta.2] - 2026-02-04

### Changed
- **SKILL.md v2 format**: Added `lifecycle` configuration for declarative install/upgrade
- **Hooks-based lifecycle**: Replaced `install.js`, `upgrade.js`, `uninstall.js` with hooks/
- Standard operations now handled by zylos CLI, component-specific logic in hooks

### Added
- `hooks/post-install.js` - Create subdirs, default config, check env, configure PM2
- `hooks/post-upgrade.js` - Config schema migrations

### Removed
- `install.js` - Replaced by zylos CLI + hooks/post-install.js
- `upgrade.js` - Replaced by zylos CLI + hooks/post-upgrade.js
- `uninstall.js` - Replaced by zylos CLI

### Upgrade Notes

For existing installations, run:
```bash
zylos upgrade telegram
```

The upgrade will automatically migrate your config.json if needed.

---

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
zylos install telegram
```

No migration required.
