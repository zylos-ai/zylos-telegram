import { describe, expect, it } from 'vitest';
import { getReplyTarget } from '../src/lib/reply.js';

const topicRoot = { message_id: 42, from: { id: 1 }, forum_topic_created: { name: 'A' } };

describe('reply target', () => {
  it('ignores the topic creation message on a direct post in a forum topic', () => {
    const msg = { message_id: 43, message_thread_id: 42, is_topic_message: true, reply_to_message: topicRoot };
    expect(getReplyTarget(msg)).toBeNull();
  });

  it('keeps a real reply inside a forum topic', () => {
    const target = { message_id: 50, from: { id: 7 }, text: 'hi' };
    const msg = { message_id: 51, message_thread_id: 42, is_topic_message: true, reply_to_message: target };
    expect(getReplyTarget(msg)).toBe(target);
  });

  it('keeps a reply in an ordinary supergroup reply chain', () => {
    // thread id equals the replied message, but this is not a forum topic
    const target = { message_id: 11, from: { id: 7 }, text: 'ok' };
    expect(getReplyTarget({ message_id: 12, message_thread_id: 11, reply_to_message: target })).toBe(target);
  });

  it('returns null when the message is not a reply', () => {
    expect(getReplyTarget({ message_id: 2 })).toBeNull();
  });
});
