#!/usr/bin/env node
/**
 * zylos-telegram media download by file_id
 *
 * Usage:
 *   node download.js <file_id> [filename_hint]
 *
 * Downloads a photo or file from Telegram servers using a file_id.
 * The file_id comes from message metadata logged in smart group context.
 *
 * Outputs the local file path on success.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PROXY_URL = process.env.TELEGRAM_PROXY_URL;
const MEDIA_DIR = path.join(process.env.HOME, 'zylos/components/telegram/media');

if (!BOT_TOKEN) {
  console.error('Error: TELEGRAM_BOT_TOKEN not set in .env');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node download.js <file_id> [filename_hint]');
  console.error('  file_id       - Telegram file_id from message metadata');
  console.error('  filename_hint - Optional filename prefix (default: "download")');
  process.exit(1);
}

const fileId = args[0];
const filenameHint = args[1] || 'download';

fs.mkdirSync(MEDIA_DIR, { recursive: true });

// Step 1: Call getFile API to get the file_path
async function getFilePath(fileId) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const curlArgs = ['-s', '--fail', '--max-time', '10', url];
  if (PROXY_URL) curlArgs.splice(1, 0, '--proxy', PROXY_URL);

  return new Promise((resolve, reject) => {
    execFile('curl', curlArgs, { timeout: 15000 }, (error, stdout) => {
      if (error) return reject(new Error(`getFile API failed: ${error.message}`));
      try {
        const data = JSON.parse(stdout);
        if (!data.ok || !data.result?.file_path) {
          return reject(new Error(`getFile failed: ${data.description || 'no file_path'}`));
        }
        resolve(data.result.file_path);
      } catch (e) {
        reject(new Error(`Failed to parse getFile response: ${e.message}`));
      }
    });
  });
}

// Step 2: Download the file
async function downloadFile(filePath, localPath) {
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const curlArgs = ['-s', '--fail', '--max-time', '60', '-o', localPath, url];
  if (PROXY_URL) curlArgs.splice(1, 0, '--proxy', PROXY_URL);

  return new Promise((resolve, reject) => {
    execFile('curl', curlArgs, { timeout: 65000 }, (error) => {
      if (error) return reject(new Error(`Download failed: ${error.message}`));
      resolve(localPath);
    });
  });
}

try {
  const filePath = await getFilePath(fileId);
  const ext = path.extname(filePath) || '.bin';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeHint = filenameHint.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const localPath = path.join(MEDIA_DIR, `${safeHint}-${timestamp}${ext}`);

  await downloadFile(filePath, localPath);
  console.log(localPath);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
