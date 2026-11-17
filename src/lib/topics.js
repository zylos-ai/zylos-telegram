import fs from 'node:fs';
import path from 'node:path';
import { isGroupAllowed } from './auth.js';

export const TOPIC_EVENTS = ['forum_topic_created', 'forum_topic_edited', 'forum_topic_closed', 'forum_topic_reopened'];

function validate(record) {
  if (!record || !/^-[1-9]\d*$/.test(String(record.chat_id)) ||
      !Number.isSafeInteger(record.topic_id) || record.topic_id < 1 ||
      ![null, 'open', 'closed'].includes(record.state) ||
      !(record.name === null || typeof record.name === 'string') ||
      typeof record.updated_at !== 'string' || !Number.isFinite(Date.parse(record.updated_at)) ||
      !(record.actor === null || (typeof record.actor === 'object' && record.actor.id != null))) {
    throw new Error('Invalid topic record: expected chat_id, topic_id, name, state, updated_at and actor');
  }
}

// One append per batch keeps independent bot/CLI writers from replacing each
// other's snapshots. The journal is preserved by the existing data/ lifecycle.
export function appendTopics(dataDir, records) {
  records.forEach(validate);
  const file = path.join(dataDir, 'data', 'topics.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 });
}

export function listTopics(dataDir, chatId, state) {
  let text;
  try { text = fs.readFileSync(path.join(dataDir, 'data', 'topics.jsonl'), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { topics: [], warning: 'Topic history is missing; past events cannot be recovered. Import a human-provided list.' };
    throw error;
  }
  const topics = new Map();
  try {
    const records = text.split('\n').filter(Boolean).map(line => {
      const record = JSON.parse(line); validate(record); return record;
    }).sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
    for (const record of records) {
      const key = `${record.chat_id}:${record.topic_id}`;
      const previous = topics.get(key);
      // Replay in event time, preserving known fields on partial service events.
      topics.set(key, { ...record, chat_id: String(record.chat_id),
        name: record.name ?? previous?.name ?? null, state: record.state ?? previous?.state ?? null });
    }
  } catch { throw new Error('Topic history is corrupt; results are unavailable. Preserve data/topics.jsonl and repair it before querying.'); }
  return { topics: [...topics.values()].filter(topic =>
    (!chatId || topic.chat_id === String(chatId)) && (!state || topic.state === state)) };
}

export function recordTopicMessage(config, message, dataDir) {
  if (!TOPIC_EVENTS.some(event => message?.[event])) return false;
  if (!['group', 'supergroup'].includes(message.chat?.type) || !isGroupAllowed(config, message.chat.id)) return true;
  const created = message.forum_topic_created;
  appendTopics(dataDir, [{ chat_id: String(message.chat.id), topic_id: message.message_thread_id || 1,
    name: created?.name ?? message.forum_topic_edited?.name ?? null,
    state: message.forum_topic_closed ? 'closed' : (created || message.forum_topic_reopened ? 'open' : null),
    updated_at: new Date(message.date * 1000).toISOString(), actor: message.sender_chat || message.from || null }]);
  return true;
}

export function registerTopicHandlers(bot, getConfig, dataDir, onError = console.error) {
  for (const event of TOPIC_EVENTS) bot.on(event, ctx => {
    try { recordTopicMessage(getConfig(), ctx.message, dataDir); }
    catch (error) { onError('[telegram] Failed to record topic event:', error.message); }
  });
}

export async function changeTopicState(config, telegram, dataDir, chatId, topicId, action) {
  if (!['close', 'reopen'].includes(action)) throw new Error('Expected close or reopen');
  if (!/^-[1-9]\d*$/.test(String(chatId)) || !isGroupAllowed(config, chatId)) throw new Error('Topic group is not allowed');
  if (!Number.isSafeInteger(topicId) || topicId < 1) throw new Error('Expected a positive topic ID');
  const actor = await telegram.getMe();
  const method = topicId === 1
    ? (action === 'close' ? 'closeGeneralForumTopic' : 'reopenGeneralForumTopic')
    : (action === 'close' ? 'closeForumTopic' : 'reopenForumTopic');
  await telegram.callApi(method, { chat_id: chatId, ...(topicId === 1 ? {} : { message_thread_id: topicId }) });
  const record = { chat_id: String(chatId), topic_id: topicId, name: null,
    state: action === 'close' ? 'closed' : 'open', updated_at: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(), actor };
  try { appendTopics(dataDir, [record]); }
  catch { throw new Error('Telegram operation succeeded, but topic history could not be saved; check storage and the service update before retrying.'); }
  return record;
}
