import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getForumTopicId, sessionGroupFromEndpoint } from '../src/lib/session-group.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'session-group.js');
// Core's in-group name rules (zylos-core comm-bridge c4-session-group.js).
const CORE_LOCAL = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

describe('session group from endpoint', () => {
  it.each([
    ['8101553026|msg:12|req:8101553026:12', 'dm-8101553026'],
    ['-123456|msg:7', 'group-123456'],
    ['-1001234567890|msg:5|req:-1001234567890:5', 'group-1001234567890'],
    // reply chain in an ordinary supergroup: thread id present but no topic marker
    ['-1001234567890|msg:5|thread:3', 'group-1001234567890'],
    ['-1001234567890|msg:5|thread:42|topic:42', 'group-1001234567890:topic-42'],
    // private chats never split by topic
    ['8101553026|msg:5|thread:9|topic:9', 'dm-8101553026'],
  ])('%s -> %s', (endpoint, group) => {
    expect(sessionGroupFromEndpoint(endpoint)).toBe(group);
  });

  it('stays within Core naming limits for the largest ids', () => {
    const group = sessionGroupFromEndpoint(`-${'9'.repeat(19)}|topic:${'9'.repeat(19)}`);
    expect(group).toMatch(CORE_LOCAL);
    expect(group.length).toBeLessThanOrEqual(95);
  });

  it.each(['', 'abc', '0', '-0', '12a|msg:1', '-100|topic:abc', '-100|topic:0', '-100|topic:-4'])(
    'rejects invalid endpoint %j', endpoint => {
      expect(() => sessionGroupFromEndpoint(endpoint)).toThrow();
    });
});

describe('forum topic detection', () => {
  const ctx = (chat, message) => ({ chat, message });
  it('uses only messages Telegram marks as forum-topic messages', () => {
    expect(getForumTopicId(ctx({ is_forum: true }, { is_topic_message: true, message_thread_id: 42 }))).toBe(42);
    // forum General area
    expect(getForumTopicId(ctx({ is_forum: true }, { message_id: 1 }))).toBeNull();
    // reply chain in a non-forum supergroup
    expect(getForumTopicId(ctx({ is_forum: false }, { message_thread_id: 3 }))).toBeNull();
    expect(getForumTopicId(ctx({}, { is_topic_message: true, message_thread_id: 3 }))).toBeNull();
  });
});

describe('scripts/session-group.js', () => {
  it('prints the group for a valid endpoint', () => {
    expect(execFileSync(process.execPath, [SCRIPT, '-100555|msg:1|thread:8|topic:8'], { encoding: 'utf8' }))
      .toBe('group-100555:topic-8\n');
  });
  it.each([[[]], [['bad']], [['-1', 'extra']]])('fails with no stdout for %j', args => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  });
});
