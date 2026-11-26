import { afterAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Telegraf, Telegram } from 'telegraf';

const fixture = vi.hoisted(() => ({ dir: '', sendToC4: vi.fn() }));
vi.mock('../src/lib/config.js', () => ({
  loadConfig: () => ({ owner: { chat_id: '123' }, features: { download_media: true }, groups: {} }),
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
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (fixture.dir) fs.rmSync(fixture.dir, { recursive: true, force: true });
});

it('forwards a private photo caption when all getFile attempts time out', async () => {
  fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-download-fallback-'));
  vi.stubEnv('HOME', fixture.dir);
  vi.useFakeTimers();

  let bot;
  vi.spyOn(Telegraf.prototype, 'launch').mockImplementation(async function () {
    bot = this;
    bot.botInfo = { id: 999, is_bot: true, username: 'fixturebot', first_name: 'Fixture' };
  });
  vi.spyOn(Telegraf.prototype, 'stop').mockImplementation(() => {});
  const getFile = vi.spyOn(Telegram.prototype, 'getFile').mockImplementation(() => new Promise(() => {}));
  const callApi = vi.spyOn(Telegram.prototype, 'callApi').mockResolvedValue({});
  const once = process.once.bind(process);
  const signalSpy = vi.spyOn(process, 'once').mockImplementation((event, listener) => {
    if (event === 'SIGTERM') shutdown = listener;
    else if (event !== 'SIGINT') return once(event, listener);
    return process;
  });
  await import('../src/bot.js');
  signalSpy.mockRestore();

  const caption = 'Here is the client log screenshot';
  const completed = bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      from: { id: 123, is_bot: false, first_name: 'Owner', username: 'owner' },
      chat: { id: 123, type: 'private', first_name: 'Owner' },
      photo: [{ file_id: 'photo-fixture', file_unique_id: 'unique', width: 10, height: 10 }],
      caption,
    },
  });

  await vi.advanceTimersByTimeAsync(46499);
  expect(getFile).toHaveBeenCalledTimes(3);
  expect(fixture.sendToC4).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  await completed;
  expect(fixture.sendToC4).toHaveBeenCalledExactlyOnceWith(
    'telegram', '123|msg:1|req:123:1', expect.any(String), expect.any(Function)
  );
  const [, , forwarded] = fixture.sendToC4.mock.calls[0];
  expect(forwarded).toContain(caption + '\n[photo could not be downloaded: getFile failed after 3 attempts');
  expect(forwarded).not.toContain(' ---- file: ');
  expect(callApi.mock.calls.filter(([method]) => method === 'sendMessage')).toEqual([
    ['sendMessage', expect.objectContaining({ chat_id: 123, text: 'Failed to download photo.' })],
  ]);
});
