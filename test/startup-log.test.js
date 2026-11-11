import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Load the real bot entry point with Telegram, HTTP and config replaced, with
// HOME, ZYLOS_DIR, PM2_HOME, TMPDIR and data in a temp dir, and capture what it
// logs from onLaunch while polling is still pending. Its SIGTERM handler is run
// so the bot's own shutdown closes its watcher, intervals and server.
// Covers entry-point startup wiring with mocked transports. Run when startup
// logging or launch wiring changes; unrelated message handling can skip it.
// No network, HTTP listener, tmux or database is used; all files are temporary.
const state = vi.hoisted(() => ({
  dir: '', signals: {}, onLaunch: null, launchPromise: null,
  launchResolved: false, finishLaunch: null, stopped: false,
}));
vi.mock('../src/lib/config.js', () => ({
  loadConfig: () => ({ owner: {}, groups: {} }), saveConfig: vi.fn(() => true),
  getEnv: name => name === 'TELEGRAM_BOT_TOKEN' ? 'fixture-token' : '',
  get DATA_DIR() { return state.dir; },
}));
vi.mock('http', () => ({ default: { createServer: () => ({ on: vi.fn(), listen: vi.fn(), close: vi.fn() }) } }));
vi.mock('telegraf', () => ({ Telegraf: class {
  botInfo = undefined;
  telegram = { callApi: async () => ({}) };
  on() {}
  start() {}
  catch() {}
  launch(config, onLaunch) {
    state.onLaunch = () => {
      this.botInfo = { username: 'fixturebot' };
      onLaunch?.();
    };
    state.launchPromise = new Promise(resolve => { state.finishLaunch = resolve; });
    state.launchPromise.then(() => { state.launchResolved = true; });
    return state.launchPromise;
  }
  stop() { state.stopped = true; state.finishLaunch(); }
} }));

let log, root, prevEnv;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-startup-'));
  prevEnv = Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, process.env[key]]));
  process.env.HOME = path.join(root, 'home');
  process.env.ZYLOS_DIR = path.join(root, 'zylos');
  process.env.PM2_HOME = path.join(root, 'pm2');
  process.env.TMPDIR = path.join(root, 'tmp');
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    fs.mkdirSync(process.env[key], { recursive: true });
  }
  state.dir = path.join(root, 'data');
  fs.mkdirSync(state.dir, { recursive: true });
  vi.useFakeTimers();
  vi.spyOn(process, 'once').mockImplementation((signal, handler) => { state.signals[signal] = handler; return process; });
  log = vi.spyOn(console, 'log');
  await import('../src/bot.js');
});
afterAll(() => {
  if (!state.stopped) state.signals.SIGTERM?.();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('startup log', () => {
  it('reports startup details before polling finishes, without repeating them on stop', async () => {
    const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const details = () => log.mock.calls.map(([line]) => String(line)).filter(line =>
      line.endsWith(' started') || line.startsWith('[telegram] Proxy:') || line.startsWith('[telegram] Bot:'));
    expect(details()).toEqual([]);
    expect(state.launchResolved).toBe(false);

    state.onLaunch();
    await Promise.resolve();
    const expected = [
      `[telegram] zylos-telegram v${version} started`,
      '[telegram] Proxy: none',
      '[telegram] Bot: @fixturebot',
    ];
    expect(details()).toEqual(expected);
    expect(state.launchResolved).toBe(false);

    state.signals.SIGTERM();
    await state.launchPromise;
    expect(state.launchResolved).toBe(true);
    expect(details()).toEqual(expected);
  });
});
