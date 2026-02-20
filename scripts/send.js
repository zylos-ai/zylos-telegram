#!/usr/bin/env node
/**
 * zylos-telegram send interface
 * Usage: node send.js <endpoint> "<message>"
 * Supports: text, [MEDIA:image], [MEDIA:file]
 * Returns: exit 0 on success, non-zero on failure
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync, execFileSync } from 'child_process';
import dotenv from 'dotenv';
import { parseEndpoint } from '../src/lib/utils.js';
import { DATA_DIR, loadConfig } from '../src/lib/config.js';

// Load .env from ~/zylos/.env (not cwd which may be comm-bridge directory)
dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PROXY_URL = process.env.TELEGRAM_PROXY_URL;
const MAX_LENGTH = 4000;
const INTERNAL_TOKEN = crypto.createHash('sha256').update(BOT_TOKEN || '').digest('hex');

// Parse arguments
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node send.js <endpoint> "<message>"');
  process.exit(1);
}

const parsed = parseEndpoint(args[0]);
const chatId = parsed.chatId;
const triggerMsgId = parsed.msg ? parseInt(parsed.msg, 10) : null;
const correlationId = parsed.req || null;
const threadId = parsed.thread ? parseInt(parsed.thread, 10) : null;
const message = args.slice(1).join(' ');

if (!chatId) {
  console.error('Error: invalid endpoint (missing chatId)');
  process.exit(1);
}

if (!BOT_TOKEN) {
  console.error('Error: TELEGRAM_BOT_TOKEN not set');
  process.exit(1);
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Make Telegram API request via curl.
 * Returns parsed response.result on success.
 * Throws error with telegramResponse property on failure.
 */
function apiRequest(method, params) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

  let result;
  if (params.photo || params.document) {
    const filePath = params.photo || params.document;
    const fieldName = params.photo ? 'photo' : 'document';
    const args = ['-s', '--max-time', '30', '-X', 'POST'];
    if (PROXY_URL) args.push('--proxy', PROXY_URL);
    args.push(url, '-F', `chat_id=${params.chat_id}`, '-F', `${fieldName}=@${filePath}`);
    if (params.reply_to_message_id) {
      args.push('-F', `reply_to_message_id=${params.reply_to_message_id}`);
    }
    if (params.message_thread_id) {
      args.push('-F', `message_thread_id=${params.message_thread_id}`);
    }
    result = execFileSync('curl', args, { encoding: 'utf8', timeout: 35000 });
  } else {
    const jsonData = JSON.stringify(params);
    let curlCmd = `curl -s --max-time 30 -X POST "${url}" -H "Content-Type: application/json" -d '${jsonData.replace(/'/g, "'\\''")}'`;
    if (PROXY_URL) {
      curlCmd = curlCmd.replace('curl ', `curl --proxy "${PROXY_URL}" `);
    }
    result = execSync(curlCmd, { encoding: 'utf8', timeout: 35000 });
  }
  const response = JSON.parse(result);
  if (response.ok) return response.result;

  const err = new Error(response.description || 'API error');
  err.telegramResponse = response;
  throw err;
}

/**
 * API request with 429 retry.
 */
async function apiRequestWithRetry(method, params, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return apiRequest(method, params);
    } catch (err) {
      const tgErr = err.telegramResponse;
      if (tgErr?.error_code === 429 && attempt < maxRetries) {
        const retryAfter = (tgErr.parameters?.retry_after || 5) * 1000;
        console.warn(`[telegram] Rate limited, retrying in ${retryAfter}ms`);
        await sleep(retryAfter);
        continue;
      }
      throw err;
    }
  }
}

function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let breakAt = maxLength;

    // Check if we're inside a code block at the break point
    const segment = remaining.substring(0, breakAt);
    const fenceMatches = segment.match(/```/g);
    const insideCodeBlock = fenceMatches && fenceMatches.length % 2 !== 0;

    if (insideCodeBlock) {
      // Try to break before the code block
      const lastFenceStart = segment.lastIndexOf('```');
      const lineBeforeFence = remaining.lastIndexOf('\n', lastFenceStart - 1);
      if (lineBeforeFence > maxLength * 0.2) {
        breakAt = lineBeforeFence;
      } else {
        // Or include the full code block
        const fenceEnd = remaining.indexOf('```', lastFenceStart + 3);
        if (fenceEnd !== -1) {
          const blockEnd = remaining.indexOf('\n', fenceEnd + 3);
          breakAt = blockEnd !== -1 ? blockEnd + 1 : fenceEnd + 3;
        }
        if (breakAt > maxLength) {
          breakAt = maxLength; // Hard split as last resort
        }
      }
    } else {
      // Prefer paragraph breaks > line breaks > word boundaries
      const chunk = remaining.substring(0, breakAt);
      const lastParaBreak = chunk.lastIndexOf('\n\n');
      if (lastParaBreak > maxLength * 0.3) {
        breakAt = lastParaBreak + 1;
      } else {
        const lastNewline = chunk.lastIndexOf('\n');
        if (lastNewline > maxLength * 0.3) {
          breakAt = lastNewline;
        } else {
          const lastSpace = chunk.lastIndexOf(' ');
          if (lastSpace > maxLength * 0.3) {
            breakAt = lastSpace;
          }
        }
      }
    }

    chunks.push(remaining.substring(0, breakAt).trim());
    remaining = remaining.substring(breakAt).trim();
  }

  return chunks;
}

