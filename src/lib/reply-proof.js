import fs from 'node:fs';
import path from 'node:path';
import { isDmAllowed, isOwner } from './auth.js';
import { parseEndpoint, getHistoryKey, historyKeyToLogFile } from './utils.js';

const positiveId = value => typeof value === 'string' && /^[1-9]\d*$/.test(value);

// Scan backwards in blocks so old replies remain possible without loading the
// whole log into memory. Preserve partial UTF-8/JSON lines across block edges.
function findMessage(file, messageId) {
  const fd = fs.openSync(file, 'r');
  try {
    let position = fs.fstatSync(fd).size;
    let remainder = Buffer.alloc(0);
    while (position > 0) {
      const size = Math.min(position, 64 * 1024);
      position -= size;
      const block = Buffer.alloc(size);
      fs.readSync(fd, block, 0, size, position);
      const data = Buffer.concat([block, remainder]);
      let end = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 10) continue;
        const line = data.subarray(i + 1, end).toString('utf8');
        end = i;
        try {
          const entry = JSON.parse(line);
          if (String(entry?.message_id) === messageId) return entry;
        } catch { /* Ignore incomplete or malformed log records. */ }
      }
      remainder = data.subarray(0, end);
    }
    try {
      const entry = JSON.parse(remainder.toString('utf8'));
      if (String(entry?.message_id) === messageId) return entry;
    } catch { /* A damaged first record is not proof. */ }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Component-owned inbound logs prove the destination of exceptional replies. */
export function isAuthorizedReply(config, endpoint, logsDir) {
  try {
    const p = parseEndpoint(endpoint);
    if (!/^-?[1-9]\d*$/.test(p.chatId) || !positiveId(p.msg) ||
        (p.thread !== undefined && !positiveId(p.thread)) ||
        (p.req !== undefined && p.req !== `${p.chatId}:${p.msg}`)) return false;
    const thread = p.thread || null;
    const file = path.join(logsDir, historyKeyToLogFile(getHistoryKey(p.chatId, thread)));
    const entry = findMessage(file, p.msg);
    if (!entry || String(entry.thread_id ?? '') !== (thread || '') ||
        !positiveId(String(entry.user_id))) return false;
    const ctx = { chat: { id: p.chatId }, from: { id: String(entry.user_id),
      username: typeof entry.username === 'string' ? entry.username : undefined } };
    if (p.chatId.startsWith('-')) {
      return config.groupPolicy !== 'disabled' && isOwner(config, ctx);
    }
    return String(entry.user_id) === p.chatId && isDmAllowed(config, ctx);
  } catch {
    return false;
  }
}
