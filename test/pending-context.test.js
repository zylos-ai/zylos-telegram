import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let root, pending, context, configFile;
const config = { groups: { '-101': { historyLimit: 2 } } };
const entry = (id, text = `message ${id}`) => ({ message_id: id, user_id: 123, user_name: 'alice', text, thread_id: null });
const key = 'group-101';
const mode = value => fs.writeFileSync(configFile, JSON.stringify({ session_mode: value }));

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pending-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('ZYLOS_DIR', path.join(root, 'zylos'));
  configFile = path.join(root, 'zylos/.zylos/config.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  mode('multi');
  vi.resetModules();
  pending = await import('../src/lib/pending-context.js');
  context = await import('../src/lib/context.js');
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

function record(id, text) {
  const message = entry(id, text);
  context.logAndRecord('-101', message, config, key);
  return message.contextSequence;
}

describe('pending group context', () => {
  it('counts all omitted messages while retaining only a bounded tail and truncating each text', () => {
    let sequence;
    for (let id = 1; id <= 10; id++) sequence = record(id, id === 9 ? 'x'.repeat(700) : undefined);
    const snapshot = pending.pendingContext(key, 10, 2, sequence);
    expect(snapshot.contextMessages.map(m => m.message_id)).toEqual([8, 9]);
    expect(snapshot.contextMessages[1].text).toHaveLength(500);
    expect(snapshot.omittedContextCount).toBe(7);
    const stored = JSON.parse(fs.readFileSync(path.join(root, 'zylos/components/telegram/data/context/group-101.log.json')));
    expect(stored.entries).toHaveLength(3);
  });

  it('excludes own replies and acknowledges only the snapshot, retaining arrivals during delivery', () => {
    record(1); const sequence = record(2);
    context.logAndRecord('-101', { ...entry('bot:answer'), user_id: 'bot' }, config);
    const snapshot = pending.pendingContext(key, 2, 2, sequence);
    expect(snapshot.contextMessages.map(m => m.message_id)).toEqual([1]);
    record(3);
    pending.acknowledgeContext(key, snapshot);
    const nextSequence = record(4);
    expect(pending.pendingContext(key, 4, 2, nextSequence).contextMessages.map(m => m.message_id)).toEqual([3]);
  });

  it('keeps pending counts and acknowledged progress after a module restart without replaying seen logs', async () => {
    record(1); const sequence = record(2);
    pending.acknowledgeContext(key, pending.pendingContext(key, 2, 2, sequence));
    record(3); record(4); record(5); const nextSequence = record(6);
    vi.resetModules();
    pending = await import('../src/lib/pending-context.js');
    context = await import('../src/lib/context.js');
    context.ensureReplay('-101', config);
    const snapshot = pending.pendingContext(key, 6, 2, nextSequence);
    expect(snapshot.contextMessages.map(m => m.message_id)).toEqual([4, 5]);
    expect(snapshot.omittedContextCount).toBe(1);
  });

  it('keeps the original boundary when later chatter evicts a downloading media entry', () => {
    const media = entry(1);
    context.logAndRecord('-101', media, config, key);
    for (let id = 2; id <= 8; id++) record(id);
    const snapshot = pending.pendingContext(key, 1, 2, media.contextSequence);
    expect(snapshot.contextMessages).toEqual([]);
    expect(snapshot.omittedContextCount).toBe(0);
    pending.acknowledgeContext(key, snapshot);
    const sequence = record(9);
    const next = pending.pendingContext(key, 9, 2, sequence);
    expect(next.contextMessages.map(m => m.message_id)).toEqual([7, 8]);
    expect(next.omittedContextCount).toBe(5);
  });

  it('does not rewind progress when a media message is dispatched after a later mention', () => {
    const media = entry(1);
    context.logAndRecord('-101', media, config, key);
    let sequence;
    for (let id = 2; id <= 6; id++) sequence = record(id);
    pending.acknowledgeContext(key, pending.pendingContext(key, 6, 2, sequence));
    const delayed = pending.pendingContext(key, 1, 2, media.contextSequence);
    expect(delayed.contextMessages).toEqual([]);
    expect(delayed.omittedContextCount).toBe(0);
    pending.acknowledgeContext(key, delayed);
    for (let id = 7; id <= 12; id++) sequence = record(id);
    const next = pending.pendingContext(key, 12, 2, sequence);
    expect(next.contextMessages.map(m => m.message_id)).toEqual([10, 11]);
    expect(next.omittedContextCount).toBe(3);
  });

  it('isolates session keys and ignores private history', () => {
    record(1);
    const topicKey = 'group-101:topic-9';
    pending.recordPending(topicKey, entry(2), 2);
    expect(pending.recordPending('dm-123', entry(3), 2)).toBeUndefined();
    const groupSequence = record(9);
    const topicSequence = pending.recordPending(topicKey, entry(9), 2);
    expect(pending.pendingContext(key, 9, 2, groupSequence).contextMessages.map(m => m.message_id)).toEqual([1]);
    expect(pending.pendingContext(topicKey, 9, 2, topicSequence).contextMessages.map(m => m.message_id)).toEqual([2]);
  });

  it.each(['single', 'dual', null, 1])('uses legacy behavior for mode %j even with session-group support advertised', value => {
    mode(value);
    const scripts = path.join(root, 'zylos/.claude/skills/comm-bridge/scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'c4-receive-options.json'), JSON.stringify({ options: { '--session-group': {} } }));
    expect(pending.isMultiSession()).toBe(false);
    expect(record(1)).toBeUndefined();
  });

  it('uses legacy behavior when mode is absent, unreadable, or invalid JSON', () => {
    for (const content of ['{}', '{']) {
      fs.writeFileSync(configFile, content);
      expect(pending.isMultiSession()).toBe(false);
    }
    fs.unlinkSync(configFile);
    expect(pending.isMultiSession()).toBe(false);
    fs.mkdirSync(configFile);
    expect(pending.isMultiSession()).toBe(false);
  });
});
