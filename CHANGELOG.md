# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-02-13

### Fixed
- Fix dotenv loading to use absolute path (#23)
- Default group whitelist to deny-all except owner for security (#24)

### Added
- Group whitelist toggle: `enable-group-whitelist` / `disable-group-whitelist` admin commands (#24)

## [0.1.0] - 2026-02-11

Initial public release.

### Added
- Telegram Bot with Telegraf framework
- Owner auto-binding (first user becomes admin)
- Group whitelist management with enable/disable toggle
- Smart groups (receive all messages without @mention)
- Group context — include recent messages when responding to @mentions
- Media support: photos, documents with lazy download in non-smart groups
- C4 protocol integration with rejection response and retry
- Hooks-based lifecycle (post-install, post-upgrade, pre-upgrade)
- Admin CLI for managing groups, whitelist, and owner
- PM2 service management via ecosystem.config.cjs
