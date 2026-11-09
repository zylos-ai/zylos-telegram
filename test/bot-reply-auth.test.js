import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAuthorizedReply } from '../src/lib/reply-auth.js';

const state = vi.hoisted(() => ({ handlers: {}, signals: {}, config: null, dir: '', send: vi.fn() }));
vi.mock('../src/lib/config.js', () => ({
  loadConfig: () => state.config, saveConfig: vi.fn(() => true),
  getEnv: name => name === 'TELEGRAM_BOT_TOKEN' ? 'fixture-token' : '',
  get DATA_DIR() { return state.dir; },
}));
vi.mock('../src/lib/c4.js', () => ({ sendToC4: (...args) => state.send(...args) }));
vi.mock('../src/lib/context.js', () => ({ logAndRecord: vi.fn(), ensureReplay: vi.fn(), getHistory: () => [], formatMessage: () => 'inbound' }));
vi.mock('../src/lib/user-cache.js', () => ({ resolveUserName: () => 'fixture', loadUserCache: vi.fn(), startPersistInterval: vi.fn(), persistUserCache: vi.fn() }));
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
  state.config = { owner: { chat_id: '123' }, dmPolicy: 'allowlist', dmAllowFrom: ['@alice'],
    groupPolicy: 'allowlist', groups: {}, features: { download_media: true } };
});
afterAll(() => {
  state.signals.SIGTERM?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(state.dir, { recursive: true, force: true });
});

function ctx({ owner = true, mentioned = true, privateChat = false } = {}) {
  return { from: { id: owner ? 123 : 456, username: owner ? 'owner' : 'alice' },
    chat: { id: privateChat ? (owner ? 123 : 456) : -101, type: privateChat ? 'private' : 'supergroup' },
    message: { message_id: 7, text: mentioned ? '@fixturebot hello' : 'hello',
      entities: mentioned ? [{ type: 'mention', offset: 0, length: 11 }] : [], photo: [{ file_id: 'fixture' }] },
    reply: vi.fn(async () => ({})) };
}

describe('real inbound handlers attach reply authorization', () => {
  it('signs an owner text mention in an unlisted group', () => {
    state.handlers.text(ctx());
    expect(state.send).toHaveBeenCalledOnce();
    const endpoint = state.send.mock.calls[0][1];
    expect(isAuthorizedReply(state.config, endpoint, 'fixture-token')).toBe(true);
    expect(state.config.groups).toEqual({});
  });

  it.each([
    ['non-owner mention', { owner: false }, 'allowlist'],
    ['owner without mention', { mentioned: false }, 'allowlist'],
    ['disabled group', {}, 'disabled'],
  ])('does not dispatch %s', (_label, options, policy) => {
    state.config.groupPolicy = policy;
    state.handlers.text(ctx(options));
    expect(state.send).not.toHaveBeenCalled();
  });

  it('signs username-only accepted private text messages', () => {
    state.handlers.text(ctx({ privateChat: true, owner: false, mentioned: false }));
    expect(state.send).toHaveBeenCalledOnce();
    expect(isAuthorizedReply(state.config, state.send.mock.calls[0][1], 'fixture-token')).toBe(true);
  });

  it('signs accepted private media messages', async () => {
    await state.handlers.photo(ctx({ privateChat: true, owner: false, mentioned: false }));
    expect(state.send).toHaveBeenCalledOnce();
    expect(isAuthorizedReply(state.config, state.send.mock.calls[0][1], 'fixture-token')).toBe(true);
  });
});
