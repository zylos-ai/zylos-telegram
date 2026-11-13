import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ handlers: {}, signals: {}, config: null, dir: '', send: vi.fn(), api: vi.fn(), typing: vi.fn() }));
vi.mock('../src/lib/config.js', () => ({
  loadConfig: () => state.config, saveConfig: vi.fn(() => true),
  getEnv: name => name === 'TELEGRAM_BOT_TOKEN' ? 'fixture-token' : '',
  get DATA_DIR() { return state.dir; },
}));
vi.mock('../src/lib/c4.js', () => ({ sendToC4: (...args) => state.send(...args) }));
vi.mock('../src/lib/context.js', async importOriginal => ({
  ...await importOriginal(), ensureReplay: vi.fn(), getHistory: () => [], formatMessage: () => 'inbound',
}));
vi.mock('../src/lib/user-cache.js', () => ({ resolveUserName: () => 'alice', loadUserCache: vi.fn(), startPersistInterval: vi.fn(), persistUserCache: vi.fn() }));
vi.mock('../src/lib/media.js', () => ({ downloadPhoto: async () => '/fixture/photo', downloadDocument: async () => '/fixture/file', downloadVoice: vi.fn() }));
vi.mock('http', () => ({ default: { createServer: () => ({ on: vi.fn(), listen: vi.fn(), close: vi.fn() }) } }));
vi.mock('telegraf', () => ({ Telegraf: class {
  botInfo = { username: 'fixturebot' };
  telegram = {
    callApi: async (...args) => { state.api(...args); return {}; },
    sendChatAction: async (...args) => { state.typing(...args); return {}; },
    sendMessage: async () => ({}),
  };
  on(name, handler) { state.handlers[name] = handler; }
  start() {}
  catch() {}
  launch() { return Promise.resolve(); }
  stop() {}
} }));

beforeAll(async () => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-smart-reaction-'));
  vi.useFakeTimers();
  vi.spyOn(process, 'once').mockImplementation((signal, handler) => { state.signals[signal] = handler; return process; });
  state.config = { owner: { chat_id: '123' }, groups: {}, features: { download_media: true } };
  await import('../src/bot.js');
});
beforeEach(() => {
  vi.clearAllTimers();
  state.send.mockClear(); state.api.mockClear(); state.typing.mockClear();
  state.config = { owner: { chat_id: '123' }, groupPolicy: 'allowlist',
    groups: { '-101': { mode: 'smart' } }, features: { download_media: true } };
});
afterAll(() => {
  state.signals.SIGTERM?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(state.dir, { recursive: true, force: true });
});

function ctx({ mentioned = false, thread = null } = {}) {
  const text = mentioned ? '@fixturebot hello' : 'hello';
  return { from: { id: 123, username: 'owner' },
    chat: { id: -101, type: 'supergroup' },
    message: { message_id: 7, text, caption: text, message_thread_id: thread,
      entities: mentioned ? [{ type: 'mention', offset: 0, length: 11 }] : [],
      caption_entities: mentioned ? [{ type: 'mention', offset: 0, length: 11 }] : [],
      photo: [{ file_id: 'fixture' }], document: { file_id: 'fixture', file_name: 'fixture.txt' } },
    reply: vi.fn(async () => ({})) };
}

const reactions = () => state.api.mock.calls.filter(([method]) => method === 'setMessageReaction').map(([, p]) => p.reaction);
const EYES = [{ type: 'emoji', emoji: '👀' }];

describe('smart mode eyes reaction', () => {
  it.each(['text', 'photo', 'document'])('reacts to an unmentioned %s message without showing typing, clearing it after the 120s timeout', async handler => {
    await state.handlers[handler](ctx({ thread: 9 }));
    expect(state.send).toHaveBeenCalledOnce();
    expect(reactions()).toEqual([EYES]);
    expect(state.typing).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10000);
    expect(state.typing).not.toHaveBeenCalled();
    vi.advanceTimersByTime(110 * 1000);
    expect(reactions()).toEqual([EYES, []]);
  });

  it('clears the reaction after the 120s safety timeout if no reply or [SKIP] arrives', async () => {
    await state.handlers.text(ctx());
    vi.advanceTimersByTime(120 * 1000);
    expect(reactions()).toEqual([EYES, []]);
  });

  it('clears the reaction when C4 rejects the message', async () => {
    await state.handlers.text(ctx());
    state.send.mock.calls[0][3](null);
    expect(reactions()).toEqual([EYES, []]);
  });

  it('keeps reaction plus typing for a mentioned message', async () => {
    await state.handlers.text(ctx({ mentioned: true }));
    expect(reactions()).toEqual([EYES]);
    expect(state.typing).toHaveBeenCalledWith(-101, 'typing', {});
  });
});
