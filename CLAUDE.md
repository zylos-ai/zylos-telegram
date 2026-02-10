# CLAUDE.md

Development guidelines for zylos-telegram.

## Project Conventions

- **ESM only** — Use `import`/`export`, never `require()`. All files use ES Modules (`"type": "module"` in package.json)
- **Node.js 20+** — Minimum runtime version
- **Conventional commits** — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- **No `files` in package.json** — Rely on `.gitignore` to exclude unnecessary files. Use `.npmignore` if publishing to npm
- **Secrets in `.env` only** — Never commit secrets. Use `~/zylos/.env` for credentials, `config.json` for non-sensitive runtime config
- **English for code** — Comments, commit messages, PR descriptions, and documentation in English

## Architecture

This is a **communication component** for the Zylos agent ecosystem.

- `src/bot.js` — Main entry point (Telegraf bot, long polling)
- `src/lib/auth.js` — Owner binding + whitelist
- `src/lib/config.js` — Config loader with hot-reload
- `src/lib/media.js` — Media download handling
- `src/lib/context.js` — Group chat context management
- `scripts/send.js` — C4 outbound message interface
- `hooks/` — Lifecycle hooks (post-install, post-upgrade)
- `ecosystem.config.cjs` — PM2 service config (CommonJS required by PM2)

See [DESIGN.md](./DESIGN.md) for full architecture documentation.
