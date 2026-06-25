/**
 * Media handling module for zylos-telegram
 * Downloads photos/files from Telegram to local storage
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { getEnv } from './config.js';
import { redactSecrets } from './redact.js';

export const MEDIA_DIR = path.join(process.env.HOME, 'zylos/components/telegram/media');

// Ensure media directory exists
if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

/**
 * Generate unique filename with timestamp
 */
function generateFilename(prefix, ext) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${prefix}-${timestamp}${ext}`;
}

/**
 * Sleep for the given number of milliseconds.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run an async operation with retry and incremental backoff.
 *
 * Downloads route through a local proxy (mihomo) to reach Telegram, and the
 * proxy occasionally drops the connection during the TLS handshake
 * ("socket disconnected before secure TLS connection was established").
 * These failures are transient — an immediate retry almost always succeeds.
 *
 * @param {Function} fn - Async operation to attempt: () => Promise<T>
 * @param {string} label - Short label for log output
 * @param {number} attempts - Maximum attempts (default 3)
 * @returns {Promise<T>}
 */
async function withRetry(fn, label, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const delay = 500 * attempt; // incremental backoff: 500ms, 1000ms, ...
        console.warn(`[telegram] ${label} failed (attempt ${attempt}/${attempts}): ${redactSecrets(error.message)}. Retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
  }
  // Re-throw with a redacted message so a bot token embedded in the underlying
  // error (e.g. Telegraf's request URL) never reaches the caller's logs.
  throw new Error(`${label} failed after ${attempts} attempts: ${redactSecrets(lastError && lastError.message)}`);
}

/**
 * Download file from Telegram
 * @param {Object} ctx - Telegraf context
 * @param {string} fileId - Telegram file_id
 * @param {string} prefix - Filename prefix (e.g., 'photo', 'file')
 * @returns {Promise<string>} Local file path
 */
export async function downloadFile(ctx, fileId, prefix = 'file') {
  const botToken = getEnv('TELEGRAM_BOT_TOKEN');
  const proxyUrl = getEnv('TELEGRAM_PROXY_URL');

  // Get file info from Telegram (retried — proxy TLS handshakes drop transiently)
  const file = await withRetry(() => ctx.telegram.getFile(fileId), 'getFile');
  const filePath = file.file_path;
  const ext = path.extname(filePath) || '.bin';

  // Generate local path
  const localFilename = generateFilename(prefix, ext);
  const localPath = path.join(MEDIA_DIR, localFilename);

  // Download URL
  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

  // Download using curl (supports proxy), with timeout — retried on transient failures
  await withRetry(() => new Promise((resolve, reject) => {
    const args = ['-s', '--fail', '--max-time', '30', '-o', localPath];
    if (proxyUrl) {
      args.push('--proxy', proxyUrl);
    }
    args.push(fileUrl);

    execFile('curl', args, { timeout: 35000 }, (error) => {
      if (error) {
        // error.message includes the full curl command line — and the URL in it
        // carries the bot token. Never surface it; report only the safe exit
        // code / signal so the secret cannot leak into logs.
        const cause = error.signal
          ? `signal ${error.signal}`
          : (error.code !== undefined ? `exit ${error.code}` : 'unknown error');
        reject(new Error(`curl download failed (${cause})`));
      } else {
        resolve(localPath);
      }
    });
  }), 'curl download');

  console.log(`[telegram] Downloaded: ${localPath}`);
  return localPath;
}

/**
 * Download photo from message
 * @param {Object} ctx - Telegraf context
 * @returns {Promise<string>} Local file path
 */
export async function downloadPhoto(ctx) {
  // Get largest photo (last in array)
  const photos = ctx.message.photo;
  const photo = photos[photos.length - 1];
  return downloadFile(ctx, photo.file_id, 'photo');
}

/**
 * Download document from message
 * @param {Object} ctx - Telegraf context
 * @returns {Promise<string>} Local file path
 */
export async function downloadDocument(ctx) {
  const doc = ctx.message.document;
  const rawPrefix = doc.file_name ? path.parse(doc.file_name).name : 'document';
  const prefix = rawPrefix.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64) || 'document';
  return downloadFile(ctx, doc.file_id, prefix);
}

/**
 * Download voice message
 * @param {Object} ctx - Telegraf context
 * @returns {Promise<string>} Local file path (.oga)
 */
export async function downloadVoice(ctx) {
  const voice = ctx.message.voice;
  return downloadFile(ctx, voice.file_id, 'voice');
}
