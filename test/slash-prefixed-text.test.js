import { afterAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Telegraf, Telegram } from 'telegraf';

const fixture = vi.hoisted(() => ({ dir: '', sendToC4: vi.fn() }));
vi.mock('../src/lib/config.js', () => ({
  loadConfig: () => ({ owner: { chat_id: '123' }, groups: {} }),
  saveConfig: vi.fn(),
  getEnv: name => name === 'TELEGRAM_BOT_TOKEN' ? 'fixture-token' : '',
  get DATA_DIR() { return fixture.dir; },
}));
vi.mock('../src/lib/c4.js', () => ({ sendToC4: fixture.sendToC4 }));
vi.mock('http', () => ({
  default: { createServer: () => ({ on: vi.fn(), listen: vi.fn(), close: vi.fn() }) },
}));

let shutdown;
afterAll(() => {
  shutdown?.();
  vi.restoreAllMocks();
  if (fixture.dir) fs.rmSync(fixture.dir, { recursive: true, force: true });
});

it('records and forwards slash-prefixed DM text unless a bot command handles it', async () => {
  fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-slash-text-'));
  let bot;
  vi.spyOn(Telegraf.prototype, 'launch').mockImplementation(async function () {
    bot = this;
    bot.botInfo = { id: 999, is_bot: true, username: 'fixturebot', first_name: 'Fixture' };
  });
  vi.spyOn(Telegraf.prototype, 'stop').mockImplementation(() => {});
  const callApi = vi.spyOn(Telegram.prototype, 'callApi').mockResolvedValue({});
  const once = process.once.bind(process);
  const signalSpy = vi.spyOn(process, 'once').mockImplementation((event, listener) => {
    if (event === 'SIGTERM') shutdown = listener;
    else if (event !== 'SIGINT') return once(event, listener);
    return process;
  });
  await import('../src/bot.js');
  signalSpy.mockRestore();

  function receive(messageId, text, entities = []) {
    return bot.handleUpdate({
      update_id: messageId,
      message: {
        message_id: messageId,
        date: 1,
        from: { id: 123, is_bot: false, first_name: 'Owner', username: 'owner' },
        chat: { id: 123, type: 'private', first_name: 'Owner' },
        text,
        entities,
      },
    });
  }

  const usersPath = '/Users/example/Library/Application Support/demo/audit client logs';
  const tmpPath = '/tmp/demo/audit client logs';
  await receive(1, usersPath);
  await receive(2, tmpPath);
  await receive(3, '/start', [{ type: 'bot_command', offset: 0, length: 6 }]);

  const log = fs.readFileSync(path.join(fixture.dir, 'logs', '123.log'), 'utf8');
  expect(log.trim().split('\n').map(line => {
    const { message_id, text } = JSON.parse(line);
    return [message_id, text];
  })).toEqual([[1, usersPath], [2, tmpPath]]);
  expect(fixture.sendToC4.mock.calls.map(([channel, endpoint, message]) => [channel, endpoint, message]))
    .toEqual([
      ['telegram', '123|msg:1|req:123:1', expect.stringContaining(usersPath)],
      ['telegram', '123|msg:2|req:123:2', expect.stringContaining(tmpPath)],
    ]);
  expect(callApi.mock.calls.filter(([method]) => method === 'sendMessage')).toEqual([
    ['sendMessage', expect.objectContaining({ chat_id: 123, text: 'Bot is ready. Send me a message!' })],
  ]);
});
