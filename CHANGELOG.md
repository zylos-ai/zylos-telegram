# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-02-03

### Changed
- Move send.js to root directory (comm-bridge interface standard)
- Update npm install to use --omit=dev flag

### Added
- CHANGELOG.md for version history
- LICENSE file (MIT)
- upgrades/ directory with version documentation
- type and dependencies fields in SKILL.md

### Fixed
- Version sync between SKILL.md and package.json

## [1.0.4] - 2026-02-03

### Fixed
- Allow owner to @mention bot in non-whitelisted groups

## [1.0.3] - 2026-02-03

### Added
- Owner can interact with bot in any group via @mention

## [1.0.2] - 2026-02-03

### Changed
- Version bump for upgrade testing

## [1.0.1] - 2026-02-03

### Changed
- Version bump for initial upgrade test

## [1.0.0] - 2026-02-01

### Added
- Initial release
- Telegram Bot with Telegraf framework
- Owner auto-binding (first user becomes admin)
- Group whitelist management
- Smart groups (receive all messages without @mention)
- Media download support (photos, documents)
- Admin CLI for configuration
- C4 protocol integration via comm-bridge
- PM2 service management
