import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ handlers: {}, signals: {}, config: null, dir: '', send: vi.fn(), chatId: -200 }));
vi.mock('../src/lib/config.js', () => ({
  loadConfig: () => state.config, saveConfig: vi.fn(),
  getEnv: name => name === 'TELEGRAM_BOT_TOKEN' ? 'fixture-token' : '',
  get DATA_DIR() { return state.dir; },
}));
vi.mock('../src/lib/c4.js', () => ({ sendToC4: (...args) => state.send(...args) }));
vi.mock('../src/lib/user-cache.js', () => ({
  resolveUserName: user => user.username, loadUserCache: vi.fn(),
  startPersistInterval: vi.fn(), persistUserCache: vi.fn(),
}));
vi.mock('../src/lib/media.js', () => ({ downloadPhoto: vi.fn(), downloadDocument: vi.fn(), downloadVoice: vi.fn() }));
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

let getHistory;
beforeAll(async () => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sender-'));
  vi.stubEnv('HOME', state.dir);
  vi.stubEnv('ZYLOS_DIR', state.dir);
  vi.stubEnv('PM2_HOME', path.join(state.dir, 'pm2'));
  vi.stubEnv('TMPDIR', state.dir);
  fs.mkdirSync(path.join(state.dir, '.zylos'));
  vi.useFakeTimers();
  vi.spyOn(process, 'once').mockImplementation((signal, handler) => { state.signals[signal] = handler; return process; });
  state.config = { groups: {} };
  await import('../src/bot.js');
  ({ getHistory } = await import('../src/lib/context.js'));
});
beforeEach(() => {
  state.signals.SIGTERM?.();
  state.send.mockClear();
  state.chatId--;
  fs.writeFileSync(path.join(state.dir, '.zylos/config.json'), JSON.stringify({ session_mode: 'single' }));
  state.config = { owner: { chat_id: '123' }, groupPolicy: 'allowlist',
    groups: { [state.chatId]: { mode: 'smart', allowFrom: ['456'] } } };
});
afterAll(() => {
  state.signals.SIGTERM?.();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(state.dir, { recursive: true, force: true });
});

function ctx({ sender = 789, mentioned = false, messageId = 7 } = {}) {
  return { from: { id: sender, username: `user${sender}` },
    chat: { id: state.chatId, type: 'supergroup', title: 'Fixture group' },
    message: { message_id: messageId, text: mentioned ? '@fixturebot hello' : 'hello',
      entities: mentioned ? [{ type: 'mention', offset: 0, length: 11 }] : [] },
    reply: vi.fn(async () => ({})) };
}
const denial = "Sorry, you don't have permission to interact with me in this group.";

function expectRecorded(message) {
  const entries = fs.readFileSync(path.join(state.dir, 'logs', `${state.chatId}.log`), 'utf8').trim().split('\n').map(JSON.parse);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ message_id: 7, user_id: message.from.id, text: message.message.text });
  expect(getHistory(String(state.chatId))).toHaveLength(1);
  expect(getHistory(String(state.chatId))[0]).toMatchObject({ message_id: 7, user_id: message.from.id });
}

describe('group sender authorization', () => {
  it.each(['single', 'multi'])('silently records an unmentioned disallowed sender and preserves context in %s session mode', mode => {
    fs.writeFileSync(path.join(state.dir, '.zylos/config.json'), JSON.stringify({ session_mode: mode }));
    const message = ctx();
    state.handlers.text(message);
    expect(message.reply).not.toHaveBeenCalled();
    expect(state.send).not.toHaveBeenCalled();
    expectRecorded(message);
    state.handlers.text(ctx({ sender: 456, messageId: 8 }));
    expect(state.send).toHaveBeenCalledOnce();
    expect(state.send.mock.calls[0][2]).toContain('user789');
  });

  it.each(['smart', 'mention'])('rejects an addressed disallowed sender in %s mode', mode => {
    state.config.groups[state.chatId].mode = mode;
    const message = ctx({ mentioned: true });
    state.handlers.text(message);
    expect(message.reply).toHaveBeenCalledExactlyOnceWith(denial);
    expect(state.send).not.toHaveBeenCalled();
    expectRecorded(message);
  });

  it('forwards an unmentioned allowed sender in smart mode', () => {
    const message = ctx({ sender: 456 });
    state.handlers.text(message);
    expect(message.reply).not.toHaveBeenCalled();
    expect(state.send).toHaveBeenCalledOnce();
    expect(state.send.mock.calls[0][1]).toContain(`${state.chatId}|msg:7`);
    expectRecorded(message);
  });

  it('keeps unmentioned messages silent in mention mode', () => {
    state.config.groups[state.chatId].mode = 'mention';
    const message = ctx();
    state.handlers.text(message);
    expect(message.reply).not.toHaveBeenCalled();
    expect(state.send).not.toHaveBeenCalled();
    expectRecorded(message);
  });

  it.each([
    ['smart', false, true], ['smart', true, true],
    ['mention', true, true], ['mention', false, false],
  ])('preserves owner forwarding in %s mode with mentioned=%s', (mode, mentioned, forwarded) => {
    state.config.groups[state.chatId].mode = mode;
    const message = ctx({ sender: 123, mentioned });
    state.handlers.text(message);
    expect(message.reply).not.toHaveBeenCalled();
    expect(state.send).toHaveBeenCalledTimes(forwarded ? 1 : 0);
    expectRecorded(message);
  });
});
