/**
 * Build the C4 reply endpoint for an inbound Telegram message.
 * The endpoint carries reply routing (msg/req/thread) and, for real forum-topic
 * messages only, a `topic:<id>` key that session grouping reads. Older send.js
 * versions ignore the unknown `topic` key.
 */
import { getForumTopicId } from './session-group.js';

/**
 * @param {string|number} chatId
 * @param {object} [opts]
 * @param {number} [opts.messageId] - Trigger message ID
 * @param {number|string} [opts.threadId] - Message thread ID (reply routing)
 * @param {number|string} [opts.topicId] - Forum topic ID; set only for real forum-topic messages
 * @returns {string} e.g. "-100123|msg:67890|req:-100123:67890|thread:111|topic:111"
 */
export function buildEndpoint(chatId, { messageId, threadId, topicId } = {}) {
  let endpoint = String(chatId);
  const correlationId = messageId ? `${chatId}:${messageId}` : null;
  if (messageId) endpoint += `|msg:${messageId}`;
  if (correlationId) endpoint += `|req:${correlationId}`;
  if (threadId) endpoint += `|thread:${threadId}`;
  if (topicId) endpoint += `|topic:${topicId}`;
  return endpoint;
}

/**
 * Endpoint for the message in a Telegraf context.
 * @param {object} ctx - Telegraf context
 * @returns {string}
 */
export function endpointFromCtx(ctx) {
  const messageId = ctx.message?.message_id;
  return buildEndpoint(ctx.chat.id, {
    messageId,
    threadId: ctx.message?.message_thread_id || null,
    topicId: getForumTopicId(ctx),
  });
}
