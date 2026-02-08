# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-beta.19] - 2026-02-08

### Added
- Lazy download for group photo/document messages: log metadata (file_id, msg_id) for context instead of downloading immediately in non-smart groups
- Photo/document messages now logged in group context (were previously invisible)

### Changed
- Smart groups: photos/documents still download immediately
- Non-smart groups: photos/documents only logged with metadata, available via context on next @mention

---

## [0.1.0-beta.18] - 2026-02-08

### Fixed
- Group permission: empty `allowed_groups` now means open access (all groups allowed), not closed access that blocks all non-owner @mentions

---

## [0.1.0-beta.17] - 2026-02-08

### Changed
- Version bump for C4 upgrade completion message testing

---

## [0.1.0-beta.16] - 2026-02-08

### Fixed
- Removed dead config fields: `features.auto_split_messages` and `features.max_message_length` (never used, send.js uses hardcoded constant)
- `sendToC4` now retries once after 2s on failure (was fire-and-forget)
- `context.js`: changed `|| 10` to `?? 10` so `context_messages: 0` is respected
- Post-upgrade migrations: stop adding dead fields, add cleanup for existing installs, add `message.context_messages` migration
- `notifyOwnerPendingGroup` broken since beta.14: send.js path not updated when moved to scripts/ (would fail when bot is added to a new group)
- DESIGN.md: removed phantom "Product Key" references, stale security log example, phantom "message.js" module
- DESIGN.md: fixed c4-receive path, send.js path (root → scripts/), directory tree (added context.js, ecosystem.config.cjs), `--source` → `--channel`, added allowed_groups and message.context_messages to config docs
- DESIGN.md: PM2 config example updated to CJS format matching actual ecosystem.config.cjs
- README.md: updated version badge from beta.9 to beta.16

### Added
- Post-install: full Telegram Bot Setup Checklist (BotFather link, proxy hint, owner binding note)
- SKILL.md: added Environment Variables section documenting `TELEGRAM_PROXY_URL`

---

## [0.1.0-beta.15] - 2026-02-07

### Changed
- Version bump for component upgrade flow testing

---

## [0.1.0-beta.14] - 2026-02-07

### Changed
- Adapt to c4 comm-bridge interface changes: --source → --channel
- Move send.js to scripts/send.js (new c4-send.js lookup path)
- Update SKILL.md c4 paths and examples

---

## [0.1.0-beta.13] - 2026-02-07

### Changed
- Version bump for upgrade --check flow testing (now includes changelog + local changes)

---

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
