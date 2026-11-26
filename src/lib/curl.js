/**
 * curl helpers that keep the request URL, proxy and request body out of argv.
 *
 * Telegram API and file URLs carry the bot token (`/bot<token>/...`), a proxy
 * URL may carry `user:password@`, and a request body carries the message text.
 * Anything in argv is visible to every local user via `ps` /
 * `/proc/<pid>/cmdline`, so all three are passed to curl as a config file on
 * stdin (`-K -`) instead.
 */

import { execFile, execFileSync } from 'child_process';

/**
 * Quote one curl config value.
 * Inside a quoted config value curl treats backslash as an escape, so `\` and
 * `"` are escaped; newlines would end the line and are rejected.
 *
 * @param {string} name - option name, used in the error message
 * @param {string} value
 * @returns {string}
 */
function quoteConfigValue(name, value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) {
    throw new Error(`curl ${name} must not contain line breaks`);
  }
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Build a curl config that sets the URL and, when given, the proxy and the
 * request body (sent as-is, like `--data-binary`).
 *
 * @param {string} url
 * @param {string} [proxy]
 * @param {string} [data]
 * @returns {string}
 */
export function curlUrlConfig(url, proxy, data) {
  let config = `url = ${quoteConfigValue('URL', url)}\n`;
  if (proxy) config += `proxy = ${quoteConfigValue('proxy', proxy)}\n`;
  if (data !== undefined) config += `data-binary = ${quoteConfigValue('data', data)}\n`;
  return config;
}

/**
 * Synchronous curl call; `url`, `options.proxy` and `options.data` go through
 * stdin, never argv.
 *
 * @param {string[]} args - curl arguments without the URL, proxy or body
 * @param {string} url
 * @param {object} [options] - execFileSync options plus optional `proxy` and `data` (`input` is overridden)
 */
export function curlSync(args, url, options = {}) {
  const { proxy, data, ...execOptions } = options;
  return execFileSync('curl', ['-K', '-', ...args], { ...execOptions, input: curlUrlConfig(url, proxy, data) });
}

/**
 * Asynchronous curl call; `url` and `options.proxy` go through stdin, never argv.
 *
 * @param {string[]} args - curl arguments without the URL or proxy
 * @param {string} url
 * @param {object} options - execFile options plus optional `proxy`
 * @param {Function} callback - execFile callback (error, stdout, stderr)
 */
export function curlAsync(args, url, options, callback) {
  const { proxy, ...execOptions } = options || {};
  const config = curlUrlConfig(url, proxy);
  const child = execFile('curl', ['-K', '-', ...args], execOptions, callback);
  child.stdin.end(config);
  return child;
}
