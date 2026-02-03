#!/usr/bin/env node
/**
 * zylos-telegram send interface
 * Usage: node send.js <chat_id> "<message>"
 * Supports: text, [MEDIA:image], [MEDIA:file]
 * Returns: exit 0 on success, non-zero on failure
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

// Load environment
const envPath = path.join(process.env.HOME, 'zylos', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PROXY_URL = process.env.TELEGRAM_PROXY_URL;
const MAX_LENGTH = 4000;

// Parse arguments
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node send.js <chat_id> "<message>"');
  process.exit(1);
}

const chatId = args[0];
const message = args.slice(1).join(' ');

if (!BOT_TOKEN) {
  console.error('Error: TELEGRAM_BOT_TOKEN not set');
  process.exit(1);
}

/**
 * Make HTTP request (with optional proxy support via curl for simplicity)
 */
function apiRequest(method, params) {
  return new Promise((resolve, reject) => {
    const { execSync } = require('child_process');
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

    let curlCmd;

    if (params.photo || params.document) {
      // File upload - use multipart form
      const filePath = params.photo || params.document;
      const fieldName = params.photo ? 'photo' : 'document';

      curlCmd = `curl -s -X POST "${url}" -F "chat_id=${chatId}" -F "${fieldName}=@${filePath}"`;
    } else {
      // JSON request
      const jsonData = JSON.stringify(params);
      curlCmd = `curl -s -X POST "${url}" -H "Content-Type: application/json" -d '${jsonData.replace(/'/g, "'\\''")}'`;
    }

    if (PROXY_URL) {
      curlCmd = curlCmd.replace('curl ', `curl --proxy "${PROXY_URL}" `);
    }

    try {
      const result = execSync(curlCmd, { encoding: 'utf8' });
      const response = JSON.parse(result);
      if (response.ok) {
        resolve(response.result);
      } else {
        reject(new Error(response.description || 'API error'));
      }
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Send text message
 */
async function sendText(text) {
  return apiRequest('sendMessage', {
    chat_id: chatId,
    text: text
  });
}

/**
 * Send photo
 */
async function sendPhoto(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  return apiRequest('sendPhoto', { photo: filePath });
}

/**
 * Send document
 */
async function sendDocument(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  return apiRequest('sendDocument', { document: filePath });
}

/**
 * Split long message into chunks
 */
function splitMessage(text, maxLen) {
  const chunks = [];
  const lines = text.split('\n');
  let current = '';

  for (const line of lines) {
    if (current.length + line.length + 1 <= maxLen) {
      current = current ? current + '\n' + line : line;
    } else {
      if (current) chunks.push(current);
      current = line;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Main
 */
async function main() {
  try {
    // Check for media prefix
    if (message.startsWith('[MEDIA:image]')) {
      const filePath = message.substring('[MEDIA:image]'.length);
      await sendPhoto(filePath);
      console.log(`Sent photo to ${chatId}`);
      return;
    }

    if (message.startsWith('[MEDIA:file]')) {
      const filePath = message.substring('[MEDIA:file]'.length);
      await sendDocument(filePath);
      console.log(`Sent file to ${chatId}`);
      return;
    }

    // Send text message
    if (message.length <= MAX_LENGTH) {
      await sendText(message);
      console.log(`Sent: ${message.substring(0, 50)}...`);
      return;
    }

    // Split long messages
    console.log(`Splitting message (${message.length} chars)...`);
    const chunks = splitMessage(message, MAX_LENGTH);

    for (let i = 0; i < chunks.length; i++) {
      await sendText(chunks[i]);
      console.log(`Sent chunk ${i + 1}/${chunks.length}`);
      if (i < chunks.length - 1) {
        await sleep(300);
      }
    }

    console.log(`Done! Sent ${chunks.length} chunks.`);

  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
