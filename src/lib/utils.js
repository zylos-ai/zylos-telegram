/**
 * Shared utilities for zylos-telegram v0.2.0
 */

/**
 * Parse structured endpoint string.
 * Format: chatId|key:value|key:value...
 * Keys: msg, req, thread (extendable, unknown keys ignored).
 * First occurrence wins for duplicate keys.
 *
 * @param {string} endpoint - Raw endpoint string
 * @returns {{ chatId: string, [key: string]: string }}
 */
export function parseEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'string') return { chatId: '' };
  const parts = endpoint.split('|');
  const result = { chatId: parts[0] };
  for (let i = 1; i < parts.length; i++) {
    const sep = parts[i].indexOf(':');
    if (sep > 0 && sep < parts[i].length - 1) {
      const key = parts[i].slice(0, sep);
      if (!(key in result)) {
        result[key] = parts[i].slice(sep + 1);
      }
    }
  }
  return result;
}

/**
 * Build composite history key for per-topic isolation.
 * Thread IDs in Telegram are only unique within a chat, so we prefix with chatId.
 *
 * @param {string|number} chatId
 * @param {string|number|null|undefined} threadId
 * @returns {string}
 */
export function getHistoryKey(chatId, threadId) {
  return threadId ? `${chatId}:${threadId}` : String(chatId);
}

/**
 * Convert a historyKey to a safe log filename.
 * Replaces ':' with '_t_' to avoid colon in filenames.
 *
 * @param {string} historyKey - From getHistoryKey()
 * @returns {string} e.g. "-100123456.log" or "-100123456_t_789.log"
 */
export function historyKeyToLogFile(historyKey) {
  return historyKey.replaceAll(':', '_t_') + '.log';
}

/**
 * Escape user-generated content for safe embedding inside XML tags.
 * Prevents tag injection from user messages.
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeXml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;');
}

/**
 * Deep merge defaults into loaded config (one level deep).
 * Prevents shallow spread from losing nested default fields.
 *
 * @param {object} defaults
 * @param {object} loaded
 * @returns {object}
 */
export function deepMergeDefaults(defaults, loaded) {
  const result = { ...defaults, ...loaded };
  for (const key of Object.keys(defaults)) {
    if (
      defaults[key] &&
      typeof defaults[key] === 'object' &&
      !Array.isArray(defaults[key])
    ) {
      const loadedObj = loaded[key] || {};
      const filtered = Object.fromEntries(
        Object.entries(loadedObj).filter(([, v]) => v !== null)
      );
      result[key] = { ...defaults[key], ...filtered };
    }
  }
  return result;
}
