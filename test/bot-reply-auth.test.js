import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAuthorizedReply } from '../src/lib/reply-proof.js';

const state = vi.hoisted(() => ({ handlers: {}, signals: {}, config: null, dir: '', send: vi.fn() }));
vi.mock('../src/lib/config.js', () => ({
  loadConfig: () => state.config, saveConfig: vi.fn(() => true),
  getEnv: name => name === 'TELEGRAM_BOT_TOKEN' ? 'fixture-token' : '',
  get DATA_DIR() { return state.dir; },
}));
vi.mock('../src/lib/c4.js', () => ({ sendToC4: (...args) => state.send(...args) }));
vi.mock('../src/lib/context.js', async importOriginal => ({
  ...await importOriginal(), ensureReplay: vi.fn(), getHistory: () => [], formatMessage: () => 'inbound',
}));
vi.mock('../src/lib/user-cache.js', () => ({ resolveUserName: () => 'misleading-display-name', loadUserCache: vi.fn(), startPersistInterval: vi.fn(), persistUserCache: vi.fn() }));
vi.mock('../src/lib/media.js', () => ({ downloadPhoto: async () => '/fixture/photo', downloadDocument: async () => '/fixture/file', downloadVoice: vi.fn() }));
vi.mock('http', () => ({ default: { createServer: () => ({ on: vi.fn(), listen: vi.fn(), close: vi.fn() }) } }));
vi.mock('telegraf', () => ({ Telegraf: class {
  botInfo = { username: 'fixturebot' };
  telegram = { callApi: async () => ({}), sendChatAction: async () => ({}), sendMessage: async () => ({}) };
  on(name, handler) { state.handlers[name] = handler; }
  start() {}
  catch() {}
  launch() { return Promise.resolve(); }
  stop() {}
} }));

beforeAll(async () => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bot-reply-'));
  vi.useFakeTimers();
  vi.spyOn(process, 'once').mockImplementation((signal, handler) => { state.signals[signal] = handler; return process; });
  state.config = { owner: { chat_id: '123' }, groups: {}, features: { download_media: true } };
  await import('../src/bot.js');
});
beforeEach(() => {
  state.send.mockClear();
  for (const file of fs.readdirSync(path.join(state.dir, 'logs'))) fs.unlinkSync(path.join(state.dir, 'logs', file));
  state.config = { owner: { chat_id: '123' }, dmPolicy: 'allowlist', dmAllowFrom: ['@alice'],
    groupPolicy: 'allowlist', groups: {}, features: { download_media: true } };
});
afterAll(() => {
  state.signals.SIGTERM?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(state.dir, { recursive: true, force: true });
});

function ctx({ owner = true, mentioned = true, privateChat = false, thread = null } = {}) {
  return { from: { id: owner ? 123 : 456, username: owner ? 'owner' : 'alice' },
    chat: { id: privateChat ? (owner ? 123 : 456) : -101, type: privateChat ? 'private' : 'supergroup' },
    message: { message_id: 7, text: mentioned ? '@fixturebot hello' : 'hello', message_thread_id: thread,
      entities: mentioned ? [{ type: 'mention', offset: 0, length: 11 }] : [], photo: [{ file_id: 'fixture' }],
      document: { file_id: 'fixture', file_name: 'fixture.txt' } },
    reply: vi.fn(async () => ({})) };
}

function proof() {
  return isAuthorizedReply(state.config, state.send.mock.calls[0][1], path.join(state.dir, 'logs'));
}

describe('real inbound handlers record exceptional reply proof', () => {
  it('logs an accepted owner mention and keeps the original endpoint format', () => {
    state.handlers.text(ctx());
    expect(state.send).toHaveBeenCalledOnce();
    expect(state.send.mock.calls[0][1]).toBe('-101|msg:7|req:-101:7');
    expect(proof()).toBe(true);
    expect(state.config.groups).toEqual({});
  });

  it.each([
    ['non-owner mention', { owner: false }, 'allowlist'],
    ['owner without mention', { mentioned: false }, 'allowlist'],
    ['disabled group', {}, 'disabled'],
  ])('does not dispatch or record proof for %s', (_label, options, policy) => {
    state.config.groupPolicy = policy;
    state.handlers.text(ctx(options));
    expect(state.send).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.join(state.dir, 'logs'))).toEqual([]);
  });

  it.each([null, 9])('records actual username and preserves private text thread %s', thread => {
    state.handlers.text(ctx({ privateChat: true, owner: false, mentioned: false, thread }));
    expect(state.send).toHaveBeenCalledOnce();
    expect(state.send.mock.calls[0][1]).toBe(`456|msg:7|req:456:7${thread ? '|thread:9' : ''}`);
    expect(proof()).toBe(true);
    const entry = JSON.parse(fs.readFileSync(path.join(state.dir, 'logs', thread ? '456_t_9.log' : '456.log'), 'utf8').trim());
    expect(entry).toMatchObject({ username: 'alice', user_name: 'misleading-display-name', thread_id: thread });
    state.config.dmAllowFrom = [];
    expect(proof()).toBe(false);
  });

  it.each(['photo', 'document'])('records accepted private %s messages with their topic and username', async handler => {
    await state.handlers[handler](ctx({ privateChat: true, owner: false, mentioned: false, thread: 9 }));
    expect(state.send).toHaveBeenCalledOnce();
    expect(state.send.mock.calls[0][1]).toBe('456|msg:7|req:456:7|thread:9');
    expect(proof()).toBe(true);
  });
});
