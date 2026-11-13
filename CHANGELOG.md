# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Smart-mode groups and topics now add the 👀 reaction to every message the
  agent receives, not only @mentions, so members can see the agent has read it.
  The reaction clears when the agent replies, answers `[SKIP]`, Core rejects the
  message, or after 120 seconds. "Typing…" still shows only for @mentions,
  because an unmentioned message may end in `[SKIP]`.

## [0.6.0] - 2026-11-11

### Upgrade notes
- If an agent relies on a username-only DM allowlist entry to send messages
  proactively (not as a reply), add that user's numeric chat ID to the
  allowlist before upgrading. After the upgrade, username-only entries no
  longer authorize proactive DMs, and such sends are refused
  (`OUTBOUND_DM_DENIED`). Replying to a message the user sends still works.

### Fixed
- Never deliver an inbound message to C4 twice. c4-receive now runs without
  the 30 s timeout, and a call that ran but returned no structured result
  (killed, crashed, unparseable output) is not retried; the user gets the
  "may not have reached me" notice instead. Only a call that never started is
  retried once (#76).
- Stop escaping quotes in agent-visible message text: only `&`, `<` and `>`
  are escaped, so quoted words no longer reach the agent as `&quot;` (#70).
- The startup log reports the installed version from `package.json` instead of
  a hardcoded `v0.2.0`; stale `v0.2.0` header comments removed (#75).
- Enforce DM and group destination policies before outbound text, media, SKIP,
  or reaction API calls (#78).
- Preserve replies to accepted inbound username-only DMs and owner text mentions
  in unlisted groups using component message logs and current access policy. These replies
  remain bound to the original chat/message/thread, and groupPolicy=disabled
  still blocks them. Keep the complete reply endpoint supplied by C4.
- Preserve thread routing for private text replies, including username-allowed
  topic DMs. Log actual usernames separately from display names.

### Changed
- Smart-mode hint uses the zylos-component-template standard text: item 2 is
  now "the discussion is on a topic you can substantially help with" (#77).
- Outbound destinations must be canonical numeric Telegram chat IDs. Under DM
  allowlist policy, username-only entries (including legacy whitelist usernames)
  cannot authorize proactive sends; add the user's numeric DM ID. Username and
  @channel destinations are rejected. Exceptional replies require an original
  message in the component log and retain reply-to on every chunk and attachment.
  Missing logs deny exceptions; older DM logs without a username require a new
  inbound message or numeric allowlist entry for username-only access.
- DM allowlist admin commands warn when entries cannot authorize proactive sends.

## [0.5.0] - 2026-11-09

### Added
- Multi-session support: inbound messages carry a session group (`dm-<id>`,
  `group<id>`, `group<id>:topic-<id>` for forum topics), passed only when the
  installed Core lists `--session-group`. Endpoints of forum-topic messages gain
  a `topic:<id>` key (also on older Cores; older `send.js` ignores it).
- `scripts/session-group.js <endpoint>` prints the session group for a reply endpoint.

### Changed
- Inbound message layout matches zylos-lark: the source label (`[TG DM]` /
  `[TG GROUP:<name>]`) is on its own line, and the speaker moves inside
  `<current-message>` as `<name> said: <text>`.

### Fixed
- Core rejection text is no longer sent to Telegram users: the raw text is
  logged, and the user gets "try again later" when nothing was stored or a
  "may not have reached me, resend if no reply" notice when Core cannot say. Messages Core reports as already stored get
  no reply and are not resent; the typing indicator and 👀 reaction are cleared.
- Messages posted directly in a forum topic are no longer quoted as a reply to
  `[media]`: the topic's creation message is not treated as a reply target.

## [0.4.1] - 2026-07-10

### Fixed
- Retry file downloads on transient TLS failures (#65)
- Retry transient Telegram send failures in `scripts/send.js` — classify-and-retry
  for curl transport errors, HTTP 5xx, and 429 (honoring `retry_after` within a
  10s retry-delay budget); other 4xx are not retried; max 2 retries with ~4s
  interval; each retry is logged (#66, #68)

### Documentation
- SKILL.md frontmatter now instructs readers to load the exact command syntax
  from SKILL.md before sending media or using commands — do not guess flags
  (#42, #67)

## [0.4.0] - 2026-06-02

### Changed
- **BREAKING (group access)**: Bot joining a group now branches on the
  inviter:
  - **Owner invited** → the group is auto-configured, but locked to
    `allowFrom: [<ownerId>]` (owner-only — *not* the admin-CLI default
    `['*']`). The bot stays silent in the group on join; no in-group
    notice is posted. This gives the group a logged context immediately
    (so subsequent messages — including from members the owner has not
    yet authorized — are recorded in `logs/<chatId>.log`) while keeping
    bot access locked down until the owner adds more senders via
    `admin.js set-group-allowfrom`.
  - **Non-owner invited** → the group is **not** added. The bot stays
    silent in the group; the owner is DM'd the exact `admin.js add-group`
    command to authorize manually if desired.

  Previous behavior added every owner-invited group with
  `allowFrom: ['*']` (opening bot access to everyone in the group on
  arrival). The new flow keeps the same owner-as-inviter convenience but
  defaults to owner-only access, matching the principle of least privilege.

  Re-joining an already-configured group remains a no-op (existing
  allowlist entry is preserved).

- `addGroup(config, chatId, name, mode, opts)` in `src/lib/auth.js` gained
  an optional `opts.allowFrom` parameter (array of user-id strings) to
  override the default `['*']` initial allowlist. The admin CLI path
  (`admin.js add-group`) is unchanged and still opts into `['*']`.

## [0.3.6] - 2026-05-18

### Fixed
- Post-upgrade hook now backs up `config.json` to
  `config.json.backup.<ISO-timestamp>` before mutation and uses atomic
  write (temp + rename with unique suffix and failure cleanup) for the
  new config (#60)

### Removed
- Reverted in-config `_legacy_*` field injection
  (`_legacy_features_auto_split_messages`,
  `_legacy_features_max_message_length`, `_legacy_whitelist`,
  `_legacy_allowed_groups`, `_legacy_smart_groups`,
  `_legacy_group_whitelist`) in favor of whole-file backups; the
  original config schema is preserved (#60)

## [0.3.5] - 2026-04-12

### Fixed
- Fix intraword italic false positives (#58)
  - Underscores inside words (e.g. `created_at`, `snake_case`) are no longer treated as italic markers
  - Updated regex to use CommonMark intraword emphasis boundary rules
  - Added 9 new test cases covering intraword scenarios

## [0.3.4] - 2026-04-07

### Changed
- Align Telegram HTML handling with openclaw implementation (#56)
  - `escapeHtmlAttr()`: stricter href attribute escaping (additionally escapes `<` and `>`)
  - `avoidEntityMidSplit()`: protect HTML entities (`&amp;`, `&#123;`, `&#x1F;`) from being split mid-entity during chunking
  - `isTelegramParseError()`: narrow fallback to plain text only on parse-entity 400 errors (no longer masks unrelated 400 errors like chat_not_found or message_too_long)

## [0.3.3] - 2026-04-07

### Fixed
- Protect URLs from HTML escaping and italic formatting (#54)
  - Bare URLs: `&` was escaped to `&amp;`, breaking Telegram auto-linking of query parameters
  - Underscores in URLs (`access_type`, `redirect_uri`) were matched by italic `_text_` regex
  - Fix: extract all URLs (markdown links and bare) into placeholders before processing, restore as `<a>` tags
- Added 11 regression tests for URL handling (query params, OAuth URLs, bare URLs, multiple URLs)

## [0.3.2] - 2026-04-07

### Changed
- Revert default `message.textMode` back to `plain` for stability; markdown mode available via explicit config (`textMode: 'markdown'`)

## [0.3.1] - 2026-04-07

### Changed
- Default `message.textMode` changed from `plain` to `markdown`, including `send.js` fallback behavior when `textMode` is not set (#51)

### Fixed
- Prevent markdown placeholder leakage (`INLINECODE*`) in mixed inline-code text by switching to markdown-safe internal tokens (#50)
- Added regression coverage for mixed inline-code values to prevent placeholder leakage regressions (#50)

## [0.2.4] - 2026-03-17

### Added
- Voice message transcription support via optional voice-asr skill (#46)
  - Private chat: all voice messages processed (subject to DM access control)
  - Group: only when @mentioned
  - 👀 reaction + typing indicator during processing
  - Transcription via `~/zylos/bin/transcribe`; voice messages forwarded as `[Voice] <text>`
  - Temp audio files cleaned up; graceful "not supported" reply when voice-asr is not installed

### Fixed
- `downloadVoice` was imported but missing from `media.js` — would cause startup crash (#46)

## [0.2.3] - 2026-03-07

### Fixed
- Remove duplicate bot-joined message when non-owner adds bot to group (#44)

## [0.2.2] - 2026-03-02

### Changed
- Use stdin form for c4-send examples in SKILL.md (#39)

## [0.2.1] - 2026-02-26

### Added
- DM policy model: `dmPolicy` (open/allowlist/owner) with `dmAllowFrom` list, replacing legacy whitelist
- On-demand media download script (`scripts/download.js`) for file_id-based retrieval
- Reaction lifecycle hardening: single retry on clearReaction failure, per-indicator 120s timeout, shutdown cleanup

### Fixed
- Smart group eyes reaction (👀) no longer set on non-mention messages
- `set-dm-policy` admin command now normalizes input case

### Changed
- Legacy whitelist config auto-migrated to dmPolicy on upgrade (post-upgrade hook migration 4)
- Legacy admin commands (`list-whitelist`, `add-whitelist`, etc.) aliased to new dmPolicy commands

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
