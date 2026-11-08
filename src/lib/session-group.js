/**
 * Session-group mapping for zylos-core multi-session mode.
 *
 * The group name is derived only from the reply endpoint, so the inbound
 * `--session-group` value and `scripts/session-group.js <endpoint>` always
 * agree. Rules (fixed once live; changing them needs a migration):
 *   private chat                     -> dm-<chat id>                 e.g. dm-8101553026
 *   group / supergroup               -> group<chat id>               e.g. group-1001234567890
 *   forum topic in a supergroup      -> group<chat id>:topic-<id>    e.g. group-1001234567890:topic-42
 * Only messages Telegram marks as forum-topic messages carry a topic; reply
 * chains in ordinary groups and the forum "General" area map to the group.
 * The component never adds a namespace; Core does.
 */
import { parseEndpoint } from './utils.js';

const CHAT_ID = /^-?[1-9]\d*$/;
const TOPIC_ID = /^[1-9]\d*$/;

/**
 * Topic id for endpoint building: set only for real forum-topic messages.
 * @param {object} ctx - Telegraf context
 * @returns {number|null}
 */
export function getForumTopicId(ctx) {
  const msg = ctx?.message;
  if (!ctx?.chat?.is_forum || !msg?.is_topic_message || !msg.message_thread_id) return null;
  return msg.message_thread_id;
}

/**
 * Derive the in-group session name from an endpoint string.
 * @param {string} endpoint - e.g. "-100123|msg:5|thread:42|topic:42"
 * @returns {string} group name
 * @throws {Error} when the endpoint has no valid Telegram chat id
 */
export function sessionGroupFromEndpoint(endpoint) {
  const parsed = parseEndpoint(endpoint);
  const chatId = String(parsed.chatId ?? '').trim();
  if (!CHAT_ID.test(chatId)) {
    throw new Error(`invalid Telegram endpoint: ${JSON.stringify(String(endpoint ?? '').slice(0, 64))}`);
  }
  // Telegram users (private chats) have positive ids; groups and supergroups negative.
  if (!chatId.startsWith('-')) return `dm-${chatId}`;
  const topic = parsed.topic;
  if (topic !== undefined && !TOPIC_ID.test(topic)) {
    throw new Error(`invalid topic id in endpoint: ${JSON.stringify(topic.slice(0, 32))}`);
  }
  return topic ? `group${chatId}:topic-${topic}` : `group${chatId}`;
}
