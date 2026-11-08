import { describe, expect, it } from 'vitest';
import { endpointFromCtx } from '../src/lib/endpoint.js';
import { sessionGroupFromEndpoint } from '../src/lib/session-group.js';

const ctx = (chat, message) => ({ chat, message: { message_id: 5, ...message } });

describe('endpoint from a Telegram message', () => {
  it.each([
    ['forum topic message',
      ctx({ id: -100777, is_forum: true }, { message_thread_id: 42, is_topic_message: true }),
      '-100777|msg:5|req:-100777:5|thread:42|topic:42', 'group-100777:topic-42'],
    ['reply in the forum General area',
      ctx({ id: -100777, is_forum: true }, { message_thread_id: 3 }),
      '-100777|msg:5|req:-100777:5|thread:3', 'group-100777'],
    ['reply chain in an ordinary supergroup',
      ctx({ id: -100888 }, { message_thread_id: 3 }),
      '-100888|msg:5|req:-100888:5|thread:3', 'group-100888'],
    ['private chat',
      ctx({ id: 8101553026 }, {}),
      '8101553026|msg:5|req:8101553026:5', 'dm-8101553026'],
  ])('%s', (_name, c, endpoint, group) => {
    expect(endpointFromCtx(c)).toBe(endpoint);
    expect(sessionGroupFromEndpoint(endpointFromCtx(c))).toBe(group);
  });

  it('keeps only chat and message for the private text path', () => {
    const c = ctx({ id: 8101553026, is_forum: true }, { message_thread_id: 9, is_topic_message: true });
    expect(endpointFromCtx(c, { withThread: false })).toBe('8101553026|msg:5|req:8101553026:5');
  });
});
