#!/usr/bin/env node
/**
 * On-demand media download by Telegram file_id
 * Usage: node download-media.js <file_id>
 *
 * Downloads a file from Telegram servers using its file_id and saves
 * it to the media directory. Prints the local file path on success.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import dotenv from 'dotenv';

const HOME = process.env.HOME;
dotenv.config({ path: path.join(HOME, 'zylos/.env') });

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PROXY_URL = process.env.TELEGRAM_PROXY_URL || '';
const MEDIA_DIR = path.join(HOME, 'zylos/components/telegram/media');

if (!BOT_TOKEN) {
  console.error('Error: TELEGRAM_BOT_TOKEN not set in .env');
  process.exit(1);
}

const fileId = process.argv[2];
if (!fileId) {
  console.error('Usage: node download-media.js <file_id>');
  process.exit(1);
}

fs.mkdirSync(MEDIA_DIR, { recursive: true });

try {
  // Step 1: Get file info from Telegram API
  const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`;
  let curlCmd = `curl -s "${apiUrl}"`;
  if (PROXY_URL) curlCmd = `curl -s --proxy "${PROXY_URL}" "${apiUrl}"`;

  const response = JSON.parse(execSync(curlCmd, { encoding: 'utf8' }));

  if (!response.ok) {
    console.error(`Telegram API error: ${response.description || 'unknown error'}`);
    process.exit(1);
  }

  const filePath = response.result.file_path;
  const ext = path.extname(filePath) || '.bin';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const localFilename = `download-${timestamp}${ext}`;
  const localPath = path.join(MEDIA_DIR, localFilename);

  // Step 2: Download the file
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  let dlCmd = `curl -s -o "${localPath}" "${fileUrl}"`;
  if (PROXY_URL) dlCmd = `curl -s --proxy "${PROXY_URL}" -o "${localPath}" "${fileUrl}"`;

  execSync(dlCmd);

  const stats = fs.statSync(localPath);
  console.log(localPath);
  console.error(`Downloaded: ${localPath} (${stats.size} bytes)`);
} catch (err) {
  console.error(`Download failed: ${err.message}`);
  process.exit(1);
}
