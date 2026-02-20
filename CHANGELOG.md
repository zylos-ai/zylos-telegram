# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-02-20

### Added
- Unified group policy model: per-group config map supporting modes (mention/smart/disabled), per-group `allowFrom` lists, and per-group history limits
- Smart mode: per-topic evaluation with hint/[SKIP] mechanism, metadata-only forwarding for non-mention media
- Typing indicators: eyes reaction (👀) on message receipt, per-thread typing support in forum topics, correlation-based cleanup
- In-memory history with log replay on cold start, per-thread log files (`chatId_threadId.jsonl`)
- Structured endpoint format (`chatId|msg:X|thread:Y`) with retry and exponential backoff
- On-demand media download script (`download-media.js`) for file_id-based downloads
- User cache (`user-cache.js`) for username resolution
- Utility library (`utils.js`) with `escapeXml()`, `splitMessage()`, and ID normalization helpers
- Unified admin commands: `add-group`, `remove-group`, `list-groups`, `set-group-policy`, `set-group-history-limit`

### Changed
- Replace flat `allowed_groups[]` + `smart_groups[]` with `groups {}` config map
- Replace `execSync`/`exec` with `execFile`/`execFileSync` for security (shell injection prevention)
- Atomic config writes (tmp + rename) for all persistent state files
- `send.js` rewritten: structured endpoint parsing, message splitting, `recordOutgoing()` for bot reply persistence, `[SKIP]` handling
- Auth module rewritten: `isOwner()` uses user ID (not chat ID), `String()` normalization on all ID comparisons
- Post-upgrade hook auto-migrates v0.1 config schema to v0.2 groups map

### Fixed
- XML injection in `formatMessage()` — all user strings now pass through `escapeXml()`
- Thread ID included in all replies including error replies
- `splitMessage` skips empty chunks after trimming
- `ensureReplay()` called before `logAndRecord()` in all handlers (chronological order)
- Replay failure no longer permanently disables replay for that key
- `groupPolicy: disabled` is now an absolute gate (no owner bypass)
- Messages from non-authorized groups no longer logged to disk

### Security
- 16 rounds of Codex (gpt-5.3-codex) review, 50+ issues found and fixed
- 2 consecutive clean review rounds (R15 + R16)
- 23 tests passed (14 self-tests + 9 user tests)

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
