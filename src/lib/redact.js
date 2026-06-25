/**
 * Secret-redaction helpers for log safety.
 *
 * Logs must never contain auth credentials (bot tokens, proxy userinfo). These
 * helpers mask only the secret substring while preserving surrounding
 * diagnostic context (scheme, host, port, path, error type) so log lines stay
 * useful for debugging.
 */

/**
 * Redact Telegram bot tokens. Tokens appear in API URLs as `bot<token>/...`;
 * mask the token, keep the rest of the URL and path.
 *
 * @param {*} value - Any value; coerced to string.
 * @returns {string}
 */
export function redactToken(value) {
  return String(value ?? '').replace(/bot[^/\s]+/g, 'bot<redacted>');
}

/**
 * Redact userinfo credentials embedded in a URL, e.g. a proxy URL like
 * `socks5://user:pass@host:1080`. Masks only `user:pass@`, keeping the scheme,
 * host, and port.
 *
 * @param {*} value - Any value; coerced to string.
 * @returns {string}
 */
export function redactUrlCreds(value) {
  return String(value ?? '').replace(/(\w+:\/\/)[^/@\s]+@/g, '$1<redacted>@');
}

/**
 * Apply all auth/secret redactions — use on any value heading to a log.
 *
 * @param {*} value - Any value; coerced to string.
 * @returns {string}
 */
export function redactSecrets(value) {
  return redactUrlCreds(redactToken(value));
}
