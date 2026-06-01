/**
 * Member username → id cache.
 *
 * Telegram Bot API has no direct `@username → user_id` resolver for
 * regular users (only for channels/supergroups). To let the owner say
 * "allow @user" in natural language and have it resolve to a numeric
 * user_id, we passively cache mappings observed from incoming messages.
 *
 * Schema (flat global map, `~/zylos/components/telegram/members.json`):
 *
 *   {
 *     "<username_lowercase>": "<user_id>",
 *     ...
 *   }
 *
 * @username is globally unique on Telegram, so the cache is not nested
 * per-chat. Last-writer-wins on rename / takeover (see USERNAME-TAKEOVER
 * below).
 *
 * Population: `recordMember(ctx)` is called at the top of every message
 * handler. It captures `ctx.from.id` keyed by `ctx.from.username` for
 * every user we see. Users without a @username (privacy setting) are
 * skipped — there is no key to record them under.
 *
 * Consumption: `resolveUsername('@felix')` returns the cached numeric id
 * or null. The admin CLI uses this to translate `@username` arguments to
 * numeric ids at config-edit time, so the stored allowFrom always uses
 * stable numeric ids (immune to subsequent username changes).
 *
 * USERNAME-TAKEOVER edge case:
 *   - User A (id 100) is @felix → cache.felix = "100".
 *   - A renames to @felixnew, A speaks again → cache.felixnew = "100"
 *     (new entry); cache.felix is still "100" (STALE — A no longer holds
 *     this @).
 *   - User B (id 200) claims @felix, B speaks → cache.felix = "200"
 *     (overwritten — now correct).
 *   - Window between A renaming and B speaking: `resolveUsername('@felix')`
 *     still returns "100" (old A). Acceptable: owner can re-issue the
 *     allow command using the new @ once they notice.
 *
 * Writes are debounced (5s) so an active group doesn't thrash disk.
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME || '/tmp';
const CACHE_PATH = path.join(HOME, 'zylos/components/telegram/members.json');
const FLUSH_DEBOUNCE_MS = 5000;

let cache = null;          // in-memory map
let flushTimer = null;
let dirty = false;

function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')) || {};
  } catch {
    cache = {};
  }
  return cache;
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
      const tmp = `${CACHE_PATH}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
      fs.renameSync(tmp, CACHE_PATH);
    } catch (err) {
      console.warn(`[telegram] members cache flush failed: ${err.message}`);
    }
  }, FLUSH_DEBOUNCE_MS);
  flushTimer.unref?.();
}

/**
 * Capture username → id mapping from a Telegraf context.
 * Safe to call at the top of any message handler. No-ops for messages
 * without ctx.from.username (Telegram users with no public username).
 */
export function recordMember(ctx) {
  const username = ctx?.from?.username;
  const id = ctx?.from?.id;
  if (!username || !id) return;
  const key = String(username).toLowerCase();
  const val = String(id);
  const map = loadCache();
  if (map[key] === val) return;        // no change → skip flush
  map[key] = val;
  scheduleFlush();
}

/**
 * Resolve `@username` (or bare `username`) to a numeric user_id string.
 * Returns null if not seen yet.
 */
export function resolveUsername(usernameOrAt) {
  if (!usernameOrAt) return null;
  const key = String(usernameOrAt).replace(/^@/, '').toLowerCase();
  return loadCache()[key] || null;
}

/**
 * Return the full cache (for admin CLI inspection). Returns a fresh
 * snapshot — callers must not mutate.
 */
export function listMembers() {
  return { ...loadCache() };
}

/**
 * Force-flush pending writes (for shutdown hooks or admin commands that
 * need the file up-to-date before exiting).
 */
export function flushNow() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    const tmp = `${CACHE_PATH}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, CACHE_PATH);
  } catch (err) {
    console.warn(`[telegram] members cache flush failed: ${err.message}`);
  }
}
