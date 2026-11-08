import { describe, expect, it } from 'vitest';
import { getReplyTarget, getReplyToContext } from '../src/lib/reply.js';

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

describe('quoted reply context', () => {
  const inTopic = reply => ({ message_id: 60, message_thread_id: 42, is_topic_message: true, reply_to_message: reply });

  it('returns null for a direct post in a forum topic', () => {
    expect(getReplyToContext(inTopic(topicRoot))).toBeNull();
  });

  it('quotes the sender and text of a real reply', () => {
    expect(getReplyToContext(inTopic({ message_id: 50, from: { username: 'amy', first_name: 'Amy' }, text: 'hi' })))
      .toEqual({ sender: 'amy', text: 'hi' });
  });

  it('falls back to the caption, then to [media]', () => {
    const reply = extra => ({ message_id: 2, reply_to_message: { message_id: 1, from: { username: 'u' }, ...extra } });
    expect(getReplyToContext(reply({ caption: 'cap' })).text).toBe('cap');
    expect(getReplyToContext(reply({ photo: [{}] })).text).toBe('[media]');
  });

  it('falls back from username to first name to unknown', () => {
    const from = f => getReplyToContext({ message_id: 2, reply_to_message: { message_id: 1, from: f, text: 't' } }).sender;
    expect(from({ username: 'u', first_name: 'F' })).toBe('u');
    expect(from({ first_name: 'F' })).toBe('F');
    expect(from(undefined)).toBe('unknown');
  });

  it('returns null when the message is not a reply', () => {
    expect(getReplyToContext({ message_id: 2 })).toBeNull();
  });
});
