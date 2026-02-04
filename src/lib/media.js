/**
 * Media handling module for zylos-telegram
 * Downloads photos/files from Telegram to local storage
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { getEnv } from './config.js';

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
 * Download file from Telegram
 * @param {Object} ctx - Telegraf context
 * @param {string} fileId - Telegram file_id
 * @param {string} prefix - Filename prefix (e.g., 'photo', 'file')
 * @returns {Promise<string>} Local file path
 */
export async function downloadFile(ctx, fileId, prefix = 'file') {
  const botToken = getEnv('TELEGRAM_BOT_TOKEN');
  const proxyUrl = getEnv('TELEGRAM_PROXY_URL');

  // Get file info from Telegram
  const file = await ctx.telegram.getFile(fileId);
  const filePath = file.file_path;
  const ext = path.extname(filePath) || '.bin';

  // Generate local path
  const localFilename = generateFilename(prefix, ext);
  const localPath = path.join(MEDIA_DIR, localFilename);

  // Download URL
  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

  // Download using curl (supports proxy)
  return new Promise((resolve, reject) => {
    let curlCmd = `curl -s -o "${localPath}" "${fileUrl}"`;
    if (proxyUrl) {
      curlCmd = `curl -s --proxy "${proxyUrl}" -o "${localPath}" "${fileUrl}"`;
    }

    exec(curlCmd, (error) => {
      if (error) {
        reject(new Error(`Download failed: ${error.message}`));
      } else {
        console.log(`[telegram] Downloaded: ${localPath}`);
        resolve(localPath);
      }
    });
  });
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
  const prefix = doc.file_name ? path.parse(doc.file_name).name : 'document';
  return downloadFile(ctx, doc.file_id, prefix);
}