/**
 * Send text message, chunked with reply-to and thread support.
 */
async function sendText(text) {
  const chunks = splitMessage(text, MAX_LENGTH);

  for (let i = 0; i < chunks.length; i++) {
    const isFirstChunk = i === 0;
    const params = { chat_id: chatId, text: chunks[i] };

    // Thread support: all chunks go to the correct topic
    if (threadId) {
      params.message_thread_id = threadId;
    }

    // Reply-to: first chunk replies to trigger message
    if (isFirstChunk && triggerMsgId) {
      params.reply_to_message_id = triggerMsgId;
    }

    try {
      await apiRequestWithRetry('sendMessage', params);
    } catch (err) {
      // If reply_to fails (message deleted/too old), retry without it
      if (params.reply_to_message_id && err.telegramResponse?.error_code === 400) {
        console.warn('[telegram] reply_to_message_id failed, sending without reply');
        delete params.reply_to_message_id;
        await apiRequestWithRetry('sendMessage', params);
      } else {
        throw err;
      }
    }

    console.log(`Sent chunk ${i + 1}/${chunks.length}`);
    if (i < chunks.length - 1) {
      await sleep(500); // Increased from 300ms to reduce 429 likelihood
    }
  }
}

/**
 * Send photo with reply-to and thread support.
 */
async function sendPhoto(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const params = { chat_id: chatId, photo: filePath };
  if (triggerMsgId) params.reply_to_message_id = triggerMsgId;
  if (threadId) params.message_thread_id = threadId;

  try {
    return await apiRequestWithRetry('sendPhoto', params);
  } catch (err) {
    if (params.reply_to_message_id && err.telegramResponse?.error_code === 400) {
      console.warn('[telegram] reply_to_message_id failed, sending photo without reply');
      delete params.reply_to_message_id;
      return apiRequestWithRetry('sendPhoto', params);
    }
    throw err;
  }
}

/**
 * Send document with reply-to and thread support.
 */
async function sendDocument(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const params = { chat_id: chatId, document: filePath };
  if (triggerMsgId) params.reply_to_message_id = triggerMsgId;
  if (threadId) params.message_thread_id = threadId;

  try {
    return await apiRequestWithRetry('sendDocument', params);
  } catch (err) {
    if (params.reply_to_message_id && err.telegramResponse?.error_code === 400) {
      console.warn('[telegram] reply_to_message_id failed, sending document without reply');
      delete params.reply_to_message_id;
      return apiRequestWithRetry('sendDocument', params);
    }
    throw err;
  }
}

function markTypingDone() {
  if (!correlationId) return;
  try {
    const typingDir = path.join(DATA_DIR, 'typing');
    fs.mkdirSync(typingDir, { recursive: true });
    fs.writeFileSync(path.join(typingDir, `${correlationId}.done`), String(Date.now()));
  } catch {}
}

async function recordOutgoing(text) {
  const cfg = loadConfig();
  const port = cfg.internal_port || 3460;
  try {
    // Truncate before sending — server only stores first 500 chars anyway
    const body = JSON.stringify({
      chatId,
      threadId: threadId || null,
      text: text.substring(0, 500)
    });
    const resp = await fetch(`http://127.0.0.1:${port}/internal/record-outgoing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': INTERNAL_TOKEN
      },
      body
    });
    if (!resp.ok) {
      console.warn(`[telegram] recordOutgoing failed: ${resp.status}`);
    }
  } catch {}
}

/**
 * Remove eyes reaction from trigger message (smart mode cleanup).
 * Reuses apiRequest() for consistent proxy/serialization handling.
 */
function clearReaction() {
  if (!triggerMsgId) return;
  try {
    apiRequest('setMessageReaction', {
      chat_id: chatId,
      message_id: triggerMsgId,
      reaction: []
    });
  } catch {}
}

/**
 * Main
 */
async function main() {
  try {
    // Smart mode skip — AI decided not to respond
    if (message.trim() === '[SKIP]') {
      clearReaction();
      markTypingDone();
      console.log('Skipped (smart mode, not relevant)');
      return;
    }

    if (message.startsWith('[MEDIA:image]')) {
      const filePath = message.substring('[MEDIA:image]'.length);
      clearReaction();
      await sendPhoto(filePath);
      markTypingDone();
      await recordOutgoing('[sent a photo]');
      console.log(`Sent photo to ${chatId}`);
      return;
    }

    if (message.startsWith('[MEDIA:file]')) {
      const filePath = message.substring('[MEDIA:file]'.length);
      clearReaction();
      await sendDocument(filePath);
      markTypingDone();
      await recordOutgoing(`[sent a file: ${path.basename(filePath)}]`);
      console.log(`Sent file to ${chatId}`);
      return;
    }

    clearReaction();
    await sendText(message);
    markTypingDone();
    await recordOutgoing(message);
    console.log('Message sent successfully');

  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
