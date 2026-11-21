/**
 * curl helpers that keep the request URL out of argv.
 *
 * Telegram API and file URLs carry the bot token (`/bot<token>/...`). Anything
 * in argv is visible to every local user via `ps` / `/proc/<pid>/cmdline`, so
 * the URL is passed to curl as a config file on stdin (`-K -`) instead.
 */

import { execFile, execFileSync } from 'child_process';

/**
 * Build a one-line curl config that sets the URL.
 * Inside a quoted config value curl treats backslash as an escape, so `\` and
 * `"` are escaped; newlines would end the line and are rejected.
 *
 * @param {string} url
 * @returns {string}
 */
export function curlUrlConfig(url) {
  const value = String(url);
  if (/[\r\n]/.test(value)) {
    throw new Error('curl URL must not contain line breaks');
  }
  return `url = "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`;
}

/**
 * Synchronous curl call; `url` goes through stdin, never argv.
 *
 * @param {string[]} args - curl arguments without the URL
 * @param {string} url
 * @param {object} [options] - execFileSync options (`input` is overridden)
 */
export function curlSync(args, url, options = {}) {
  return execFileSync('curl', ['-K', '-', ...args], { ...options, input: curlUrlConfig(url) });
}

/**
 * Asynchronous curl call; `url` goes through stdin, never argv.
 *
 * @param {string[]} args - curl arguments without the URL
 * @param {string} url
 * @param {object} options - execFile options
 * @param {Function} callback - execFile callback (error, stdout, stderr)
 */
export function curlAsync(args, url, options, callback) {
  const config = curlUrlConfig(url);
  const child = execFile('curl', ['-K', '-', ...args], options, callback);
  child.stdin.end(config);
  return child;
}
