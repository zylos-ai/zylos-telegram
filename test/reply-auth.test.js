import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAuthorizedReply } from '../src/lib/reply-proof.js';

let logsDir;
const config = () => ({ owner: { chat_id: '123' }, dmPolicy: 'allowlist', dmAllowFrom: ['@alice'], groupPolicy: 'allowlist', groups: {} });
const groupEndpoint = '-101|msg:7|req:-101:7|thread:9';
const groupEntry = () => ({ message_id: 7, user_id: 123, thread_id: 9, text: 'hello' });
const dmEntry = () => ({ message_id: 7, user_id: 456, username: 'alice', user_name: 'Display name', thread_id: null });

beforeEach(() => { logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-reply-proof-')); });
afterEach(() => { fs.rmSync(logsDir, { recursive: true, force: true }); });

function log(file, ...entries) {
  fs.writeFileSync(path.join(logsDir, file), entries.map(entry => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n') + '\n');
}
const allowed = (endpoint = groupEndpoint, cfg = config()) => isAuthorizedReply(cfg, endpoint, logsDir);

describe('component message-log proof for exceptional replies', () => {
  it('allows the current owner in an unlisted group without adding group access', () => {
    log('-101_t_9.log', groupEntry());
    const cfg = config();
    expect(allowed(groupEndpoint, cfg)).toBe(true);
    expect(cfg.groups).toEqual({});
  });

  it('accepts old logged messages and legacy endpoints without a request key', () => {
    log('-101_t_9.log', { ...groupEntry(), timestamp: '2020-01-01T00:00:00.000Z' });
    expect(allowed('-101|msg:7|thread:9')).toBe(true);
  });

  it.each([
    ['target', '-102|msg:7|thread:9'],
    ['message', '-101|msg:8|thread:9'],
    ['request', '-101|msg:7|req:-101:8|thread:9'],
    ['thread', '-101|msg:7|thread:10'],
    ['missing message', '-101|thread:9'],
    ['missing thread', '-101|msg:7'],
    ['non-numeric target', '../-101|msg:7|thread:9'],
    ['invalid message', '-101|msg:0|thread:9'],
    ['invalid thread', '-101|msg:7|thread:../9'],
  ])('rejects a different or invalid %s', (_label, endpoint) => {
    log('-101_t_9.log', groupEntry());
    expect(allowed(endpoint)).toBe(false);
  });

  it('checks thread identity inside the selected log', () => {
    log('-101_t_9.log', { ...groupEntry(), thread_id: 10 });
    expect(allowed()).toBe(false);
  });

  it('rechecks current owner and disabled group policy', () => {
    log('-101_t_9.log', groupEntry());
    const cfg = config();
    cfg.owner.chat_id = '999';
    expect(allowed(groupEndpoint, cfg)).toBe(false);
    cfg.owner.chat_id = '123';
    cfg.groupPolicy = 'disabled';
    expect(allowed(groupEndpoint, cfg)).toBe(false);
  });

  it('rejects another sender and outgoing bot history', () => {
    log('-101_t_9.log', { ...groupEntry(), user_id: 999 }, { ...groupEntry(), message_id: 'bot:7', user_id: 'bot' });
    expect(allowed()).toBe(false);
  });

  it('uses the recorded username and current DM policy', () => {
    log('456.log', dmEntry());
    const cfg = config();
    expect(allowed('456|msg:7', cfg)).toBe(true);
    cfg.dmAllowFrom = [];
    expect(allowed('456|msg:7', cfg)).toBe(false);
    cfg.dmAllowFrom = ['@alice'];
    cfg.dmPolicy = 'owner';
    expect(allowed('456|msg:7', cfg)).toBe(false);
  });

  it('preserves legacy username allowlists and case-insensitive matching', () => {
    log('456.log', { ...dmEntry(), username: 'ALICE' });
    const cfg = config();
    cfg.dmAllowFrom = [];
    cfg.whitelist = { usernames: ['alice'] };
    expect(allowed('456|msg:7', cfg)).toBe(true);
  });

  it.each([undefined, null, 'mallory'])('never treats a display name as username when username is %s', username => {
    log('456.log', { ...dmEntry(), username, user_name: 'alice' });
    expect(allowed('456|msg:7')).toBe(false);
  });

  it('requires the DM sender to match the destination', () => {
    log('456.log', { ...dmEntry(), user_id: 789 });
    expect(allowed('456|msg:7')).toBe(false);
  });

  it('supports topic DMs without reading another topic', () => {
    log('456_t_9.log', { ...dmEntry(), thread_id: 9 });
    expect(allowed('456|msg:7|thread:9')).toBe(true);
    expect(allowed('456|msg:7')).toBe(false);
    expect(allowed('456|msg:7|thread:10')).toBe(false);
  });

  it('finds older entries across reverse-read blocks and tolerates malformed lines', () => {
    log('-101_t_9.log', 'broken JSON', groupEntry(),
      { ...groupEntry(), message_id: 8, text: '中文'.repeat(12000) }, '{incomplete');
    expect(allowed()).toBe(true);
  });

  it('preserves a matching JSON record split across UTF-8 block boundaries', () => {
    log('-101_t_9.log', { ...groupEntry(), text: '中文'.repeat(25000) }, { ...groupEntry(), message_id: 8 });
    expect(allowed()).toBe(true);
  });

  it('reads a final complete record without a trailing newline', () => {
    fs.writeFileSync(path.join(logsDir, '-101_t_9.log'), JSON.stringify(groupEntry()));
    expect(allowed()).toBe(true);
  });

  it('denies missing, deleted, malformed, or unreadable logs', () => {
    expect(allowed()).toBe(false);
    log('-101_t_9.log', '{broken');
    expect(allowed()).toBe(false);
    fs.unlinkSync(path.join(logsDir, '-101_t_9.log'));
    fs.mkdirSync(path.join(logsDir, '-101_t_9.log'));
    expect(allowed()).toBe(false);
  });
});
