/**
 * Reply-target helpers.
 *
 * In a forum topic, Telegram sets `reply_to_message` on every message to the
 * topic's creation service message, even when the user did not reply to
 * anything. That message is not a real reply target: it has no text and must
 * not be quoted.
 */

/**
 * The message the user actually replied to, or null.
 * @param {object} msg - Telegram message
 * @returns {object|null}
 */
export function getReplyTarget(msg) {
  const reply = msg?.reply_to_message;
  if (!reply) return null;
  if (msg.is_topic_message && reply.message_id === msg.message_thread_id) return null;
  return reply;
}

/**
 * Quoted reply context for the agent. No API call needed: Telegram delivers
 * the replied-to message in the update payload.
 * @param {object} msg - Telegram message
 * @returns {{ sender: string, text: string }|null}
 */
export function getReplyToContext(msg) {
  const reply = getReplyTarget(msg);
  if (!reply) return null;
  return {
    sender: reply.from?.username || reply.from?.first_name || 'unknown',
    text: reply.text || reply.caption || '[media]'
  };
}
